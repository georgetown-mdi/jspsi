import { useEffect, useRef, useState } from "react";

import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Divider,
  Group,
  PasswordInput,
  Radio,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import { sanitizeForDisplay } from "@psilink/core";

import { probeSftpHostKey, putSftpConnection } from "@psi/sftpAuthoringClient";
import { isBareSftpHost } from "@psi/sftpHost";

import {
  applyHostInput,
  buildAuthoringRequest,
  sftpFormError,
} from "./sftpConnectionForm";
import { SecretsFilePicker } from "./SecretsFilePicker";
import styles from "./bench.module.css";

import type {
  SftpConnectionFormValues,
  SftpEndpointLocator,
  SftpFormField,
} from "./sftpConnectionForm";
import type { ProbeSftpHostKeyResult } from "@psi/sftpAuthoringClient";
import type { SftpConnectionProjection } from "@jobs/jobManager";

/**
 * Which host-key confirmation ceremony the probe presents. Both paths pin the
 * fingerprint identically; only the warning weight differs. `direct` (the
 * direct-exchange path, where the host key is the ONLY protection) gets an
 * alert-weight interstitial and an explicit out-of-band-checked affirmation gating
 * fill; `exchange` (invitation and accept) gets the lighter comparison question
 * plus the reconciliation note.
 */
export type ProbeCeremony = "exchange" | "direct";

/**
 * The console's SFTP connection authoring form, shared by both the invite side
 * ({@link SftpConnectionCard}) and the accept side
 * ({@link AcceptorSftpConnectionCard}). It drives `PUT /api/jobs/sftp` from a
 * credential source: recognizable fields first (address, username, remote
 * directory), then the prominent required host-key fingerprint, then the
 * credential method and file reference, with the port under Advanced.
 *
 * When `reviewLocator` is supplied (the accept side), the host, port, and remote
 * directory are PARTNER-SUPPLIED: the partner named them in the invitation
 * endpoint, so they render as a read-only review block and the operator authors
 * only the username, host-key fingerprint, and credential. The submitted request
 * still carries those locator fields (from the seeded values), but no invitation
 * field can ever flow into the username, credential, or fingerprint -- the review
 * block is display-only and the operator's fields start empty.
 */
