import { useEffect, useId, useRef, useState } from "react";

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
  Textarea,
  VisuallyHidden,
} from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import { sanitizeForDisplay } from "@psilink/core";

import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";

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
  ProbePeerAnswer,
  ProbePeerAnswerShape,
  ProbeSftpHostKeyResult,
} from "@psi/sftpAuthoringClient";
import type {
  SftpConnectionFormValues,
  SftpEndpointLocator,
  SftpFormField,
} from "./sftpConnectionForm";
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
 * credential source.
 *
 * When `reviewLocator` is supplied (the accept side), the host, port, and remote
 * directory are PARTNER-SUPPLIED: they render as a read-only review block, and
 * no invitation field can ever flow into the username, credential, or
 * fingerprint -- the operator's fields start empty regardless.
 */
export function SftpAuthoringForm({
  initial,
  isEdit,
  retainFiles,
  reviewLocator,
  probeCeremony = "exchange",
  onAuthored,
  onCancel,
}: {
  initial: SftpConnectionFormValues;
  /** Editing an existing connection (its credential-free locator is prefilled),
   * as opposed to authoring a fresh one. */
  isEdit: boolean;
  /** The exchange's retain-mode choice as it stands right now ("How files are
   * handled", the card on the same screen). Read only for the split-directory
   * precondition: a separate outbound directory requires retain mode, and the
   * operator can flip that toggle without leaving this form. */
  retainFiles: boolean;
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
  // matching the console's heading-focus discipline. On the accept side the host
  // is read-only, so the username field is first.
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

  const error = sftpFormError(values, retainFiles);
  const fieldError = (field: SftpFormField): string | undefined =>
    attempted && error?.field === field ? error.message : undefined;

  const update = (patch: Partial<SftpConnectionFormValues>): void => {
    setValues((current) => ({ ...current, ...patch }));
    setSubmitError(undefined);
  };

  async function submit(): Promise<void> {
    const body = buildAuthoringRequest(values, retainFiles);
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
          : "The connection could not be saved. Check that the console is reachable, then try again.",
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
        <>
          <TextInput
            label={
              values.outboundDirectory.trim() === ""
                ? "Remote directory"
                : "Inbound directory"
            }
            description={
              values.outboundDirectory.trim() === ""
                ? "Optional. The directory on the server both parties exchange through."
                : "The directory on the server your partner writes to and you read from."
            }
            classNames={{ input: styles.mono }}
            value={values.remoteDirectory}
            error={fieldError("remoteDirectory")}
            errorProps={{ role: "alert" }}
            onChange={(event) =>
              update({ remoteDirectory: event.currentTarget.value })
            }
          />
          <SplitDirectoryField
            value={values.outboundDirectory}
            error={fieldError("outboundDirectory")}
            onChange={(outboundDirectory) => update({ outboundDirectory })}
          />
        </>
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
        keyboardInteractiveError={fieldError("keyboardInteractive")}
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

/**
 * The optional outbound-directory field, behind a disclosure so the ordinary
 * single-directory connection stays a one-field decision. Opening it splits the
 * remote directory into the inbound (peer-written) half above and the outbound
 * (self-written) half here.
 *
 * Closing it CLEARS the value: a collapsed control never holds a directory the
 * operator can no longer see, and this field's blocking errors are only
 * reachable while it is open.
 */
function SplitDirectoryField({
  value,
  error,
  onChange,
}: {
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(value !== "");
  return (
    <div>
      <Button
        variant="subtle"
        size="compact-sm"
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
          if (open) onChange("");
        }}
      >
        {open
          ? "Use one shared directory instead"
          : "Use separate inbound and outbound directories"}
      </Button>
      <Collapse expanded={open}>
        <TextInput
          label="Outbound directory"
          description="The directory on the server you write to and your partner reads from. It must differ from the inbound directory, and it needs retain mode."
          classNames={{ input: styles.mono }}
          value={value}
          error={error}
          errorProps={{ role: "alert" }}
          onChange={(event) => onChange(event.currentTarget.value)}
          mt="xs"
        />
      </Collapse>
    </div>
  );
}

/** The credential sub-section: the method radio (at-most-one primary at the
 * control level), the picked file (or the secrets picker), and the typed `@path`
 * alternative plus each method's companion -- the optional passphrase reference
 * for a private key, the keyboard-interactive toggle for a password. */
function CredentialField({
  values,
  error,
  passphraseError,
  keyboardInteractiveError,
  pickerOpen,
  onPickerOpen,
  onPickerClose,
  onChange,
}: {
  values: SftpConnectionFormValues;
  error: string | undefined;
  passphraseError: string | undefined;
  keyboardInteractiveError: string | undefined;
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
  // (an empty raw value), so an empty Save shows the paste-specific message on
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
  // into the revealed picker. SecretsFilePicker skips focus on its own mount by
  // design, so the open action is what moves focus here.
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
            description="Discouraged. A pasted secret is written to a file on this console to run the exchange. Prefer a file reference above."
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

      {/* Each companion belongs to one sign-in method, but stays on screen while
          it holds a value the operator set under the other one: hiding it would
          make the blocking error point at a control that is not there. */}
      {(values.method === "private_key" || values.passphrasePath !== "") && (
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

      {(values.method === "password" || values.keyboardInteractive) && (
        <Checkbox
          label="Answer the server's login prompts with this password"
          description="Only for a server that refuses the direct password method but asks for it as a prompt. The same password, sent a different way -- it cannot answer a one-time code."
          checked={values.keyboardInteractive}
          // Checkbox takes the error as a node rather than through the
          // `errorProps` the text inputs have, so the live-region role that
          // announces every other blocking error is set on the node itself.
          error={
            keyboardInteractiveError !== undefined ? (
              <span role="alert">{keyboardInteractiveError}</span>
            ) : undefined
          }
          onChange={(event) =>
            onChange({ keyboardInteractive: event.currentTarget.checked })
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
  if (host === "") return { disabledReason: "Enter the server address first." };
  if (!isBareSftpHost(host))
    return {
      disabledReason:
        "Enter just the server address -- not a full URL or login details.",
    };
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
  | ({ phase: "error" } & ProbeErrorCopy);

/**
 * What the probe's polite region says in each phase. Fixed sentences that
 * interpolate nothing, so the announced run is the console's own voice by
 * construction rather than by an escaping argument -- the peer's own bytes and
 * the diagnosis they belong to stay on the visible surfaces below. A phase
 * change has to transit a distinct value: a region set to the text it already
 * holds has not changed, and a repeated outcome would be silent.
 */
const PROBE_ANNOUNCEMENT: Record<ProbeState["phase"], string> = {
  idle: "",
  probing: "Reading the fingerprint from the server...",
  presented:
    "The server presented a fingerprint. Compare it with the value whoever " +
    "runs the server published.",
  error: "Reading the fingerprint failed. You can still paste it above.",
};

/**
 * Whether a settle destroyed the operator's focus anchor, which is the only
 * thing a focus move here repairs -- announcing is the polite region's job. The
 * probe can run for ~15 s, and an operator who moved to another field while it
 * ran must not be yanked back to the result.
 */
function focusAnchorLost(anchor: HTMLElement | null): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || active === anchor;
}

/**
 * The probe-to-fill control BESIDE the fingerprint field: it reads the server's
 * presented host key and offers it for a COMPARISON against the value the server
 * operator published -- never as a trust judgement, and never replacing the
 * paste field. It only ever fills the same field a paste would (through the
 * caller's `onUse`), so no new submit path exists. The Direct ceremony is
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
  // Names the presented panel from its own visible lead line, so the panel that
  // focus lands on has something to say for itself.
  const presentedLabelId = useId();
  const announcement = useDeferredAnnouncement(PROBE_ANNOUNCEMENT[state.phase]);
  // Dismissing the presented result unmounts its focused button, so focus is
  // returned to the probe trigger (mirroring the fill path, which sends focus to
  // the fingerprint field). The flag arms the restoration for the idle render the
  // trigger mounts in; a target change that also resets to idle does not set it.
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreTriggerFocusRef = useRef(false);
  // Bumped on every new probe AND on every target change, so a result that
  // resolves after its target changed (or after a newer probe started) is
  // discarded -- a stale observation must never fill a pin for a different target.
  const seqRef = useRef(0);

  useEffect(() => {
    seqRef.current += 1;
    setState({ phase: "idle" });
    setOutOfBandChecked(false);
  }, [host, port]);

  // Focus repair only: the polite region above is what announces. Probing
  // disables the trigger the operator pressed, so the browser drops focus to
  // <body> for the duration -- a presented result, whose trigger has unmounted,
  // takes focus so a keyboard user can act on it, and every other settle hands
  // focus back to the re-enabled trigger. A dismiss back to idle unmounts its own
  // focused button and takes the same restoration.
  useEffect(() => {
    const restoreTrigger = restoreTriggerFocusRef.current;
    restoreTriggerFocusRef.current = false;
    if (!focusAnchorLost(triggerRef.current)) return;
    if (state.phase === "presented") presentedRef.current?.focus();
    else if (
      state.phase === "error" ||
      (state.phase === "idle" && restoreTrigger)
    )
      triggerRef.current?.focus();
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
        : { phase: "error", ...probeErrorCopy(result) },
    );
  }

  return (
    // The marker names the whole probe result as one region: the accessibility
    // properties this surface has -- the peer's bytes staying out of the
    // announced run and last in the result -- are properties of everything
    // below, so their tests anchor on it and fail by name if it goes.
    <Stack gap={4} data-testid="probe-result">
      {/* The probe's one announcing channel: a stable polite region, mounted in
          every phase and first in the result, so a settle reaches assistive tech
          as an empty -> non-empty transition of a region it is already
          observing. Nothing below it announces. */}
      <VisuallyHidden
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="probe-announcement"
      >
        {announcement}
      </VisuallyHidden>
      {state.phase === "presented" ? (
        <div
          ref={presentedRef}
          tabIndex={-1}
          role="group"
          aria-labelledby={presentedLabelId}
          className={styles.callout}
          style={{ outline: "none" }}
        >
          <Stack gap="xs">
            <div>
              <Text size="sm" fw={500} id={presentedLabelId}>
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
              This console read it over the same connection the exchange will
              use -- it cannot vouch for it.
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
                disabled={ceremony === "direct" && !outOfBandChecked}
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
                onClick={() => {
                  restoreTriggerFocusRef.current = true;
                  setState({ phase: "idle" });
                }}
              >
                Dismiss
              </Button>
            </Group>
          </Stack>
        </div>
      ) : (
        <>
          <div>
            <Button
              ref={triggerRef}
              variant="subtle"
              size="compact-sm"
              loading={state.phase === "probing"}
              disabled={host === undefined || state.phase === "probing"}
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
            <>
              {/* Visible only: Mantine's Alert defaults to role="alert", which
                  would announce this a second time and interrupt, so the prop
                  displaces that default. The presentational role itself does
                  not apply -- ARIA's conflict resolution ignores it on an
                  element holding global aria-* attributes, which Mantine sets
                  here -- leaving a generic element with no live role, which the
                  stable-region test measures. */}
              <Alert
                color="red"
                role="presentation"
                icon={<IconAlertCircle aria-hidden />}
                title="Could not read the fingerprint"
              >
                {state.message} You can still paste the fingerprint above.
              </Alert>
              {state.peerExcerpt !== undefined && (
                <PeerBytesField excerpt={state.peerExcerpt} />
              )}
            </>
          )}
        </>
      )}
    </Stack>
  );
}

/**
 * The peer's own first bytes, rendered OUTSIDE the probe's announcing region and
 * last in the probe result, as a read-only field the console names -- a sibling
 * of the polite status region (never a descendant), named by a fixed label the
 * peer cannot write, and with no first-party text of the result following it.
 *
 * The value is the console's escaped excerpt verbatim: escaping it again would
 * double every backslash the console wrote, and the client boundary that admits
 * it ({@link ../psi/sftpAuthoringClient}) keeps it printable ASCII, so the bytes
 * cannot open a line of their own inside the field.
 */
function PeerBytesField({ excerpt }: { excerpt: string }) {
  return (
    <Textarea
      label="Bytes that answered the port"
      readOnly
      autosize
      value={excerpt}
      classNames={{ input: `${styles.mono} ${styles.peerBytes}` }}
    />
  );
}

/** What the console says about a peer that answered the port with something
 * other than an SSH identification string, one sentence per recognized shape.
 * Worded as what the first bytes were rather than as a verdict on what the peer
 * is: the read is bounded, and a real SSH server whose banner outruns that bound
 * reads the same way (the caveat {@link probePeerAnswerCopy} appends). */
const PROBE_PEER_ANSWER_SHAPE_COPY: Record<ProbePeerAnswerShape, string> = {
  http:
    "Something answered that port with an HTTP response rather than an SSH " +
    "identification string -- most likely a web server, or a proxy or gateway " +
    "intercepting the port.",
  "tls-alert":
    "Something answered that port with a TLS alert record rather than an SSH " +
    "identification string -- most likely a service speaking TLS, or a " +
    "TLS-terminating proxy.",
  unrecognized:
    "Something answered that port with bytes that are not an SSH " +
    "identification string -- most likely something other than an SSH server.",
};

/**
 * The alert's copy for a probe that did not yield a fingerprint: the console's
 * own sentences, and separately the peer's own first bytes when the console
 * diagnosed what answered. `peerExcerpt` is a fragment of its own rather than
 * composed into `message`, because it is rendered outside the alert entirely
 * ({@link PeerBytesField}) -- inside the alert it would read as the console's
 * own guidance, beside the very field it tells the operator to paste into.
 */
interface ProbeErrorCopy {
  message: string;
  peerExcerpt?: string;
}

/**
 * The operator-facing account of what answered the port, for an unreachable
 * probe the console diagnosed: the guided operator is the likeliest to sit
 * behind an intercepting middlebox, and "unreachable" alone would send them to
 * check an address that is right.
 *
 * The excerpt is a fragment the peer chose, arriving bounded and escaped from
 * the console; it is passed through verbatim to {@link PeerBytesField} --
 * escaping it again would double every backslash the console already wrote.
 *
 * @internal exported for the copy test
 */
export function probePeerAnswerCopy(answer: ProbePeerAnswer): ProbeErrorCopy {
  if (answer.kind === "closedUnanswered")
    return {
      message:
        "The server accepted the connection and then closed it without " +
        "identifying itself. An SSH server sends its identification string " +
        "first, so the connection was most likely stopped in front of the " +
        "server -- a firewall or gateway that does not allow this machine's " +
        "address is the usual cause. Ask whoever administers the server " +
        "whether this machine may reach the SFTP port.",
    };
  return {
    message:
      `${PROBE_PEER_ANSWER_SHAPE_COPY[answer.shape]} Check that the address ` +
      "and port name the SFTP service, and that no proxy stands in front of " +
      "them. An SSH server with a long banner, or one that identifies itself " +
      "late, reads this way too. The first bytes it sent are shown below.",
    peerExcerpt: answer.excerpt,
  };
}

/** The operator-facing copy for a probe that did not yield a fingerprint. Each
 * kind names its own cause; paste stays available throughout (the caller appends
 * that reminder). */
function probeErrorCopy(result: ProbeSftpHostKeyResult): ProbeErrorCopy {
  switch (result.kind) {
    case "invalid":
      return { message: result.message };
    case "busy":
      return {
        message:
          "Another read is already running; wait a moment and try again.",
      };
    case "unreachable":
      // A probe the console diagnosed says what answered instead; without one
      // the address really is all there is to check.
      return result.peerAnswer !== undefined
        ? probePeerAnswerCopy(result.peerAnswer)
        : {
            message:
              "Could not reach the server to read its fingerprint. Check the " +
              "address and that the server is reachable.",
          };
    case "timeout":
      return { message: "Reading the fingerprint took too long. Try again." };
    case "disabled":
      return {
        message:
          "Reading the fingerprint from the server is not available here.",
      };
    case "ok":
    case "error":
      return {
        message: "Could not read the fingerprint from the server. Try again.",
      };
  }
}
