import { Alert, Button, TextInput } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import {
  RUN_COMMAND,
  credentialAlertCopy,
  saveCapabilityCopy,
  saveClosingCopy,
  saveExchangeError,
  saveLeadCopy,
} from "./saveExchangeModel";
import { CopyRow } from "./BenchRunSurface";
import { dateTimeLabel } from "./inviterModel";
import styles from "./bench.module.css";

import type { CliTransport, SaveExchangeFields } from "./saveExchangeModel";
import type { GeneratedInvitation } from "@psi/invitation";
import type { IntakeAlert } from "./YourFileSection";

/** The saved artifacts a CLI transport produces together: the minted invitation
 * (whose code the copy row shows and whose creation dates the file) and the
 * download filename. Held as one object so a re-save replaces both atomically --
 * an old code can never linger beside a new file. */
export interface SavedExchange {
  invitation: GeneratedInvitation;
  fileName: string;
}

/**
 * The save-exchange-file surface a command-line transport routes Create to
 * (mockup screen `bench-sftp`, extrapolated for shared-directory). The operator
 * authors the locator, presses Save, and the handler mints the invitation code
 * and the CLI config YAML together and triggers the download. Before a save the
 * surface shows the fields and the Save button; after one it adds the file card,
 * the invitation-code copy row, the expiry, and the operator instructions. The
 * linkage terms are sealed exactly as the browser path seals them; only the
 * transport differs, so this surface authors WHERE the exchange runs and nothing
 * about WHAT is disclosed.
 */
export function SaveExchangeSection({
  transport,
  fields,
  saved,
  saving,
  alert,
  onFields,
  onSave,
  onBack,
}: {
  transport: CliTransport;
  fields: SaveExchangeFields;
  saved: SavedExchange | undefined;
  saving: boolean;
  alert: IntakeAlert | undefined;
  onFields: (fields: SaveExchangeFields) => void;
  onSave: () => void;
  onBack: () => void;
}) {
  const error = saveExchangeError(transport, fields);
  return (
    <>
      <button type="button" className={styles.backlink} onClick={onBack}>
        {"←"} Back to Review &amp; create
      </button>
      <h1 tabIndex={-1}>Save your exchange file</h1>
      <p>{saveLeadCopy(transport)}</p>

      {transport === "sftp" ? (
        <>
          <TextInput
            label="SFTP server host"
            required
            classNames={{ input: styles.mono }}
            value={fields.host}
            error={error?.field === "host" ? error.message : undefined}
            errorProps={{ role: "alert" }}
            onChange={(event) =>
              onFields({ ...fields, host: event.currentTarget.value })
            }
            mt="md"
          />
          <TextInput
            label="Remote directory"
            classNames={{ input: styles.mono }}
            value={fields.remoteDirectory}
            onChange={(event) =>
              onFields({
                ...fields,
                remoteDirectory: event.currentTarget.value,
              })
            }
            mt="md"
          />
        </>
      ) : (
        <TextInput
          label="Shared directory"
          required
          classNames={{ input: styles.mono }}
          value={fields.sharedDirectory}
          error={error?.field === "sharedDirectory" ? error.message : undefined}
          errorProps={{ role: "alert" }}
          onChange={(event) =>
            onFields({ ...fields, sharedDirectory: event.currentTarget.value })
          }
          mt="md"
        />
      )}

      <Alert variant="light" color="blue" mt="md">
        {credentialAlertCopy(transport)}
      </Alert>

      <p className={`${styles.small} ${styles.sub}`}>
        {saveCapabilityCopy(transport)}
      </p>

      {saved !== undefined && (
        <CopyRow
          label="Invitation code"
          hint="Your partner accepts with this same code, whichever transport they run"
          value={saved.invitation.encoded}
        />
      )}

      <div className={styles.workFoot}>
        <Button
          onClick={onSave}
          loading={saving}
          disabled={error !== undefined}
        >
          Save exchange file
        </Button>
      </div>

      {alert !== undefined && (
        <Alert
          color="red"
          title={alert.title}
          icon={<IconAlertCircle aria-hidden />}
          mt="md"
        >
          <span style={{ whiteSpace: "pre-line" }}>{alert.message}</span>
        </Alert>
      )}

      {saved !== undefined && (
        <>
          <div className={styles.fileCard}>
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              aria-hidden="true"
            >
              <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" />
              <path d="M13 3v6h6" />
            </svg>
            <div>
              <div className={`${styles.fileName} ${styles.mono}`}>
                {saved.fileName}
              </div>
              <div className={styles.fileMeta}>Saved to your downloads</div>
            </div>
          </div>

          <p className={styles.small}>
            <strong>
              This invitation expires{" "}
              <span className={styles.mono}>
                {dateTimeLabel(new Date(saved.invitation.expires))}
              </span>
              .
            </strong>
          </p>

          <p className={styles.small}>{saveClosingCopy(fields, transport)}</p>
          <p className={styles.small}>
            Run it with this one command. Saving the invitation code to a file
            (here <span className={styles.mono}>invitation-code.txt</span>)
            keeps it out of your shell history.
          </p>
          <div className={`${styles.codeBlock} ${styles.mono}`}>
            {RUN_COMMAND}
          </div>
        </>
      )}
    </>
  );
}