export function SftpAuthoringForm({
  initial,
  isEdit,
  reviewLocator,
  probeCeremony = "exchange",
  onAuthored,
  onCancel,
}: {
  initial: SftpConnectionFormValues;
  /** Editing an existing connection (its credential-free locator is prefilled),
   * as opposed to authoring a fresh one. */
  isEdit: boolean;
  /** The partner-supplied locator (accept side): when present, host/port/path are
   * shown read-only and the operator authors only username, fingerprint, and
   * credential. Undefined on the invite side, where every field is editable. */
  reviewLocator?: SftpEndpointLocator;
  /** The host-key confirmation ceremony the probe presents (default `exchange`). */
  probeCeremony?: ProbeCeremony;
  onAuthored: (connection: SftpConnectionProjection) => void;
  onCancel: () => void;
}) {
  const [values, setValues] = useState<SftpConnectionFormValues>(initial);
  const [attempted, setAttempted] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(initial.port !== "");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string>();

  // Revealing the form leaves keyboard focus on document.body; send it to the
  // first editable field so a keyboard or screen-reader user lands in the form,
  // matching the bench's heading-focus discipline. On the accept side the host is
  // read-only, so the username field is first.
  const firstFieldRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    firstFieldRef.current?.focus();
  }, []);

  // Focus returns here after a probed fingerprint fills the field, so a keyboard
  // or screen-reader user lands back on the pin they just set.
  const fingerprintRef = useRef<HTMLInputElement>(null);

  // Where the probe reads from: the partner-named locator on the accept side (so
  // the probe is enabled immediately), otherwise the operator's own host/port
  // fields once they are a bare host and a valid port. A stale target must never
  // fill a pin, so the probe clears a presented result when this changes.
  const probeTarget = probeTargetOf(values, reviewLocator);

  const error = sftpFormError(values);
  const fieldError = (field: SftpFormField): string | undefined =>
    attempted && error?.field === field ? error.message : undefined;

  const update = (patch: Partial<SftpConnectionFormValues>): void => {
    setValues((current) => ({ ...current, ...patch }));
    setSubmitError(undefined);
  };

  async function submit(): Promise<void> {
    const body = buildAuthoringRequest(values);
    if (body === undefined) {
      setAttempted(true);
      // The port lives under a collapsed Advanced section; open it so a blocking
      // port error is visible rather than silently no-opping Save.
      if (error?.field === "port") setAdvancedOpen(true);
      return;
    }
    setSubmitting(true);
    setSubmitError(undefined);
    const result = await putSftpConnection(body);
    setSubmitting(false);
    if (result.kind === "ok") {
      onAuthored(result.connection);
      return;
    }
    setAttempted(true);
    setSubmitError(
      result.kind === "invalid"
        ? result.message
        : result.kind === "tooLarge"
          ? "The connection details are too large."
          : "The connection could not be saved. Check that the appliance is reachable, then try again.",
    );
  }

  return (
    <Stack gap="sm" mt="xs">
      {isEdit && (
        <Text size="sm" c="dimmed">
          Re-enter the username, fingerprint, and credential -- they are never
          stored in the browser.
        </Text>
      )}
      {reviewLocator !== undefined ? (
        <PartnerLocatorReview locator={reviewLocator} />
      ) : (
        <TextInput
          ref={firstFieldRef}
          label="SFTP server address"
          description="The host you connect to. You can paste an sftp://user@host/path address and it will be split for you."
          required
          classNames={{ input: styles.mono }}
          value={values.host}
          error={fieldError("host")}
          errorProps={{ role: "alert" }}
          onChange={(event) =>
            setValues((current) =>
              applyHostInput(current, event.currentTarget.value),
            )
          }
        />
      )}
      <TextInput
        ref={reviewLocator !== undefined ? firstFieldRef : undefined}
        label="Username"
        description="The account you sign in as on the SFTP server."
        required
        classNames={{ input: styles.mono }}
        value={values.username}
        error={fieldError("username")}
        errorProps={{ role: "alert" }}
        onChange={(event) => update({ username: event.currentTarget.value })}
      />
      {reviewLocator === undefined && (
        <TextInput
          label="Remote directory"
          description="Optional. The directory on the server both parties exchange through."
          classNames={{ input: styles.mono }}
          value={values.remoteDirectory}
          onChange={(event) =>
            update({ remoteDirectory: event.currentTarget.value })
          }
        />
      )}
      <TextInput
        ref={fingerprintRef}
        label="Server identity fingerprint"
        description="The server's identity fingerprint -- ask whoever runs the SFTP server. It starts with SHA256:."
        required
        classNames={{ input: styles.mono }}
        value={values.hostKeyFingerprint}
        error={fieldError("hostKeyFingerprint")}
        errorProps={{ role: "alert" }}
        onChange={(event) =>
          update({ hostKeyFingerprint: event.currentTarget.value })
        }
      />

      <HostKeyProbe
        host={probeTarget.host}
        port={probeTarget.port}
        disabledReason={probeTarget.disabledReason}
        ceremony={probeCeremony}
        onUse={(fingerprint) => {
          update({ hostKeyFingerprint: fingerprint });
          fingerprintRef.current?.focus();
        }}
      />

      <CredentialField
        values={values}
        error={fieldError("credential")}
        passphraseError={fieldError("passphrase")}
        pickerOpen={pickerOpen}
        onPickerOpen={() => setPickerOpen(true)}
        onPickerClose={() => setPickerOpen(false)}
        onChange={update}
      />

      {reviewLocator === undefined && (
        <div>
          <Button
            variant="subtle"
            size="compact-sm"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-expanded={advancedOpen}
          >
            {advancedOpen ? "Hide advanced" : "Advanced"}
          </Button>
          <Collapse expanded={advancedOpen}>
            <TextInput
              label="Port"
              description="Optional. Defaults to 22."
              classNames={{ input: styles.mono }}
              value={values.port}
              error={fieldError("port")}
              errorProps={{ role: "alert" }}
              onChange={(event) => update({ port: event.currentTarget.value })}
              mt="xs"
            />
          </Collapse>
        </div>
      )}

      {submitError !== undefined && (
        <Alert
          color="red"
          icon={<IconAlertCircle aria-hidden />}
          title="Could not save the connection"
        >
          {submitError}
        </Alert>
      )}

      <Group gap="sm">
        <Button loading={submitting} onClick={() => void submit()}>
          Save connection
        </Button>
        <Button variant="default" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </Group>
    </Stack>
  );
}

