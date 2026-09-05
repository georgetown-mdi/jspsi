import { useMemo } from "react";

import {
  Alert,
  Button,
  NativeSelect,
  Radio,
  VisuallyHidden,
} from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";

import {
  buildAdvancedTerms,
  importedCitationDropNotice,
  inertCoalesceNotice,
} from "@psi/advancedInvite";

import { isConsoleBuild } from "@utils/clientConfig";
import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";
import { useOnlineStatus } from "@components/useOnlineStatus";

import {
  LIFETIME_CHOICES,
  RESULTS_DIRECTION_LABELS,
  answersRows,
  availableTransports,
  expiryLabel,
  inviterCreateStatus,
  transportChooserCopy,
  transportRunMode,
} from "@psi/inviterModel";
import { receiptsProblems } from "@psi/receiptsModel";
import { runDiagnosticsProblems } from "@psi/runDiagnosticsModel";

import {
  CONFIG_EXCHANGE_FILES,
  exchangeFilesProblems,
} from "@console/exchangeFilesModel";
import {
  FILEDROP_CONNECTION_TUNING,
  SFTP_CONNECTION_TUNING,
  connectionTuningProblems,
} from "@console/connectionTuningModel";
import { ConnectionTuningCard } from "@console/ConnectionTuningCard";
import { ExchangeFilesCard } from "@console/ExchangeFilesCard";
import { ReceiptsCard } from "@console/ReceiptsCard";
import { RunDiagnosticsCard } from "@console/RunDiagnosticsCard";
import { SftpConnectionCard } from "@console/SftpConnectionCard";
import { splitDirectoryRetainProblem } from "@console/sftpConnectionChoice";
import { splitRendezvousRetainProblem } from "@console/filedropRendezvousChoice";
import styles from "@styles/app.module.css";

import { CitationDropNotice } from "./CitationDropNotice";

import type {
  AcquiredCsv,
  InviterEditor,
  SpineProblem,
  SpineTarget,
  Transport,
} from "@psi/inviterModel";
import type { ConnectionTuningDraft } from "@console/connectionTuningModel";
import type { ExchangeFilesDraft } from "@console/exchangeFilesModel";
import type { JobRendezvousConfig } from "@psi/workInputClient";
import type { OutputDirection } from "@psi/advancedInvite";
import type { ReceiptsDraft } from "@psi/receiptsModel";
import type { RunDiagnosticsDraft } from "@psi/runDiagnosticsModel";
import type { SftpConnectionProjection } from "@jobs/jobManager";

const DIRECTION_CHOICES: ReadonlyArray<{
  value: OutputDirection;
  label: string;
}> = [
  { value: "both", label: RESULTS_DIRECTION_LABELS.both },
  { value: "inviter", label: RESULTS_DIRECTION_LABELS.inviter },
  { value: "partner", label: RESULTS_DIRECTION_LABELS.partner },
];

/**
 * Step 3 of the inviter spine: the review-time decisions (lifetime, result
 * direction, transport), the check-your-answers restatement of the whole
 * proposal, the dropped-citation notice where an imported document's citation
 * will not be included, and the create action -- the point of no return whose copy
 * says so. The transport chooser offers the live-browser exchange and the two
 * command-line transports (SFTP and a shared directory); its copy comes from
 * {@link transportChooserCopy}, which reflects whether the deployment runs a
 * shared-directory or SFTP exchange here (the console) or saves an
 * exchange file for the command-line tool. On a console build, choosing SFTP
 * shows the authored connection's locator under the card: the exchange runs here
 * through that connection, and the connection material stays on the console.
 */
