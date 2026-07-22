import { useEffect, useRef, useState } from "react";

import {
  Alert,
  Button,
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

import { putSftpConnection } from "@psi/sftpAuthoringClient";

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
import type { SftpConnectionProjection } from "@jobs/jobManager";

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
        : result.kind === "conflict"
          ? "A connection is already provisioned on this appliance, so it cannot be changed here."
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
    <div>
      <Text size="sm" fw={500}>
        Your partner&apos;s SFTP server
      </Text>
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
    </div>
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
        description="For a credential outside the secrets mount, type an @-file reference to its absolute path, e.g. @/run/secrets/key."
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