/** The partner-supplied locator, shown read-only on the accept side so the
 * operator confirms WHERE the exchange connects without being able to retype it
 * into a credential or fingerprint. Every partner-controlled part is sanitized for
 * display, like every other partner-string surface in the accept flow. */
function PartnerLocatorReview({ locator }: { locator: SftpEndpointLocator }) {
  const port = locator.port !== undefined ? `:${locator.port}` : "";
  const address = sanitizeForDisplay(`${locator.host}${port}`);
  return (
    <Alert
      color="blue"
      icon={<IconAlertCircle aria-hidden />}
      title="Your partner's SFTP server"
    >
      <Text size="sm" c="dimmed">
        Your partner named this server in the invitation. Confirm it is where
        you expect to connect; sign in with your own account below.
      </Text>
      <Text size="sm" mt={4}>
        Address: <span className={styles.mono}>{address}</span>
      </Text>
      {locator.path !== undefined && (
        <Text size="sm">
          Remote directory:{" "}
          <span className={styles.mono}>
            {sanitizeForDisplay(locator.path)}
          </span>
        </Text>
      )}
    </Alert>
  );
}

/** The credential sub-section: the method radio (at-most-one primary at the
 * control level), the picked file (or the secrets picker), and the typed `@path`
 * escape hatch plus the optional passphrase reference. */
