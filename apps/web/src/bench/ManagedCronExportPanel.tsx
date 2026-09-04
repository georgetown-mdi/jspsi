import { useMemo, useState } from "react";

import { Alert, Anchor, Button } from "@mantine/core";

import { DisclosureSection } from "@components/DisclosureSection";
import { triggerBlobDownload } from "@components/blobDownload";

import {
  ManagedHandoffRefusedError,
  dispatchManagedCronExport,
} from "@psi/managedExchangeExport";
import {
  getManagedExchange,
  spendManagedExchangeIfCurrent,
} from "@psi/managedExchangeStore";

import {
  CLI_BUILT_IN_STUN_URI,
  managedCronExportPanelState,
} from "./managedCronExportModel";
import {
  RECORD_GONE_HANDOFF_REASON,
  RECORD_GONE_HANDOFF_TITLE,
  RUN_IN_FLIGHT_HANDOFF_REASON,
  RUN_IN_FLIGHT_HANDOFF_TITLE,
  SUPERSEDED_HANDOFF_TITLE,
  supersededHandoffReason,
} from "./managedHandoffGate";
import { CopyableCode } from "./CopyableCode";
import styles from "./bench.module.css";

import type {
  ManagedCronExportDispatch,
  ManagedHandoffRefusal,
} from "@psi/managedExchangeExport";
import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";

/** The key file's custody rules, cited rather than restated here. */
const KEY_FILE_SECURITY_DOC_URL =
  "https://github.com/georgetown-mdi/jspsi/blob/main/docs/SECURITY_DESIGN.md#key-file-security";

/** The platform seams the export drives: a read of the record by id (never this
 * component's mounted record, whose secret a concurrent rotation may already have
 * superseded) that stamps no backup marker, the blob download, and the atomic spend
 * the confirmation measures the operator's attestation against. */
const cronExportDeps = {
  readRecord: getManagedExchange,
  download: triggerBlobDownload,
  spendIfCurrent: spendManagedExchangeIfCurrent,
};

/**
 * The command-line export panel on a managed exchange's detail surface, beside the
 * backup panel and collapsed until the operator opens it: the graduation path from
 * a browser-run recurring exchange to `psilink exchange` under the host's own
 * scheduler (see docs/MANAGED_EXCHANGE.md, "Exporting to the command line").
 *
 * It downloads TWO files rather than one archive, because the two are handled
 * differently once they land: `psilink.yaml` carries no secret, and `.psilink.key`
 * is a plaintext credential. A zip would hide that split behind one save.
 *
 * Neither file is a backup this browser restores from, so this export marks no backup
 * marker and the panel says which kind of file it hands over. Taking it, confirming
 * the hand-off, and dismissing the confirmation all leave the backup panel above
 * reading exactly what it read before.
 *
 * The spend is operator-attested, exactly as the device migration's is: two
 * `anchor.click()` calls give two chances to fail with no landing signal, so this
 * browser's copy stays live and runnable until the operator says both files landed.
 * On that attestation the source is spent -- handing the secret to a scheduler and
 * leaving this copy live would fork a linear secret between two owners.
 *
 * That attestation can arrive long after the download, so the spend re-reads the
 * record and refuses files a run has rotated past, and refuses outright while a run
 * holds the run+rotate lock ({@link ManagedHandoffRefusedError} for both). The
 * panel's own withholding of the download and the confirmation runs off a poll of
 * that lock, so the refusal is rarely the operator's first news of a run; but the
 * refusal is what makes the guarantee, the two being separated by however long the
 * operator takes to answer. A run the poll missed is shown in the poll's own words:
 * the wait is the same wait, arriving from the spend rather than from the reading.
 */
