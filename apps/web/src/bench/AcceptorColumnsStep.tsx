import { Fragment, useEffect, useId, useRef } from "react";

import {
  Alert,
  Button,
  List,
  NativeSelect,
  Paper,
  Stack,
  Text,
  VisuallyHidden,
} from "@mantine/core";

import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
} from "@tabler/icons-react";

import {
  MAX_DECLARED_NAMES_SHOWN,
  OUTBOUND_SEND_NO_PAYLOAD_SENTENCE,
  unshownDeclaredNamesLine,
} from "@psilink/core";

import { ColumnName, isolatedColumnName } from "@components/ColumnName";
import { MetadataGrid } from "@components/MetadataGrid";
import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";
import { useOnlineStatus } from "@components/useOnlineStatus";

import { overlongColumnsAlert } from "@psi/columnNames";

import {
  acceptorDisclosedColumns,
  acceptorLaunchBlockedReason,
  acceptorOverlongDisclosedColumns,
  acceptorPayloadDeclarationConflict,
  acceptorStandardizationValid,
  acceptorUnsatisfiedTypes,
} from "./acceptorColumnsModel";
import styles from "./bench.module.css";

import type {
  AcceptorColumnsState,
  AcceptorVerdictViewModel,
} from "./acceptorColumnsModel";
import type {
  LinkageField,
  LinkageTerms,
  Metadata,
  SemanticType,
  Standardization,
} from "@psilink/core";
import type { ReactNode } from "react";

/**
 * The operator's OWN CSV headers as the declaration notice lists them: through the
 * same ColumnName every column-name surface on this screen uses, so a name here
 * reads exactly as it does in the grid row the operator has to change, and one per
 * line so a name containing a list separator cannot read as two.
 */
function MarkedColumnList({ names }: { names: Array<string> }) {
  return (
    <List size="sm" withPadding listStyleType="circle" my={4}>
      {names.map((column) => (
        <List.Item key={column}>
          <ColumnName name={column} />
        </List.Item>
      ))}
    </List>
  );
}

/**
 * The acceptor's "Confirm your columns" work surface (step 3 of 3). Presentational
 * over the shared column-step state the console owns -- the verdict, mapper, and
 * gate view-models come in derived from {@link acceptorColumnsModel}, and edits go
 * up through the callbacks; the pure logic and the launch payload live in the
 * console and the model, not here.
 *
 * The verdict and the launch consume the SAME `editorState`, so the visible gate
 * and the exchange that runs cannot disagree. The mapper appears only when a
 * required field type is still missing; a remap re-roles the chosen column for
 * matching (it calls the console's `onRemap`, which forces role linkage), never a
 * bare retype.
 */