function CredentialField({
  values,
  error,
  passphraseError,
  pickerOpen,
  onPickerOpen,
  onPickerClose,
  onChange,
}: {
  values: SftpConnectionFormValues;
  error: string | undefined;
  passphraseError: string | undefined;
  pickerOpen: boolean;
  onPickerOpen: () => void;
  onPickerClose: () => void;
  onChange: (patch: Partial<SftpConnectionFormValues>) => void;
}) {
  const source = values.source;
  const typedRef = source?.kind === "path" ? source.ref : "";
  const picked = source?.kind === "mount" ? source.subPath : undefined;
  const pastedValue = source?.kind === "raw" ? source.value : "";
  // Paste is the active credential source once it holds a raw value (including an
  // opened-but-empty one): the blocking credential error then renders on the paste
  // field, and the file-reference field owns the error only when it is active.
  const pasteActive = source?.kind === "raw";

  // The paste fallback stays collapsed unless the operator is already using it, so
  // the file-reference path is visually primary. Password auth discloses the
  // password in full to a redirected host, so references stay encouraged.
  const [pasteOpen, setPasteOpen] = useState(source?.kind === "raw");

  // Opening the paste fallback with nothing else chosen makes it the active source
  // (an empty raw value), so an empty Save surfaces the paste-specific message on
  // the paste field. Collapsing an empty paste clears it, so a hidden control never
  // holds an armed value or a stranded error.
  const togglePaste = (): void => {
    const opening = !pasteOpen;
    setPasteOpen(opening);
    if (opening) {
      if (source === undefined)
        onChange({ source: { kind: "raw", value: "" } });
    } else if (source?.kind === "raw" && source.value === "") {
      onChange({ source: undefined });
    }
  };

  // Opening the picker leaves focus on the trigger, which then unmounts; move it
  // into the revealed picker. SecretsFilePicker deliberately skips focus on its
  // own mount, so the open action is what moves focus here.
  const pickerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (pickerOpen) pickerRef.current?.focus();
  }, [pickerOpen]);

  return (
    <Stack gap="xs">
      <Radio.Group
        label="How psilink signs in"
        value={values.method}
        onChange={(value) =>
          onChange({
            method: value === "private_key" ? "private_key" : "password",
          })
        }
      >
        <Group gap="lg" mt={4}>
          <Radio value="password" label="Password" />
          <Radio value="private_key" label="Private key" />
        </Group>
      </Radio.Group>

      <Text size="sm" fw={500}>
        Credential file{" "}
        <Text span size="sm" c="dimmed" fw={400}>
          (a file reference -- only its location is used, the file itself is
          never uploaded)
        </Text>
      </Text>

      {picked !== undefined && (
        <Group gap="xs" align="center">
          <Text size="sm">Selected:</Text>
          <span className={styles.mono}>
            secrets /{" "}
            {picked.map((segment) => sanitizeForDisplay(segment)).join(" / ")}
          </span>
          <Button
            size="compact-xs"
            variant="subtle"
            color="red"
            onClick={() => onChange({ source: undefined })}
          >
            Clear
          </Button>
        </Group>
      )}

      {pickerOpen ? (
        <div ref={pickerRef} tabIndex={-1} style={{ outline: "none" }}>
          <Stack gap="xs">
            <SecretsFilePicker
              onSelect={(subPath) => {
                onChange({ source: { kind: "mount", subPath } });
                onPickerClose();
              }}
            />
            <Button
              size="xs"
              variant="default"
              style={{ alignSelf: "flex-start" }}
              onClick={onPickerClose}
            >
              Cancel browsing
            </Button>
          </Stack>
        </div>
      ) : (
        <Button
          size="xs"
          variant="light"
          style={{ alignSelf: "flex-start" }}
          onClick={onPickerOpen}
        >
          {picked !== undefined
            ? "Choose a different file"
            : "Choose a file from the secrets mount"}
        </Button>
      )}

      <Divider label="or" labelPosition="center" />

      <TextInput
        label="File reference"
        description="Type an @-file reference to a credential file's absolute path, e.g. @/run/secrets/key. A file in a separate read-only secrets mount is more isolated, but a file in your mounted folder works too."
        classNames={{ input: styles.mono }}
        value={typedRef}
        error={picked === undefined && !pasteActive ? error : undefined}
        errorProps={{ role: "alert" }}
        onChange={(event) => {
          const ref = event.currentTarget.value;
          onChange({ source: ref === "" ? undefined : { kind: "path", ref } });
        }}
      />

      <div>
        <Group gap="xs" align="center">
          <Button
            variant="subtle"
            size="compact-sm"
            onClick={togglePaste}
            aria-expanded={pasteOpen}
          >
            {pasteOpen
              ? "Hide paste-the-value fallback"
              : pastedValue !== ""
                ? "Edit the pasted value"
                : "Or paste the value instead"}
          </Button>
          {!pasteOpen && pastedValue !== "" && (
            <>
              <Text size="sm" c="dimmed">
                A pasted value is set.
              </Text>
              <Button
                size="compact-xs"
                variant="subtle"
                color="red"
                onClick={() => onChange({ source: undefined })}
              >
                Clear
              </Button>
            </>
          )}
        </Group>
        <Collapse expanded={pasteOpen}>
          <PasswordInput
            label="Paste value"
            description="Discouraged. A pasted secret is written to a file on this appliance to run the exchange. Prefer a file reference above."
            classNames={{ input: styles.mono }}
            autoComplete="new-password"
            value={pastedValue}
            error={pasteActive ? error : undefined}
            errorProps={{ role: "alert" }}
            onChange={(event) =>
              onChange({
                source: { kind: "raw", value: event.currentTarget.value },
              })
            }
            mt="xs"
          />
        </Collapse>
      </div>

      {values.method === "private_key" && (
        <TextInput
          label="Key passphrase reference"
          description="Optional. If your private key is encrypted, type an @-file reference to the passphrase file."
          classNames={{ input: styles.mono }}
          value={values.passphrasePath}
          error={passphraseError}
          errorProps={{ role: "alert" }}
          onChange={(event) =>
            onChange({ passphrasePath: event.currentTarget.value })
          }
        />
      )}
    </Stack>
  );
}