export function ReviewCreateSection({
  editor,
  csv,
  problems,
  minting,
  sftpConnection,
  sftpSaveFilePreferred,
  rendezvous,
  exchangeFiles,
  exchangeFilesOpen,
  onExchangeFiles,
  onExchangeFilesOpen,
  connectionTuning,
  connectionTuningOpen,
  onConnectionTuning,
  onConnectionTuningOpen,
  runDiagnostics,
  runDiagnosticsOpen,
  onRunDiagnostics,
  onRunDiagnosticsOpen,
  receipts,
  receiptsOpen,
  onReceipts,
  onReceiptsOpen,
  onLifetime,
  onDirection,
  onTransport,
  onAuthorConnection,
  onClearConnection,
  onUseCliForSftp,
  onRunHereForSftp,
  onReset,
  onCreate,
  onNavigate,
}: {
  editor: InviterEditor;
  csv: AcquiredCsv;
  problems: ReadonlyArray<SpineProblem>;
  minting: boolean;
  /** The effective SFTP connection locator, fetched once on a console build (and
   * updated when the operator authors or clears one); undefined before the fetch
   * resolves (or off a console), null when none is effective. */
  sftpConnection: SftpConnectionProjection | null | undefined;
  /** Whether the operator chose to run SFTP through their own
   * command-line tool (save-a-file) instead of authoring a connection here. */
  sftpSaveFilePreferred: boolean;
  /** The console's rendezvous provisioning, or undefined before it resolves (or
   * off a console). The filedrop card runs here when it reports a mount and renders
   * disabled with the console's own reason when it does not; a split pair also
   * brings the retain-mode precondition into this step's create gate. Off a console
   * build it is unused (filedrop saves a file). */
  rendezvous: JobRendezvousConfig | undefined;
  /** The operator's file-handling choices for a run the console conducts. Only
   * the console's file-sync transports have them, so the card renders there. */
  exchangeFiles: ExchangeFilesDraft;
  /** Whether the file-handling disclosure is expanded (held by the host so a
   * re-render of this step does not collapse it). */
  exchangeFilesOpen: boolean;
  onExchangeFiles: (draft: ExchangeFilesDraft) => void;
  onExchangeFilesOpen: (open: boolean) => void;
  /** The operator's connection-tuning choices for the same run, offered on the
   * same transports as the file-handling card. */
  connectionTuning: ConnectionTuningDraft;
  /** Whether the connection-tuning disclosure is expanded (held by the host for
   * the same reason as the file-handling one). */
  connectionTuningOpen: boolean;
  onConnectionTuning: (draft: ConnectionTuningDraft) => void;
  onConnectionTuningOpen: (open: boolean) => void;
  /** The operator's per-run diagnostic and recovery choices for the same run,
   * offered on the same transports the two cards above are. */
  runDiagnostics: RunDiagnosticsDraft;
  /** Whether the diagnostics disclosure is expanded (held by the host for the
   * same reason as the two above). */
  runDiagnosticsOpen: boolean;
  onRunDiagnostics: (draft: RunDiagnosticsDraft) => void;
  onRunDiagnosticsOpen: (open: boolean) => void;
  /** The operator's receipt-signing and retention choices for the same run,
   * offered on the same transports the three cards above are. */
  receipts: ReceiptsDraft;
  /** Whether the receipts disclosure is expanded (held by the host for the same
   * reason as the three above). */
  receiptsOpen: boolean;
  onReceipts: (draft: ReceiptsDraft) => void;
  onReceiptsOpen: (open: boolean) => void;
  onLifetime: (seconds: number) => void;
  onDirection: (direction: OutputDirection) => void;
  onTransport: (transport: Transport) => void;
  /** An in-app authored connection landed (its credential-free projection). */
  onAuthorConnection: (connection: SftpConnectionProjection) => void;
  /** The operator cleared the authored connection. */
  onClearConnection: () => void;
  /** The operator chose the save-a-file alternative for SFTP. */
  onUseCliForSftp: () => void;
  /** The operator undid the save-a-file choice to author a connection here. */
  onRunHereForSftp: () => void;
  onReset: () => void;
  onCreate: () => void;
  onNavigate: (target: SpineTarget) => void;
}) {
  const consoleBuild = isConsoleBuild();
  const online = useOnlineStatus();
  // Derived from the draft here rather than passed in, the same read the Matching
  // keys tab makes for the notice the two steps share: a notice is a function of
  // the terms this step is restating, and two surfaces showing one must not
  // answer it differently.
  const currentTerms = useMemo(
    () => buildAdvancedTerms(editor.draft),
    [editor.draft],
  );
  const citationDrop = useMemo(
    () => importedCitationDropNotice(editor.draft, currentTerms),
    [editor.draft, currentTerms],
  );
  const inertCoalesce = useMemo(
    () => inertCoalesceNotice(editor.draft, currentTerms),
    [editor.draft, currentTerms],
  );
  const sftpConfigured = sftpConnection != null;
  const rendezvousConfigured = rendezvous?.configured === true;
  const available = availableTransports(
    consoleBuild,
    sftpConfigured,
    rendezvousConfigured,
    sftpSaveFilePreferred,
  );
  const transport = editor.transport ?? available.defaultTransport;
  const disabledFor = (candidate: Transport): boolean =>
    available.options.find((option) => option.transport === candidate)
      ?.disabled === true;
  const browserDisabled = disabledFor("browser");
  const filedropDisabled = disabledFor("filedrop");
  const sftpAuthoringRequired =
    available.options.find((option) => option.transport === "sftp")
      ?.authoringRequired === true;
  const {
    browserLabel,
    browserDescription,
    filedropLabel,
    filedropDescription,
    sftpLabel,
    sftpDescription,
    capabilityNote,
  } = transportChooserCopy(
    consoleBuild,
    sftpConfigured,
    rendezvousConfigured,
    sftpSaveFilePreferred,
    {
      ...(rendezvous?.split === true ? { split: true } : {}),
      ...(rendezvous?.problem !== undefined
        ? { problem: rendezvous.problem }
        : {}),
    },
  );
  // An sftp exchange chosen to run here cannot be created until a connection is
  // set up: block the seal and say so, rather than minting a code with no
  // rendezvous.
  const connectionIncomplete = transport === "sftp" && sftpAuthoringRequired;
  // The console conducts a file-sync run there, so its file-handling card is
  // offered there and nowhere else: a browser exchange has no shared directory,
  // and a save-a-file transport hands the settings to the operator's own command
  // line, where the flags already live.
  const exchangeFilesOffered =
    consoleBuild &&
    transport !== "browser" &&
    available.options.find((option) => option.transport === transport)
      ?.runMode === "server-job";
  // A combination core refuses is a form problem here, before the invitation is
  // sealed, rather than a job that fails at composition or at rendezvous.
  const exchangeFilesBlocked =
    exchangeFilesOffered &&
    exchangeFilesProblems(exchangeFiles, CONFIG_EXCHANGE_FILES).length > 0;
  const connectionTuningBlocked =
    exchangeFilesOffered &&
    connectionTuningProblems(connectionTuning).length > 0;
  const runDiagnosticsBlocked =
    exchangeFilesOffered && runDiagnosticsProblems(runDiagnostics).length > 0;
  const receiptsBlocked =
    exchangeFilesOffered &&
    receiptsProblems(receipts, editor.draft.identity).length > 0;
  // The SFTP session mode applies only where a session exists, so the card
  // withholds it on the shared-directory transport.
  const tuningCapabilities =
    transport === "sftp" ? SFTP_CONNECTION_TUNING : FILEDROP_CONNECTION_TUNING;
  // The rendezvous and the retain-mode toggle are decided in separate places, so
  // a split rendezvous -- an authored split SFTP connection, or a console
  // provisioned with two filedrop mounts -- can outlive the retain choice it
  // required: hold the create here, where both are known, rather than minting a
  // partner-facing accept kit for a rendezvous the run would then refuse. Read
  // only where this console conducts the run, since the file-handling choices
  // reach no other transport's run.
  const splitDirectoryProblem = !exchangeFilesOffered
    ? undefined
    : transport === "sftp"
      ? splitDirectoryRetainProblem(sftpConnection, exchangeFiles.retainFiles)
      : splitRendezvousRetainProblem(rendezvous, exchangeFiles.retainFiles);
  // A create that begins a live run cannot succeed with no network: this browser
  // listens for the partner from the mint onward, and a console server-job run
  // dials from the console. A save-a-file create connects to nothing -- it
  // seals the terms and hands an exchange file to the command line -- so it
  // stays available offline. Only the offline direction is gated: being online
  // is no promise the partner is there (see @utils/networkStatus).
  const offlineBlocked =
    !online && transportRunMode(available, transport) !== "save-file";
  const createStatus = inviterCreateStatus({
    offlineBlocked,
    connectionIncomplete,
    splitDirectoryProblem,
    exchangeFilesBlocked,
    connectionTuningBlocked,
    runDiagnosticsBlocked,
    receiptsBlocked,
    problemCount: problems.length,
  });
  // A mint already under way is the one hold with nothing to say: the button
  // holds it as its own loading state.
  const canCreate = createStatus.ready && !minting;
  // Voiced when the create gate flips either way; deferred so a blocked state
  // present when the section mounts still announces.
  const readiness = useDeferredAnnouncement(createStatus.announcement);
  return (
    <>
      <p className={styles.eyebrow}>Step 3 of 3</p>
      <h1 tabIndex={-1}>Review &amp; create</h1>
      <NativeSelect
        label="Invitation duration"
        description="How long this invitation can be accepted before it expires."
        value={String(editor.draft.lifetimeSeconds)}
        data={LIFETIME_CHOICES.map((choice) => ({
          value: String(choice.seconds),
          label: choice.label,
        }))}
        onChange={(event) => onLifetime(Number(event.currentTarget.value))}
      />
      <p className={`${styles.small} ${styles.sub}`}>
        Shared now, it expires{" "}
        <span className={styles.mono}>
          {expiryLabel(editor.draft.lifetimeSeconds, new Date())}
        </span>
        .
      </p>
      <NativeSelect
        label="Who receives the matched results"
        description="The party who receives no results still contributes records to the match."
        value={editor.draft.outputDirection}
        data={DIRECTION_CHOICES.map((choice) => ({
          value: choice.value,
          label: choice.label,
        }))}
        onChange={(event) =>
          onDirection(event.currentTarget.value as OutputDirection)
        }
        mt="md"
      />
      <fieldset className={styles.fieldset}>
        <legend>How will this exchange run?</legend>
        <div
          className={
            transport === "browser"
              ? `${styles.radioCard} ${styles.radioCardSelected}`
              : styles.radioCard
          }
        >
          <Radio
            name="transport"
            checked={transport === "browser"}
            disabled={browserDisabled}
            onChange={() => onTransport("browser")}
            label={browserLabel}
            description={browserDescription}
          />
        </div>
        <div
          className={
            transport === "sftp"
              ? `${styles.radioCard} ${styles.radioCardSelected}`
              : styles.radioCard
          }
        >
          <Radio
            name="transport"
            checked={transport === "sftp"}
            onChange={() => onTransport("sftp")}
            label={sftpLabel}
            description={sftpDescription}
          />
          {transport === "sftp" && consoleBuild && (
            <SftpConnectionCard
              connection={sftpConnection ?? null}
              saveFilePreferred={sftpSaveFilePreferred}
              retainFiles={exchangeFiles.retainFiles}
              probeCeremony="exchange"
              onAuthored={onAuthorConnection}
              onCleared={onClearConnection}
              onUseCli={onUseCliForSftp}
              onRunHere={onRunHereForSftp}
            />
          )}
        </div>
        <div
          className={
            transport === "filedrop"
              ? `${styles.radioCard} ${styles.radioCardSelected}`
              : styles.radioCard
          }
        >
          <Radio
            name="transport"
            checked={transport === "filedrop"}
            disabled={filedropDisabled}
            onChange={() => onTransport("filedrop")}
            label={filedropLabel}
            description={filedropDescription}
          />
        </div>
        <p className={`${styles.small} ${styles.sub}`}>{capabilityNote}</p>
      </fieldset>
      {exchangeFilesOffered && (
        <>
          <ExchangeFilesCard
            draft={exchangeFiles}
            capabilities={CONFIG_EXCHANGE_FILES}
            open={exchangeFilesOpen}
            onToggleOpen={onExchangeFilesOpen}
            onChange={onExchangeFiles}
          />
          <ConnectionTuningCard
            draft={connectionTuning}
            capabilities={tuningCapabilities}
            open={connectionTuningOpen}
            onToggleOpen={onConnectionTuningOpen}
            onChange={onConnectionTuning}
          />
          <RunDiagnosticsCard
            draft={runDiagnostics}
            open={runDiagnosticsOpen}
            onToggleOpen={onRunDiagnosticsOpen}
            onChange={onRunDiagnostics}
          />
          <ReceiptsCard
            draft={receipts}
            identity={editor.draft.identity}
            rendezvous={rendezvous}
            open={receiptsOpen}
            onToggleOpen={onReceiptsOpen}
            onChange={onReceipts}
          />
        </>
      )}
      <h2>Exchange proposal</h2>
      <p className={`${styles.small} ${styles.sub}`}>
        Check every term before you create the invitation. Creating it seals the
        terms.
      </p>
      {/* The one fact about the outgoing terms that the restatement below cannot
        show: a citation the rebuilt document drops is absent from it, so a table
        of what the terms say has nothing to put in the row. It is stated where
        the terms are confirmed as well as in the tab that costs it, since an
        operator can import there and come straight here. */}
      {citationDrop !== undefined && (
        <CitationDropNotice notice={citationDrop} />
      )}
      {/* The other fact the restatement below cannot show: a declared default the
        run will not substitute is a term that is treated as widening the match and
        does nothing. Stated where the terms are sealed, since the step editor's
        own advisory sits inside a card an operator need never reopen. It holds
        nothing shut -- such terms are valid and run. */}
      {inertCoalesce !== undefined && (
        <Alert
          role="note"
          color="yellow"
          icon={<IconAlertTriangle aria-hidden />}
          title="A default value will not be substituted"
          mt="md"
        >
          {inertCoalesce}
        </Alert>
      )}
      <div className={styles.tableScroll}>
        <table className={`${styles.dataTable} ${styles.answers}`}>
          <caption className={styles.visuallyHidden}>
            Check your answers before creating the invitation
          </caption>
          <tbody>
            {answersRows(editor, csv).map((row) => (
              <tr key={row.label}>
                <th scope="row">{row.label}</th>
                <td className={row.mono === true ? styles.mono : undefined}>
                  {row.value}
                </td>
                <td className={styles.answersChange}>
                  {row.changeTarget !== undefined ? (
                    <button
                      type="button"
                      className={styles.stepLink}
                      onClick={() =>
                        onNavigate(row.changeTarget as SpineTarget)
                      }
                    >
                      Change
                      <span className={styles.visuallyHidden}>
                        {" "}
                        {row.label.toLowerCase()}
                      </span>
                    </button>
                  ) : row.setAbove === true ? (
                    <span className={styles.setAbove}>
                      Set above on this step
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <VisuallyHidden>
        <p role="status" aria-live="polite" aria-atomic="true">
          {readiness}
        </p>
      </VisuallyHidden>
      <div className={styles.workFoot}>
        <Button disabled={!canCreate} loading={minting} onClick={onCreate}>
          Create the invitation
        </Button>
        <Button variant="default" disabled={minting} onClick={onReset}>
          Reset to defaults
        </Button>
        <p
          className={
            canCreate
              ? `${styles.statusLine} ${styles.statusLineOk}`
              : `${styles.statusLine} ${styles.statusLineDanger}`
          }
        >
          {createStatus.statusLine}
        </p>
      </div>
    </>
  );
}