export function AcceptorColumnsStep({
  linkageTerms,
  columns,
  columnsState,
  editorState,
  verdict,
  connectionSection,
  connectionBlocked = false,
  exchangeFilesSection,
  exchangeFilesBlocked = false,
  connectionTuningBlocked = false,
  runDiagnosticsBlocked = false,
  receiptsBlocked = false,
  splitDirectoryProblem,
  onMetadataChange,
  onRemap,
  onReset,
  onLaunch,
  onBack,
}: {
  /** The INVITER's terms, decoded from the invitation -- so `output.expectsOutput`
   * is this acceptor's PARTNER receiving the result, which is what the payload
   * step transmits on (acceptance mirrors the pair, so the acceptor's own
   * `expectsOutput` is the invitation's `shareWithPartner`). */
  linkageTerms: LinkageTerms;
  /** The acceptor's own CSV column names. */
  columns: Array<string>;
  columnsState: AcceptorColumnsState;
  /** The effective `{ metadata, standardization }` the verdict and launch consume. */
  editorState: { metadata: Metadata; standardization: Standardization };
  verdict: AcceptorVerdictViewModel;
  /** The transport-connection surface an accepted SFTP invitation needs authored
   * before launch (the {@link AcceptorSftpConnectionCard}), rendered below the
   * column surface and above the launch action. Absent for a browser or file-drop
   * accept, which need no per-exchange connection. */
  connectionSection?: ReactNode;
  /** Whether launch is blocked pending the transport connection (an SFTP accept
   * with no connection authored yet). ORs into the column-verdict gate so "Start
   * the exchange" cannot mint a run with nowhere to connect. */
  connectionBlocked?: boolean;
  /** The file-handling card for a run the console conducts (retain mode and the
   * toggles that travel with it). Absent on a browser accept, which has no
   * shared directory to tune. */
  exchangeFilesSection?: ReactNode;
  /** Whether the file-handling choices are a combination core refuses. ORs into
   * the launch gate exactly as {@link connectionBlocked} does, so an unusable
   * combination is a form problem here rather than a job that fails later. */
  exchangeFilesBlocked?: boolean;
  /** Whether the connection-tuning choices hold a value the run would refuse.
   * Gates launch as {@link exchangeFilesBlocked} does, but separately: the two
   * are separate cards in {@link exchangeFilesSection}, and the blocked reason
   * names the one to open. */
  connectionTuningBlocked?: boolean;
  /** Whether the diagnostics-and-recovery card holds an unconfirmed sweep. A
   * third card in {@link exchangeFilesSection}, gated separately for the same
   * reason. */
  runDiagnosticsBlocked?: boolean;
  /** Whether the receipts-and-record-keeping card holds a choice the run would
   * refuse. A fourth card in {@link exchangeFilesSection}, gated separately for
   * the same reason. */
  receiptsBlocked?: boolean;
  /** The requirement a split rendezvous makes of the file-handling choices, in the
   * console's own words, or undefined when it is met. Gates launch and IS the
   * blocked reason, so the operator meets the control to turn on rather than a
   * job that fails at composition. */
  splitDirectoryProblem?: string;
  onMetadataChange: (next: Metadata) => void;
  /** Bind a missing field type to a chosen column, forcing role linkage. */
  onRemap: (type: SemanticType, columnName: string) => void;
  onReset: () => void;
  onLaunch: () => void;
  /** Return to the consent step to choose a different file. */
  onBack: () => void;
}) {
  // Focus the heading on entry so a keyboard/screen-reader user who pressed
  // "Accept and continue" lands on this step rather than an unmounted button. The
  // console also drives step-heading focus, but this step owns the verdict focus
  // target below, so it manages its own heading too.
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // The verdict is one stable node; it is also the focus target after a quick-fix
  // remap, whose Select unmounts the moment its field becomes satisfiable -- focus
  // lands on the verdict (the result) rather than falling to <body>.
  const verdictRef = useRef<HTMLDivElement>(null);

  const deferredVerdictAnnouncement = useDeferredAnnouncement(
    verdict.announcement,
  );

  const online = useOnlineStatus();

  const unsatisfiedTypes = acceptorUnsatisfiedTypes(
    columns,
    linkageTerms,
    editorState,
  );
  const disclosed = acceptorDisclosedColumns(editorState.metadata);
  // Whether the payload step transmits anything at all from this machine: it
  // sends only to a partner entitled to the result, so an invitation giving the
  // inviting party no result sends no column regardless of what is marked below.
  // The acceptor's partner IS the inviting party, so the fact is the
  // invitation's own `expectsOutput` -- the mirrored acceptor-side field would
  // name this party's own receipt instead. The consent screen's outbound block
  // resolves the same fact for the same viewer, with the same sentence core
  // provides.
  const partnerReceivesResult = linkageTerms.output.expectsOutput;
  // How the marks below disagree with the payload set the invitation declares for
  // this party: the exchange refuses to run on that pair, and every input the
  // refusal reads is on this screen, so it is stated here rather than met after the
  // operator has consented, chosen a file, and launched.
  const declarationConflict = acceptorPayloadDeclarationConflict(
    linkageTerms,
    editorState.metadata,
  );
  // Which remedies the declared-but-unsent half even has: a column this file does
  // not hold cannot be marked at all, so only the columns it does hold get the
  // offer to widen the disclosure, and only the ones it lacks get "choose another
  // file".
  const expectedInFile =
    declarationConflict?.declaredButNotSent.filter((gap) => gap.inFile) ?? [];
  const expectedMissingFromFile =
    declarationConflict?.declaredButNotSent.filter((gap) => !gap.inFile) ?? [];
  // The cap keeps a flooded declaration from putting the metadata grid the operator
  // has to edit, and the launch control below it, past a screenful of partner text.
  // What it leaves out is counted rather than dropped, so the operator is still told
  // how large the list their partner sent is; every remedy below reads the whole set.
  const shownDeclaredGaps =
    declarationConflict?.declaredButNotSent.slice(
      0,
      MAX_DECLARED_NAMES_SHOWN,
    ) ?? [];
  const unshownDeclaredCount =
    (declarationConflict?.declaredButNotSent.length ?? 0) -
    shownDeclaredGaps.length;
  const overlongDisclosed = acceptorOverlongDisclosedColumns(
    linkageTerms,
    editorState.metadata,
  );
  const overlongAlert =
    overlongDisclosed.length > 0
      ? overlongColumnsAlert(overlongDisclosed)
      : undefined;
  const standardizationValid = acceptorStandardizationValid(
    editorState.standardization,
  );
  // Ties the disabled launch button to the blocked-reason line so a
  // keyboard/screen-reader user at the button hears why it is disabled and what to
  // do. The reason IS the gate: the button is disabled exactly while there is a
  // sentence to describe it with, so no state can disable it silently.
  const launchBlockedReasonId = useId();
  const launchBlockedReason = acceptorLaunchBlockedReason(
    verdict,
    editorState,
    linkageTerms,
    {
      // An accept ends in a live two-party session however it runs, so the
      // launch is held while the browser reports no network -- named in the same
      // line every other blocker speaks through.
      offline: !online,
      connectionBlocked,
      exchangeFilesBlocked,
      connectionTuningBlocked,
      runDiagnosticsBlocked,
      receiptsBlocked,
      ...(splitDirectoryProblem !== undefined ? { splitDirectoryProblem } : {}),
    },
  );
  const launchDisabled = launchBlockedReason !== undefined;

  const remap = (type: LinkageField["type"], columnName: string) => {
    // Move focus to the verdict before the chosen Select unmounts (it does as soon
    // as the field is satisfied), so a keyboard/screen-reader user lands on the
    // result instead of being dropped to <body>. The verdict node is stable, so
    // focusing it here -- ahead of the re-render -- is safe.
    verdictRef.current?.focus();
    onRemap(type, columnName);
  };

  return (
    <>
      <button type="button" className={styles.backlink} onClick={onBack}>
        {"←"} Choose a different file
      </button>
      <p className={styles.eyebrow}>Step 3 of 3</p>
      <h1 tabIndex={-1} ref={headingRef}>
        Confirm your columns
      </h1>
      <p className={`${styles.small} ${styles.sub}`}>
        Tell us what each column in your file is and what should be done with
        it.{" "}
        {/* The bound on what leaves, stated where the operator starts marking
            columns. Its exception clause drops when the payload step sends nothing:
            naming the marked columns as the thing that goes would promise a
            disclosure the run does not make, on the screen where those marks are
            being set. The panel below states the same bound with its reason. */}
        {partnerReceivesResult
          ? "Nothing here is sent to your partner except the columns you mark as shared."
          : "Nothing here is sent to your partner."}
      </p>

      <Stack>
        {/* The verdict's VISIBLE alert renders immediately (no flash or layout
            shift). This wrapper is NOT a live region and its inner Alert is
            role="presentation", so nothing here announces directly; the spoken
            verdict is voiced by the deferred polite region below, decoupled so a
            verdict already present on mount is announced as an empty -> non-empty
            transition. tabIndex=-1 keeps this the focus target after a remap. */}
        <div ref={verdictRef} tabIndex={-1} data-testid="verdict">
          {verdict.kind === "blocked" ? (
            <Alert
              role="presentation"
              color="red"
              icon={<IconAlertCircle aria-hidden />}
              title={verdict.title}
            >
              None of the agreed linkage keys can be satisfied by your columns,
              so no matches are possible. Set the columns below to the missing
              field types, then this will clear.
            </Alert>
          ) : verdict.kind === "partial" ? (
            <Alert
              role="presentation"
              color="yellow"
              icon={<IconAlertTriangle aria-hidden />}
              title={verdict.title}
            >
              Some linkage keys cannot be satisfied by your columns, and an
              exchange runs the keys both parties agreed on -- so it will refuse
              to run on these terms with this file. Map more columns below to
              cover the missing keys, or agree terms with your partner over the
              keys both files can supply.
            </Alert>
          ) : (
            <Alert
              role="presentation"
              color="green"
              icon={<IconCircleCheck aria-hidden />}
              title={verdict.title}
            >
              Every key in the invitation is covered by your columns.
            </Alert>
          )}
        </div>
        {/* The verdict's announcement channel: a stable polite region whose deferred
            text reaches assistive tech without fighting the heading focus on mount. */}
        <VisuallyHidden
          role="status"
          aria-live="polite"
          aria-atomic="true"
          data-testid="verdict-announcement"
        >
          {deferredVerdictAnnouncement}
        </VisuallyHidden>

        {/* A dead key the column verdict cannot see: the columns are present, but a
            cleaning rule in the partner's terms drops every record, so the key can
            never match. Its own advisory -- role="note", amber not red -- because the
            remedy is the partner's (a corrected invitation), not a column remap here.
            A count only, never the partner-controlled key names. Static (the terms'
            rules do not change as the operator edits), so not a live region. */}
        {verdict.deadKeyCount > 0 && (
          <Alert
            role="note"
            color="orange"
            icon={<IconAlertTriangle aria-hidden />}
            title={
              verdict.deadKeyCount === 1
                ? "A linkage key's rule drops every record"
                : `${verdict.deadKeyCount} linkage keys have a rule that drops every record`
            }
          >
            {verdict.deadKeyCount === 1 ? "A key has" : "Some keys have"} a
            cleaning rule in the agreed terms that drops every record, so{" "}
            {verdict.deadKeyCount === 1 ? "it" : "they"} would contribute no
            matches no matter what your file contains. The key came with the
            invitation, so you cannot edit it here - ask your partner for a
            corrected invitation.
          </Alert>
        )}

        {/* Directly under the verdict, co-located because it is what the operator
            acts on next: while a field type is still missing, the quick-fix remap;
            once every type is mappable, the static "what you'll send" summary. */}
        {unsatisfiedTypes.length > 0 ? (
          <Paper withBorder p="md">
            <Text size="sm" fw={600} mb="xs">
              Map a column to each missing field
            </Text>
            <Stack gap="sm">
              {unsatisfiedTypes.map(({ type, label }) => (
                // A native <select> (like the inviter's Matching & sharing table),
                // not a Mantine portal dropdown: the mockup shows a native select
                // here, and the console's responsive grid drives a ResizeObserver loop
                // that mispositions a portalled dropdown. The first option is a
                // disabled placeholder so no column is preselected.
                <NativeSelect
                  key={type}
                  label={label}
                  description={`No column is set to ${label.toLowerCase()} yet`}
                  value=""
                  data={[
                    { value: "", label: "Choose a column", disabled: true },
                    ...columns.map((column) => ({
                      // The option's VALUE stays the raw header -- it is the
                      // identity `remap` binds the field to; only the label is a
                      // display string.
                      value: column,
                      label: isolatedColumnName(column),
                    })),
                  ]}
                  onChange={(event) => {
                    const columnName = event.currentTarget.value;
                    if (columnName !== "") remap(type, columnName);
                  }}
                />
              ))}
            </Stack>
          </Paper>
        ) : (
          <Paper withBorder p="md">
            <Text size="sm" fw={600} mb={4}>
              What you will send to your partner
            </Text>
            {!partnerReceivesResult ? (
              // The direction answers this panel ahead of the operator's own marks,
              // so it takes the slot rather than qualifying a list beneath it, and
              // renders at normal weight (not the dimmed empty-state voice): it is a
              // statement about what leaves, not an absence of one.
              <Text size="xs">{OUTBOUND_SEND_NO_PAYLOAD_SENTENCE}</Text>
            ) : disclosed.length === 0 ? (
              <Text size="xs" c="dimmed">
                No additional columns. Your columns are used only to find
                matches; for each matched row you receive the columns your
                partner marks as sent.
              </Text>
            ) : (
              <Text size="xs">
                {/* The operator's OWN CSV headers, shown through the same
                    ColumnName every column-name surface on this screen uses, so
                    the name here reads exactly as it does in the grid row the
                    operator marked. This sentence puts copy in one text block
                    with the names -- separators and full stop -- so the isolate
                    class's residual reaches something here (what the isolation
                    does not contain is stated on ColumnName); the reordering is
                    driven in benchAccept's panel measurement. */}
                For each matched row:{" "}
                {disclosed.map((column, index) => (
                  <Fragment key={column}>
                    {index > 0 && ", "}
                    <ColumnName name={column} />
                  </Fragment>
                ))}
                .
              </Text>
            )}
          </Paper>
        )}

        {/* The marks below and the payload set the invitation declares for this
            party disagree: the exchange refuses that pair before any data moves,
            so it is stated beside the marks that decide it. Both directions are
            stated at once -- core refuses them in one message -- so clearing one
            does not reveal the other on the next attempt. Not a live region: the
            grid below already voices the disclosed set, and the launch button's
            blocked-reason line speaks for the gate. */}
        {declarationConflict !== undefined && (
          <Alert
            role="note"
            color="red"
            icon={<IconAlertCircle aria-hidden />}
            title={declarationConflict.title}
          >
            {declarationConflict.kind === "acceptsNothing" ? (
              <>
                The invitation says your partner accepts no columns from your
                file, but{" "}
                {declarationConflict.sentButNotDeclared.length === 1
                  ? "this one is"
                  : "these are"}{" "}
                still marked to send:
                <MarkedColumnList
                  names={declarationConflict.sentButNotDeclared}
                />
                The exchange cannot start while the two disagree. Set &quot;How
                it is used&quot; below to anything other than &quot;Sent to your
                partner&quot; for{" "}
                {declarationConflict.sentButNotDeclared.length === 1
                  ? "that column"
                  : "those columns"}
                , or ask your partner for an invitation that accepts them.
              </>
            ) : (
              <>
                The invitation lists exactly which columns your partner expects
                from your file, and the exchange cannot start until your marks
                match that list.
                {declarationConflict.sentButNotDeclared.length > 0 && (
                  <>
                    <Text size="sm" mt="xs">
                      Marked to send, but not on your partner&apos;s list:
                    </Text>
                    <MarkedColumnList
                      names={declarationConflict.sentButNotDeclared}
                    />
                    {/* The direction with a remedy on this screen, so it leads
                        with that remedy: the notice clears as the operator
                        re-marks, without a new invitation. */}
                    Set &quot;How it is used&quot; below to anything other than
                    &quot;Sent to your partner&quot; for{" "}
                    {declarationConflict.sentButNotDeclared.length === 1
                      ? "that column"
                      : "those columns"}
                    , or ask your partner for an invitation that expects{" "}
                    {declarationConflict.sentButNotDeclared.length === 1
                      ? "it"
                      : "them"}
                    .
                  </>
                )}
                {declarationConflict.declaredButNotSent.length > 0 && (
                  <>
                    <Text size="sm" mt="xs">
                      Expected by your partner, but not marked to send:
                    </Text>
                    {/* The invitation's OWN names, which the model has already
                        escaped for this sink -- partner-controlled text, unlike
                        the operator's headers above, and so also the half this
                        screen bounds by count. Keyed by position: nothing stops a
                        declaration naming the same column twice. */}
                    <List size="sm" withPadding listStyleType="circle" my={4}>
                      {shownDeclaredGaps.map((gap, index) => (
                        <List.Item key={index}>
                          {gap.displayName}
                          {!gap.inFile && " - not a column in this file"}
                        </List.Item>
                      ))}
                    </List>
                    {unshownDeclaredCount > 0 && (
                      <Text size="sm" mb={4}>
                        {unshownDeclaredNamesLine(unshownDeclaredCount)}
                      </Text>
                    )}
                    {/* The remedy here is mostly the partner's: widening the
                        operator's own disclosure to match is offered only where the
                        column exists, and never as the fix. Its cost is stated
                        without naming a role: one sentence covers a list whose
                        columns can sit at different uses -- one matching, one the
                        record identifier, one ignored -- and the grid row it points
                        at is where the use each of them gives up is shown. */}
                    Ask your partner for an invitation that expects what your
                    file sends
                    {expectedMissingFromFile.length > 0 &&
                      `, or choose a file that has ${
                        expectedMissingFromFile.length === 1
                          ? "that column"
                          : "those columns"
                      }`}
                    .
                    {expectedInFile.length > 0 &&
                      ' Where your file does have such a column, you can set it to "Sent to your partner" below instead - that discloses more than you have marked so far, and each column has a single use, so sending it replaces the use it has now.'}
                  </>
                )}
              </>
            )}
          </Alert>
        )}

        {/* A marked column whose name is too long to include: the exchange refuses
            it before any data moves, so it is stated beside the marks that decide
            it and directly above the grid whose rows are the file's columns.
            Located by position rather than named -- an offending name is longer
            than a notice can show. Not a live region: the blocked-reason line
            beside the launch button speaks for the gate. */}
        {overlongAlert !== undefined && (
          <Alert
            role="note"
            color="red"
            icon={<IconAlertCircle aria-hidden />}
            title={overlongAlert.title}
          >
            {overlongAlert.message}
          </Alert>
        )}

        <MetadataGrid
          metadata={columnsState.metadata}
          onChange={onMetadataChange}
          caption="Your columns: type and use"
          partnerReceivesResult={partnerReceivesResult}
        />
        <p className={`${styles.small} ${styles.sub}`}>
          Only one column can be the record identifier. Choose a single column
          that you can use to import the data back into your system.
        </p>

        {!standardizationValid && (
          <Text size="xs" c="red" role="alert">
            Finish or fix the highlighted cleaning steps before continuing.
          </Text>
        )}

        {connectionSection !== undefined && (
          <Paper withBorder p="md">
            <Text size="sm" fw={600} mb="xs">
              Connect to your partner&apos;s SFTP server
            </Text>
            {connectionSection}
          </Paper>
        )}

        {exchangeFilesSection !== undefined && (
          <Paper withBorder p="md">
            {exchangeFilesSection}
          </Paper>
        )}
      </Stack>

      <div className={styles.workFoot}>
        <Button
          onClick={onLaunch}
          disabled={launchDisabled}
          aria-describedby={
            launchBlockedReason !== undefined
              ? launchBlockedReasonId
              : undefined
          }
        >
          Start the exchange
        </Button>
        <Button variant="subtle" onClick={onReset}>
          Reset to defaults
        </Button>
        {/* Mounted whether or not it currently has content: assistive tech observes
            a live region from the moment it exists, so a reason that appears
            mid-session -- an edit above closing the gate the operator just opened --
            is an empty -> non-empty transition it announces, where a region mounting
            with its text already in place is announced unreliably. Same contract as
            the verdict's own region above. */}
        <p
          id={launchBlockedReasonId}
          className={`${styles.small} ${styles.sub}`}
          role="status"
          data-testid="launch-blocked-reason"
        >
          {launchBlockedReason}
        </p>
      </div>
    </>
  );
}