/**
 * Where the host-key probe reads from, and whether it is ready. On the accept side
 * the partner-named locator is used verbatim (always ready). On the invite/direct
 * side the operator's own fields are used, enabled only once the host is a bare
 * address and the port (if any) parses -- with a reason otherwise, so the operator
 * knows what to fill first.
 */
function probeTargetOf(
  values: SftpConnectionFormValues,
  reviewLocator: SftpEndpointLocator | undefined,
): { host?: string; port?: number; disabledReason?: string } {
  if (reviewLocator !== undefined)
    return reviewLocator.port !== undefined
      ? { host: reviewLocator.host, port: reviewLocator.port }
      : { host: reviewLocator.host };
  const host = values.host.trim();
  if (host === "" || !isBareSftpHost(host))
    return { disabledReason: "Enter the server address first." };
  const portText = values.port.trim();
  if (portText === "") return { host };
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    return { disabledReason: "Enter a valid port first." };
  return { host, port };
}

type ProbeState =
  | { phase: "idle" }
  | { phase: "probing" }
  | { phase: "presented"; fingerprint: string; keyType: string }
  | { phase: "error"; message: string };

/**
 * The probe-to-fill control BESIDE the fingerprint field: it reads the server's
 * presented host key and offers it for a COMPARISON against the value the server
 * operator published -- never as a trust judgement, and never replacing the paste
 * field. It only ever fills the same field a paste would (through the caller's
 * `onUse`), so no new submit path exists. The confirm is framed as matching, and
 * the copy states the console observed the value over the same untrusted network
 * the exchange will use, so it cannot vouch for it. The Direct ceremony is
 * heavier: an alert-weight interstitial and an out-of-band-checked affirmation
 * gate the fill.
 */