export function ManagedCronExportPanel({
  record,
  runInFlight,
  recheckRunInFlight,
  onHandedOff,
}: {
  record: ManagedExchangeRecord;
  /** Whether a run of this exchange is in flight in any context this browser profile
   * can see -- the host's own run, a second tab's, or the scheduled runtime's. Both
   * the download and the hand-off confirmation are withheld while it is, for the
   * reason they state ({@link RUN_IN_FLIGHT_HANDOFF_REASON}). */
  runInFlight: boolean;
  /** Re-read the run signal now, resolving what it read. The confirmation takes it
   * at the click, since {@link runInFlight} is a poll's last reading. */
  recheckRunInFlight: () => Promise<boolean>;
  /** The operator attested the files landed and the source is spent, so the host
   * takes down the run affordances. Carries the invocation to run instead. */
  onHandedOff: (command: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // A dispatched export whose two downloads fired but whose spend awaits the
  // operator attesting both files are saved; dismissing it leaves the source live.
  const [dispatch, setDispatch] = useState<ManagedCronExportDispatch>();
  // The confirmation the store refused, and which refusal it was: a run held the
  // run+rotate lock at the click, a run rotated past the files this panel
  // downloaded, or the record is gone from this browser entirely. Its own state,
  // not `failed`, because none of the three is an error tier.
  const [refusal, setRefusal] = useState<ManagedHandoffRefusal>();
  const state = useMemo(() => managedCronExportPanelState(record), [record]);

  // A run holds the hand-off back: the polled reading, or the spend's own refusal
  // at a click the poll's last reading was too old to hold back.
  const runHoldsHandoff = runInFlight || refusal === "run-in-flight";
  // The refusals no retry can clear -- the files on disk are out of date, or the
  // record they came from is gone -- as against the run one, which ends with the
  // run.
  const staleHandoff = refusal !== undefined && refusal !== "run-in-flight";

  // Downloading mid-run only manufactures files the confirmation will refuse: the
  // run rotates past them before the operator can attest to them.
  function downloadFiles() {
    if (busy || runInFlight) return;
    setBusy(true);
    setFailed(false);
    setRefusal(undefined);
    void dispatchManagedCronExport(record.id, cronExportDeps)
      .then(setDispatch)
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  }

  // The spend itself refuses a run in flight and files the record has rotated past,
  // so this classifies those refusals rather than guarding against them.
  function confirmHandoff() {
    if (dispatch === undefined || busy || runInFlight || staleHandoff) return;
    const { composed } = dispatch;
    setBusy(true);
    setFailed(false);
    setRefusal(undefined);
    void (async () => {
      try {
        // The gate above renders from a poll, so a run started since the last
        // reading is still news here; re-reading also puts the reason on screen.
        // A run this reading still misses is refused by the spend itself, which
        // takes the run's own lock.
        if (await recheckRunInFlight()) return;
        await dispatch.confirm(new Date());
        setDispatch(undefined);
        onHandedOff(composed.command);
      } catch (error) {
        if (error instanceof ManagedHandoffRefusedError)
          setRefusal(error.refusal);
        else setFailed(true);
      } finally {
        setBusy(false);
      }
    })();
  }

  return (
    <div className={styles.callout}>
      <DisclosureSection
        label="Run this from the command line instead"
        summary={
          state.kind === "refused"
            ? "Not available for this exchange"
            : undefined
        }
        open={open}
        onToggle={setOpen}
        headingOrder={2}
      >
        {state.kind === "refused" ? (
          <>
            <p className={styles.small}>
              This exchange cannot be handed to the command line, so there is
              nothing to download here.
            </p>
            <p className={styles.small} style={{ whiteSpace: "pre-line" }}>
              {state.reason}
            </p>
          </>
        ) : (
          <>
            <p className={styles.small}>
              This exchange runs in this browser. To run it on a schedule from
              the command line instead, download the two files{" "}
              <span className={styles.mono}>psilink exchange</span> opens, put
              them in a folder on the machine that will run the schedule, and
              schedule the command there. Handing it over ends its life in this
              browser: one owner holds a recurring exchange&apos;s secret, never
              two.
            </p>
            <p className={styles.small}>
              These two files are the command line&apos;s, not a backup file
              this browser can restore from -- importing them here does nothing,
              so downloading them leaves the backup state above exactly as it
              is. If you want a file that brings this exchange back to this
              browser, download a backup up there first and keep the exchange
              here -- once you hand it over, a backup taken before the hand-off
              will not bring it back.
            </p>
            <ol className={styles.handoffSteps}>
              <li>
                <p className={styles.handoffStepLabel}>
                  Download the two files into one folder
                </p>
                <ul className={styles.small}>
                  <li>
                    <span className={styles.mono}>
                      {state.composed.config.fileName}
                    </span>{" "}
                    -- the agreed terms and the rendezvous address. No secret.
                  </li>
                  <li>
                    <span className={styles.mono}>
                      {state.composed.key.fileName}
                    </span>{" "}
                    -- this exchange&apos;s shared secret, in plain text.
                  </li>
                </ul>
                <p className={styles.small}>
                  Save the key file readable only by you, and never send it over
                  an unencrypted channel. It is the command-line
                  application&apos;s own key file and is held under that
                  file&apos;s custody rules --{" "}
                  <Anchor
                    inherit
                    href={KEY_FILE_SECURITY_DOC_URL}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Key file security
                  </Anchor>
                  .
                </p>
                {failed && dispatch === undefined && (
                  <Alert
                    color="red"
                    title="Could not export the command-line files"
                    mb="sm"
                  >
                    This export did not finish, so one or both files may be
                    missing. Check your browser&apos;s downloads and download
                    again; nothing is handed off until you confirm it.
                  </Alert>
                )}
                <Button
                  mt="sm"
                  onClick={downloadFiles}
                  loading={busy}
                  disabled={runInFlight}
                >
                  Download {state.composed.config.fileName} and{" "}
                  {state.composed.key.fileName}
                </Button>
                {runInFlight && dispatch === undefined && (
                  <p className={styles.small}>{RUN_IN_FLIGHT_HANDOFF_REASON}</p>
                )}
              </li>
              <li>
                <p className={styles.handoffStepLabel}>
                  Put your input file in that folder
                </p>
                <p className={styles.small}>
                  The command below reads input.csv from the folder it runs in
                  and writes results.csv beside it. Name your file to match, or
                  change the names in the command.
                </p>
              </li>
              <li>
                <p className={styles.handoffStepLabel}>Run it there</p>
                <CopyableCode
                  code={state.composed.command}
                  ariaLabel="exchange command"
                />
              </li>
              <li>
                <p className={styles.handoffStepLabel}>
                  Schedule it (adjust the times and the folder)
                </p>
                <p className={styles.small}>
                  cron (Linux/macOS), daily at 2am:
                </p>
                <CopyableCode
                  code={state.cronLine}
                  ariaLabel="cron schedule line"
                />
                <p className={styles.small}>
                  Windows Task Scheduler, daily at 2am:
                </p>
                <CopyableCode
                  code={state.taskSchedulerLine}
                  ariaLabel="Windows Task Scheduler command"
                />
                <p className={styles.small}>
                  Both lines call psilink by name. Under cron&apos;s minimal
                  PATH or a Task Scheduler service account it may not resolve,
                  and fails quietly -- use the full path to the psilink binary,
                  or put it on the scheduling account&apos;s PATH.
                </p>
              </li>
            </ol>
            <h3 className={styles.handoffHeading}>Before you schedule it</h3>
            <ul className={styles.small}>
              <li>
                This exchange names no STUN server, so every scheduled run uses
                the built-in default ({CLI_BUILT_IN_STUN_URI}) to discover that
                machine&apos;s public address. The address, and the fact that a
                session is happening, are disclosed to that server; no exchange
                content is. Each run warns about it. Add a stun entry to the
                connection in {state.composed.config.fileName} to use your own
                server instead.
              </li>
              <li>
                The schedule you agreed with your partner does not travel in
                these files -- the cron entry or scheduled task is the schedule
                on the command line, so set it to the window your partner
                expects.
              </li>
              <li>
                Once you confirm the hand-off, these two files are this
                exchange&apos;s backup of record: this browser&apos;s copy is
                spent, and each scheduled run rotates the secret past any
                browser backup you took earlier.
              </li>
            </ul>
            {dispatch !== undefined && (
              <>
                <p className={styles.calloutLead}>Confirm the hand-off.</p>
                <p className={styles.small}>
                  Both files were downloaded. Confirm they landed before this
                  browser gives up its copy: once you confirm, this exchange no
                  longer runs here. If only one arrived, or a save was
                  cancelled, keep it here and download again.
                </p>
                <p className={styles.small}>
                  This exchange&apos;s accounting of disclosures stays in this
                  browser: it does not travel in these files. If you need to
                  keep it, export it as CSV below before you confirm.
                </p>
                {failed && (
                  <Alert
                    color="red"
                    title="Could not hand off this exchange"
                    mb="sm"
                  >
                    This browser&apos;s copy could not be handed off. It is
                    still live here; try again.
                  </Alert>
                )}
                {runHoldsHandoff && (
                  <Alert
                    color="yellow"
                    title={RUN_IN_FLIGHT_HANDOFF_TITLE}
                    mb="sm"
                  >
                    {RUN_IN_FLIGHT_HANDOFF_REASON}
                  </Alert>
                )}
                {staleHandoff && (
                  <Alert
                    color="yellow"
                    title={
                      refusal === "record-gone"
                        ? RECORD_GONE_HANDOFF_TITLE
                        : SUPERSEDED_HANDOFF_TITLE
                    }
                    mb="sm"
                  >
                    {refusal === "record-gone"
                      ? RECORD_GONE_HANDOFF_REASON
                      : supersededHandoffReason("command-line")}
                  </Alert>
                )}
                <p>
                  <Button
                    onClick={confirmHandoff}
                    loading={busy}
                    disabled={runInFlight || staleHandoff}
                  >
                    I saved both files; hand off this exchange
                  </Button>{" "}
                  <Button
                    variant="subtle"
                    disabled={busy}
                    onClick={() => {
                      setDispatch(undefined);
                      setRefusal(undefined);
                    }}
                  >
                    {refusal === "record-gone"
                      ? "Close"
                      : "Keep it in this browser"}
                  </Button>
                </p>
              </>
            )}
          </>
        )}
      </DisclosureSection>
    </div>
  );
}
