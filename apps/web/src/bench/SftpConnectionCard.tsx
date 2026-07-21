import { useEffect, useRef, useState } from "react";

import {
  Alert,
  Badge,
  Button,
  Collapse,
  Divider,
  Group,
  Radio,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import { sanitizeForDisplay } from "@psilink/core";

import { putSftpConnection } from "@psi/sftpAuthoringClient";

import {
  EMPTY_SFTP_FORM,
  applyHostInput,
  buildAuthoringRequest,
  sftpFormError,
} from "./sftpConnectionForm";
import { SecretsFilePicker } from "./SecretsFilePicker";
import { sftpConnectionLabel } from "./sftpConnectionChoice";
import styles from "./bench.module.css";

import type {
  SftpConnectionFormValues,
  SftpFormField,
} from "./sftpConnectionForm";
import type { SftpConnectionProjection } from "@jobs/jobManager";

/**
 * The console's SFTP connection surface under the SFTP transport card: it shows
 * whichever connection is effective and, when the operator may author one, drives
 * `PUT /api/jobs/sftp` from a file-reference credential.
 *
 * Three states:
 * - boot-pinned: a deploy-time `JOB_SFTP_SERVER` -- shown read-only (a `PUT` would
 *   409), no authoring offered.
 * - authored: an in-app connection -- shown with edit/clear affordances and the
 *   honest "Ready to try" label (authored, not yet verified against a real run).
 * - authoring required: no connection yet -- the empty state invites authoring, or
 *   a deliberate switch to save-a-file for the operator's own command-line tool.
 *
 * No credential VALUE ever leaves the browser: the credential is a file the
 * operator picks from the secrets mount (a locator the server resolves) or a typed
 * `@path`. No absolute container path is shown for a picker selection -- only
 * `secrets / <relative subPath>`.
 */
export function SftpConnectionCard({
  connection,
  bootPinned,
  saveFilePreferred,
  onAuthored,
  onCleared,
  onUseCli,
  onRunHere,
}: {
  connection: SftpConnectionProjection | null;
  bootPinned: boolean;
  /** The operator chose to run SFTP through their own command-line tool
   * (save-a-file) instead of authoring a connection here. */
  saveFilePreferred: boolean;
  onAuthored: (connection: SftpConnectionProjection) => void;
  onCleared: () => void;
  /** The operator chose the save-a-file alternative. */
  onUseCli: () => void;
  /** The operator undid the save-a-file choice to set up a connection here. */
  onRunHere: () => void;
}) {
  const [formOpen, setFormOpen] = useState(false);

  if (connection !== null && bootPinned)
    return (
      <p className={`${styles.small} ${styles.sub}`}>
        Runs through{" "}
        <span className={styles.mono}>{sftpConnectionLabel(connection)}</span>,
        provisioned on this appliance. Connection details and credentials stay
        on this machine; the invitation carries only where to meet.
      </p>
    );

  if (connection !== null && !formOpen)
    return (
      <Stack gap="xs" mt="xs">
        <Group gap="xs" align="center">
          <Badge color="teal" variant="light">
            Ready to try
          </Badge>
          <Text size="sm">
            Runs through{" "}
            <span className={styles.mono}>
              {sftpConnectionLabel(connection)}
            </span>
            , set up on this machine.
          </Text>
        </Group>
        <Text size="sm" c="dimmed">
          The connection is not verified until the exchange runs -- psilink
          checks the server's host key and signs in then. Credentials stay on
          this machine; the invitation carries only where to meet.
        </Text>
        <Group gap="sm">
          <Button size="xs" variant="default" onClick={() => setFormOpen(true)}>
            Edit connection
          </Button>
          <Button size="xs" variant="subtle" color="red" onClick={onCleared}>
            Clear connection
          </Button>
        </Group>
      </Stack>
    );

  if (!formOpen && saveFilePreferred)
    return (
      <Stack gap="xs" mt="xs">
        <Text size="sm">
          This exchange will run over SFTP in your own psilink command-line tool
          -- it saves an exchange file to run there.
        </Text>
        <Button
          size="xs"
          variant="subtle"
          style={{ alignSelf: "flex-start" }}
          onClick={() => {
            onRunHere();
            setFormOpen(true);
          }}
        >
          Set up a connection to run it here instead
        </Button>
      </Stack>
    );

  if (!formOpen)
    return (
      <Stack gap="xs" mt="xs">
        <Text size="sm">No SFTP connection set up for this exchange yet.</Text>
        <Group gap="sm">
          <Button size="xs" onClick={() => setFormOpen(true)}>
            Add connection
          </Button>
          <Button size="xs" variant="subtle" onClick={onUseCli}>
            Run it in my own command-line tool instead
          </Button>
        </Group>
      </Stack>
    );

  return (
    <SftpConnectionForm
      initial={initialFormFor(connection)}
      isEdit={connection !== null}
      onAuthored={(authored) => {
        setFormOpen(false);
        onAuthored(authored);
      }}
      onCancel={() => setFormOpen(false)}
    />
  );
}

/** Seed the form from an existing connection's locator (host/port/path); the
 * username and credential are not recoverable from the credential-free projection,
 * so an edit re-enters them. */
function initialFormFor(
  connection: SftpConnectionProjection | null,
): SftpConnectionFormValues {
  if (connection === null) return EMPTY_SFTP_FORM;
  return {
    ...EMPTY_SFTP_FORM,
    host: connection.host,
    port: connection.port !== undefined ? String(connection.port) : "",
    remoteDirectory: connection.path ?? "",
  };
}

/** The authoring form: recognizable fields first (address, username, remote
 * directory), then the prominent required host-key fingerprint, then the credential
 * method and file reference, with the port under Advanced. */
function SftpConnectionForm({
  initial,
  isEdit,
  onAuthored,
  onCancel,
}: {
  initial: SftpConnectionFormValues;
  /** Editing an existing connection (its credential-free locator is prefilled),
   * as opposed to authoring a fresh one. */
  isEdit: boolean;
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
  // first field so a keyboard or screen-reader user lands in the form, matching
  // the bench's heading-focus discipline.
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
      <TextInput
        label="Username"
        description="The account you sign in as on the SFTP server."
        required
        classNames={{ input: styles.mono }}
        value={values.username}
        error={fieldError("username")}
        errorProps={{ role: "alert" }}
        onChange={(event) => update({ username: event.currentTarget.value })}
      />
      <TextInput
        label="Remote directory"
        description="Optional. The directory on the server both parties exchange through."
        classNames={{ input: styles.mono }}
        value={values.remoteDirectory}
        onChange={(event) =>
          update({ remoteDirectory: event.currentTarget.value })
        }
      />
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
          (never uploaded -- only the file's location is used)
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
        error={picked === undefined ? error : undefined}
        errorProps={{ role: "alert" }}
        onChange={(event) => {
          const ref = event.currentTarget.value;
          onChange({ source: ref === "" ? undefined : { kind: "path", ref } });
        }}
      />

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