function HostKeyProbe({
  host,
  port,
  disabledReason,
  ceremony,
  onUse,
}: {
  /** The bare host to probe, or undefined when the target is not yet ready. */
  host: string | undefined;
  port: number | undefined;
  /** Why the probe is disabled (shown when `host` is undefined). */
  disabledReason: string | undefined;
  ceremony: ProbeCeremony;
  onUse: (fingerprint: string) => void;
}) {
  const [state, setState] = useState<ProbeState>({ phase: "idle" });
  const [outOfBandChecked, setOutOfBandChecked] = useState(false);
  const presentedRef = useRef<HTMLDivElement>(null);
  // Bumped on every new probe AND on every target change, so a result that
  // resolves after its target changed (or after a newer probe started) is
  // discarded -- a stale observation must never fill a pin for a different target.
  const seqRef = useRef(0);

  useEffect(() => {
    seqRef.current += 1;
    setState({ phase: "idle" });
    setOutOfBandChecked(false);
  }, [host, port]);

  // Move focus to the presented result when it arrives so a keyboard user can act
  // on it immediately; aria-live announces it for a screen reader.
  useEffect(() => {
    if (state.phase === "presented") presentedRef.current?.focus();
  }, [state.phase]);

  async function runProbe(): Promise<void> {
    if (host === undefined) return;
    const seq = (seqRef.current += 1);
    setOutOfBandChecked(false);
    setState({ phase: "probing" });
    const result = await probeSftpHostKey(host, port);
    // Discard a superseded result (the target changed, or a newer probe started).
    if (seqRef.current !== seq) return;
    setState(
      result.kind === "ok"
        ? {
            phase: "presented",
            fingerprint: result.fingerprint,
            keyType: result.keyType,
          }
        : { phase: "error", message: probeErrorMessage(result) },
    );
  }

  if (state.phase === "presented") {
    const useDisabled = ceremony === "direct" && !outOfBandChecked;
    return (
      <div
        ref={presentedRef}
        tabIndex={-1}
        aria-live="polite"
        className={styles.callout}
        style={{ outline: "none" }}
      >
        <Stack gap="xs">
          <div>
            <Text size="sm" fw={500}>
              The server presented this fingerprint:
            </Text>
            <Text size="sm" className={styles.mono}>
              {state.fingerprint}
            </Text>
            <Text size="sm" c="dimmed">
              Key type: {sanitizeForDisplay(state.keyType)}
            </Text>
          </div>
          <Text size="sm">
            Does this match the fingerprint whoever runs the server published?
            This console read it over the same connection the exchange will use
            -- it cannot vouch for it.
          </Text>
          {ceremony === "direct" ? (
            <>
              <Alert
                color="orange"
                icon={<IconAlertCircle aria-hidden />}
                title="This host key is the only thing protecting your records"
              >
                On this path the server&apos;s host key is the only thing
                protecting your records -- there is no shared secret and no
                separate encryption. Verify this fingerprint against a value
                published somewhere other than this connection.
              </Alert>
              <Checkbox
                checked={outOfBandChecked}
                onChange={(event) =>
                  setOutOfBandChecked(event.currentTarget.checked)
                }
                label="I checked this fingerprint against a source other than this connection"
              />
            </>
          ) : (
            <Text size="xs" c="dimmed">
              When the exchange runs, both parties&apos; consoles also compare
              the fingerprint each observed and warn on a mismatch.
            </Text>
          )}
          <Group gap="sm">
            <Button
              size="xs"
              disabled={useDisabled}
              onClick={() => {
                onUse(state.fingerprint);
                setState({ phase: "idle" });
                setOutOfBandChecked(false);
              }}
            >
              Use this fingerprint
            </Button>
            <Button
              size="xs"
              variant="default"
              onClick={() => setState({ phase: "idle" })}
            >
              Dismiss
            </Button>
          </Group>
        </Stack>
      </div>
    );
  }

  return (
    <Stack gap={4}>
      <div>
        <Button
          variant="subtle"
          size="compact-sm"
          loading={state.phase === "probing"}
          disabled={host === undefined || state.phase === "probing"}
          aria-expanded={state.phase !== "idle"}
          onClick={() => void runProbe()}
        >
          Read the fingerprint from the server
        </Button>
        {host === undefined &&
          disabledReason !== undefined &&
          state.phase === "idle" && (
            <Text size="xs" c="dimmed">
              {disabledReason}
            </Text>
          )}
      </div>
      {state.phase === "error" && (
        <Alert
          color="red"
          role="alert"
          icon={<IconAlertCircle aria-hidden />}
          title="Could not read the fingerprint"
        >
          {state.message} You can still paste it above.
        </Alert>
      )}
    </Stack>
  );
}

/** The operator-facing message for a probe that did not yield a fingerprint. Each
 * kind names its own cause; paste stays available throughout (the caller appends
 * that reminder). */
function probeErrorMessage(result: ProbeSftpHostKeyResult): string {
  switch (result.kind) {
    case "invalid":
      return result.message;
    case "busy":
      return "Another read is already running; wait a moment and try again.";
    case "unreachable":
      return (
        "Could not reach the server to read its fingerprint. Check the " +
        "address and that the server is reachable."
      );
    case "timeout":
      return "Reading the fingerprint took too long. Try again.";
    case "disabled":
      return "Reading the fingerprint from the server is not available here.";
    case "ok":
    case "error":
      return "Could not read the fingerprint from the server. Try again.";
  }
}
