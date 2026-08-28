import { useMemo, useState } from "react";

import { Alert, Anchor, Button, CopyButton } from "@mantine/core";

import { DisclosureSection } from "@components/DisclosureSection";
import { triggerBlobDownload } from "@components/blobDownload";

import { dispatchManagedCronExport } from "@psi/managedExchangeExport";
import { markManagedExchangeSpent } from "@psi/managedLocalState";
import { readRecordAndMarkBackedUp } from "@psi/managedExchangeStore";

import { managedCronExportPanelState } from "./managedCronExportModel";
import styles from "./bench.module.css";

import type { ManagedCronExportDispatch } from "@psi/managedExchangeExport";
import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";

/** The key file's custody rules, cited rather than restated here. */
const KEY_FILE_SECURITY_DOC_URL =
  "https://github.com/georgetown-mdi/jspsi/blob/main/docs/SECURITY_DESIGN.md#key-file-security";

/** The platform seams the export drives: the same atomic read-and-mark by id every
 * managed export takes (never this component's mounted record, whose secret a
 * concurrent rotation may already have superseded), the blob download, and the
 * spend write. */
const cronExportDeps = {
  readAndMark: readRecordAndMarkBackedUp,
  download: triggerBlobDownload,
  markSpent: markManagedExchangeSpent,
  now: () => new Date(),
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
 * The spend is operator-attested, exactly as the device migration's is: two
 * `anchor.click()` calls give two chances to fail with no landing signal, so this
 * browser's copy stays live and runnable until the operator says both files landed.
 * On that attestation the source is spent -- handing the secret to a scheduler and
 * leaving this copy live would fork a linear secret between two owners.
 */
export function ManagedCronExportPanel({
  record,
  onBackedUp,
  onHandedOff,
}: {
  record: ManagedExchangeRecord;
  /** The export marked the record backed-up, at this instant; the host's backup
   * state reflects it without a reload. */
  onBackedUp: (backedUpAt: Date) => void;
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
  const state = useMemo(() => managedCronExportPanelState(record), [record]);

  function downloadFiles() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    void dispatchManagedCronExport(record.id, cronExportDeps)
      .then((dispatched) => {
        onBackedUp(dispatched.backedUpAt);
        setDispatch(dispatched);
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
  }

  function confirmHandoff() {
    if (dispatch === undefined || busy) return;
    const { composed } = dispatch;
    setBusy(true);
    setFailed(false);
    void dispatch
      .confirm(new Date())
      .then(() => {
        setDispatch(undefined);
        onHandedOff(composed.command);
      })
      .catch(() => setFailed(true))
      .finally(() => setBusy(false));
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
                    title="That export could not be completed"
                    mb="sm"
                  >
                    This export did not finish, so one or both files may be
                    missing. Check your browser&apos;s downloads and download
                    again; nothing is handed off until you confirm it.
                  </Alert>
                )}
                <Button mt="sm" onClick={downloadFiles} loading={busy}>
                  Download {state.composed.config.fileName} and{" "}
                  {state.composed.key.fileName}
                </Button>
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
                <ExportCode
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
                <ExportCode
                  code={state.cronLine}
                  ariaLabel="cron schedule line"
                />
                <p className={styles.small}>
                  Windows Task Scheduler, daily at 2am:
                </p>
                <ExportCode
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
                the built-in default (stun:stun.l.google.com:19302) to discover
                that machine&apos;s public address. The address, and the fact
                that a session is happening, are disclosed to that server; no
                exchange content is. Each run warns about it. Add a stun entry
                to the connection in {state.composed.config.fileName} to use
                your own server instead.
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
                    title="That could not be completed"
                    mb="sm"
                  >
                    This browser&apos;s copy could not be handed off. It is
                    still live here; try again.
                  </Alert>
                )}
                <p>
                  <Button onClick={confirmHandoff} loading={busy}>
                    I saved both files; hand off this exchange
                  </Button>{" "}
                  <Button
                    variant="subtle"
                    disabled={busy}
                    onClick={() => setDispatch(undefined)}
                  >
                    Keep it in this browser
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

/** A preformatted, copyable line: the command shown whole (with horizontal scroll
 * for long lines) beside a copy button. The clipboard check is defence-in-depth for
 * a non-secure origin, where the block is still selectable by hand. */
function ExportCode({ code, ariaLabel }: { code: string; ariaLabel: string }) {
  return (
    <div className={styles.handoffCodeRow}>
      <pre className={`${styles.handoffCode} ${styles.mono}`}>{code}</pre>
      {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        typeof navigator !== "undefined" && navigator.clipboard ? (
          <CopyButton value={code} timeout={1500}>
            {({ copied, copy }) => (
              <Button
                variant="default"
                size="compact-sm"
                onClick={copy}
                aria-label={
                  copied ? `${ariaLabel} copied` : `Copy ${ariaLabel}`
                }
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
          </CopyButton>
        ) : null
      }
    </div>
  );
}
