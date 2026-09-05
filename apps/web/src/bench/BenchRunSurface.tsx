import { useEffect, useRef, useState } from "react";

import { Alert, Button, CopyButton, Group, Modal } from "@mantine/core";
import { IconAlertCircle, IconAlertTriangle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { DEFAULT_PEER_TIMEOUT_MS } from "@psilink/core";

import { dateTimeLabel } from "@psi/inviterModel";
import styles from "./bench.module.css";

import type { NoResultFileOutputs, RunOutputs } from "@psi/runOutputs";
import type { JobExchangeRecordOfferState } from "./useJobExchangeRecordOffer";
import type { ReactNode } from "react";
import type { RunFailure } from "./useInviterExchange";

/**
 * The keep-open callout body for a server-job run: the console runs the
 * exchange, so leaving the page leaves it running -- the console re-attaches
 * to it (or discards it) on return, rather than losing it. Shared by both
 * seats' run columns so the two cannot drift.
 */
export const SERVER_JOB_KEEP_OPEN_BODY =
  "This console is running the exchange. If you leave this page the run " +
  "keeps going; come back here to pick it up or discard it.";

/**
 * Format a peer-timeout duration as the human phrase the copy embeds ("an hour"
 * at the one-hour default). Derived so {@link SERVER_JOB_PEER_WINDOW_BODY} tracks
 * `DEFAULT_PEER_TIMEOUT_MS` rather than restating it, and a copy-pin test asserts
 * the two agree. Exported for that test.
 *
 * @internal
 */
export function peerWindowDurationPhrase(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? "an hour" : `${hours} hours`;
  }
  if (minutes === 1) return "a minute";
  return `${minutes} minutes`;
}

/**
 * The peer-coordination callout body for a server-job run: the exchange needs
 * both consoles running their halves at once, and the console waits only
 * about the peer-timeout window before it stops. Its duration is derived
 * from core's `DEFAULT_PEER_TIMEOUT_MS` so the copy cannot drift from the
 * CLI default. The console never sets `peerTimeoutMs`, so this is the
 * window every console-composed exchange actually runs under.
 */
export const SERVER_JOB_PEER_WINDOW_BODY =
  "Your partner's console must run its half while yours is running. Yours " +
  `waits about ${peerWindowDurationPhrase(DEFAULT_PEER_TIMEOUT_MS)} for the ` +
  "partner before the exchange stops; if it stops, coordinate a time and run " +
  "it again.";

const PREVIEW_EDGE_CHARS = 8;
const COPY_STATUS_CLEAR_MS = 2000;

/**
 * The short preview of a copy-only artifact: the secret's first and last
 * {@link PREVIEW_EDGE_CHARS} characters around an ellipsis, with a deep
 * link's origin-and-route head (through the first `#`, mirroring
 * `tokenFromInput`'s split) rendered in full. Sliced rather than
 * CSS-truncated, since truncation would still hand the whole secret to
 * screen readers and select-all. A value too short to elide renders whole.
 */
function previewFor(value: string): string {
  const hash = value.indexOf("#");
  const head = hash === -1 ? "" : value.slice(0, hash + 1);
  const secret = hash === -1 ? value : value.slice(hash + 1);
  if (secret.length <= PREVIEW_EDGE_CHARS * 2 + 1) return value;
  return (
    head +
    secret.slice(0, PREVIEW_EDGE_CHARS) +
    "\u2026" +
    secret.slice(-PREVIEW_EDGE_CHARS)
  );
}

/**
 * A labelled, copy-to-clipboard view of one shareable artifact -- the
 * invitation link/code on the share screen and the save surface. The DOM
 * holds only a head/tail preview of the value; Copy puts the full value on
 * the clipboard (announced through a polite status region), and a
 * disclosure toggle reveals the full value in a readonly textarea for when
 * the clipboard is unavailable. The reveal never persists across a mount,
 * and the Copy button is hidden wherever `navigator.clipboard` is
 * undefined.
 */
export function CopyRow({
  label,
  hint,
  value,
}: {
  label: string;
  hint?: string;
  value: string;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const [revealed, setRevealed] = useState(false);
  const statusTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(statusTimer.current), []);
  function announceCopied() {
    setCopyStatus("Copied to clipboard");
    window.clearTimeout(statusTimer.current);
    statusTimer.current = window.setTimeout(
      () => setCopyStatus(""),
      COPY_STATUS_CLEAR_MS,
    );
  }
  // "link" / "code", for the reveal toggle's name.
  const noun = label.split(" ").at(-1)?.toLowerCase() ?? "value";
  return (
    <div className={styles.copyRow}>
      <span className={styles.copyLabel}>{label}</span>
      {hint !== undefined && <span className={styles.copyHint}>{hint}</span>}
      <div className={styles.copyBox}>
        <div
          className={`${styles.codeBlock} ${styles.mono} ${styles.copyPreview}`}
        >
          {previewFor(value)}
        </div>
        {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          typeof navigator !== "undefined" && navigator.clipboard ? (
            <CopyButton value={value} timeout={1000}>
              {({ copied, copy }) => (
                <Button
                  className={styles.copyBtn}
                  variant="default"
                  onClick={() => {
                    copy();
                    announceCopied();
                  }}
                  // Name reflects the copied state so a screen reader announces
                  // the success (the label swap alone is not reliably conveyed
                  // to assistive tech).
                  aria-label={
                    copied ? `${label} copied` : `Copy ${label.toLowerCase()}`
                  }
                >
                  {copied ? "Copied" : "Copy"}
                </Button>
              )}
            </CopyButton>
          ) : null
        }
      </div>
      <div role="status" aria-atomic="true" className={styles.copyStatus}>
        {copyStatus}
      </div>
      <Button
        variant="subtle"
        size="compact-sm"
        aria-expanded={revealed}
        onClick={() => setRevealed((current) => !current)}
      >
        Show full {noun}
      </Button>
      {revealed && (
        <textarea
          className={`${styles.revealArea} ${styles.mono}`}
          readOnly
          value={value}
          aria-label={label}
        />
      )}
    </div>
  );
}

/**
 * The role-neutral run/completion furniture shared by both console seats'
 * run columns: the download rows, the completion panel, the withheld-result
 * inset, the failure alert block, and the "set up another exchange"
 * workfoot. Nothing here is role-aware -- the calling section decides which
 * downloads exist, what the failure recoveries are, and what the panel
 * says.
 */

/** A labelled download link. The accessible name includes the caveat as
 * well as the filename: the caveat is part of what the operator agrees to
 * by downloading, so a screen reader browsing links must hear it, not only
 * the filename. */
export function DownloadRow({
  label,
  caveat,
  href,
  fileName,
}: {
  label: string;
  caveat?: "keep private";
  href: string;
  fileName: string;
}) {
  return (
    <div className={styles.dlRow}>
      <span className={styles.dlLabel}>
        {label}
        {caveat !== undefined && (
          <>
            {" "}
            <span className={styles.keepPrivate}>({caveat})</span>
          </>
        )}
        :
      </span>
      <a
        className={`${styles.linkLike} ${styles.mono}`}
        href={href}
        download={fileName}
        aria-label={`${label}${caveat === undefined ? "" : ` (${caveat})`}: ${fileName}`}
      >
        {fileName}
      </a>
    </div>
  );
}

/**
 * What the completion headline names after "Exchange complete", or
 * undefined when this run produced nothing to name. A matched run names its
 * row count; a count-only run names the mode only, since the count itself
 * is stated once, in the inset that stands where the result would be. A
 * withheld run names neither.
 *
 * `count`, when present, renders in the mono voice ahead of `label`.
 *
 * Exported for the copy-pin test.
 *
 * @internal
 */
export function completionOutcome(
  outputs: RunOutputs | undefined,
): { count?: number; label: string } | undefined {
  if (outputs === undefined) return undefined;
  switch (outputs.kind) {
    case "counted":
      return { label: "count only" };
    case "matched":
      // Absent on the server-job path: the console holds the result itself
      // and counts no rows, so the headline states completion alone rather
      // than inventing a figure.
      return outputs.matchedRecordCount === undefined
        ? undefined
        : { count: outputs.matchedRecordCount, label: "matched records" };
    case "withheld":
      return undefined;
  }
}

/** The completion panel: the big "Exchange complete" line naming whatever this run
 * produced ({@link completionOutcome}), and the finished-at timestamp. It takes the
 * whole outputs shape rather than a bare number so the three outcomes cannot
 * collapse into one another here. */
export function DonePanel({
  outputs,
  finishedAt,
}: {
  outputs: RunOutputs | undefined;
  finishedAt: Date | undefined;
}) {
  const outcome = completionOutcome(outputs);
  return (
    <div className={styles.donePanel}>
      <p className={styles.bigCount}>
        Exchange complete
        {outcome !== undefined && (
          <>
            {" - "}
            {outcome.count !== undefined && (
              <>
                <span className={styles.mono}>
                  {new Intl.NumberFormat("en-US").format(outcome.count)}
                </span>{" "}
              </>
            )}
            {outcome.label}
          </>
        )}
      </p>
      {finishedAt !== undefined && (
        <p className={`${styles.small} ${styles.sub} ${styles.mono}`}>
          Finished {dateTimeLabel(finishedAt)}
        </p>
      )}
    </div>
  );
}

/** The withheld-result inset: this party contributed to the match but, by the
 * agreed terms, receives no result table, so there is nothing to download. */
function WithheldResultInset() {
  return (
    <div className={styles.stateInset}>
      <p className={styles.stateLabel}>Results withheld by the terms</p>
      <p className={styles.small} style={{ margin: 0 }}>
        Your records contributed to the match. By the agreed terms, you receive
        no result table, so there is nothing to download here.
      </p>
    </div>
  );
}

/**
 * The trust-contingent caveat attached to a count this party did not
 * compute, stated where the number is read: only one party runs the
 * count-only round, and the other's copy travels back as that party's word
 * over a leg psilink does not check against a run of its own. The seat that
 * computed its own count gets no such line, since the count-only mode is
 * enforced for it there.
 *
 * The sentence is pinned as literals in the console browser cases rather
 * than through this export.
 *
 * @internal
 */
export const REPORTED_COUNT_CAVEAT =
  "Your partner ran the match and sent you this number. psilink does not " +
  "check a count it is sent against a run of its own, so the figure is your " +
  "partner's word for it.";

/** The count-only inset, standing where the result download would be and
 * holding the run's whole result: the count itself, what the run did not
 * produce, and -- for a seat handed a number it did not compute -- the
 * caveat that figure comes with. The count is stated here rather than in
 * the completion headline because the recovery panel renders this inset but
 * has no headline, so a count stated only there would vanish on
 * re-attachment. */
function CountOnlyResultInset({
  count,
  countReportedByPartner,
}: {
  count: number;
  countReportedByPartner: boolean;
}) {
  return (
    <div className={styles.stateInset}>
      <p className={styles.stateLabel}>Count only</p>
      <p className={styles.small} style={{ margin: 0 }}>
        <span className={styles.mono}>
          {new Intl.NumberFormat("en-US").format(count)}
        </span>{" "}
        records in common. This exchange reported the size of the overlap and
        nothing else -- no records were matched to each other and no columns
        were shared -- so there is no result table to download.
      </p>
      {countReportedByPartner && (
        <p className={styles.small} style={{ marginBottom: 0 }}>
          {REPORTED_COUNT_CAVEAT}
        </p>
      )}
    </div>
  );
}

/**
 * What stands where the result download would be when this run produced no result
 * file: what a count-only exchange did and did not produce, or the statement that
 * the agreed terms withheld the result table. The two cases are distinct outcomes
 * -- a count-only party received exactly what its terms promised -- so a surface
 * picks between them here rather than reporting either as the other. A `matched`
 * run has a download to offer and never reaches this inset.
 */
export function NoResultFileInset({
  outputs,
}: {
  outputs: NoResultFileOutputs;
}) {
  return outputs.kind === "withheld" ? (
    <WithheldResultInset />
  ) : (
    <CountOnlyResultInset
      count={outputs.intersectionCount}
      countReportedByPartner={outputs.countReportedByPartner}
    />
  );
}

/**
 * The sink a {@link RunFailure} message is shown through. The seat composes
 * the message as a cause chain relying on `pre-line` to turn the error
 * renderer's newline (`sanitizedFailureMessage` in `./useInviterExchange`)
 * into a line break. Both `FailureAlert` and `RecoveredExchangePanel` render
 * their message through here rather than styling their own span, keeping
 * the layout `test/browser/failureMessageLayout.test.ts` measures to one
 * component.
 */
export function FailureMessage({ message }: { message: string }) {
  return <span style={{ whiteSpace: "pre-line" }}>{message}</span>;
}

/**
 * The failure alert block: the alert takes focus when it appears (so the
 * message is read before anything else), states the category's message, and
 * renders whatever recovery the section supplies as its children. The
 * focus-on-appear effect is here so every seat's failure alert behaves the same
 * without each re-implementing it.
 */
export function FailureAlert({
  failure,
  children,
}: {
  failure: RunFailure;
  children?: ReactNode;
}) {
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    alertRef.current?.focus();
  }, []);
  return (
    <Alert
      color="red"
      icon={<IconAlertCircle aria-hidden />}
      title={failure.title}
      ref={alertRef}
      tabIndex={-1}
      mb="md"
    >
      <FailureMessage message={failure.message} />
      {children}
    </Alert>
  );
}

/** The title the untaken-record confirm heads with. It names what is about to be
 * lost rather than the recovery being taken, because the recovery is what the
 * operator already pressed and the record is the news. */
export const UNTAKEN_RECORD_CONFIRM_TITLE = "Leave the exchange record behind?";

/**
 * What the untaken-record confirm says. The record of a disclosure that
 * already happened is on the console, and the recovery the operator
 * pressed removes the run's folder with it. Stated as the irreversible
 * removal it is, and pointed at the download standing on the same screen.
 */
export const UNTAKEN_RECORD_CONFIRM_BODY =
  "This run exchanged data before it stopped, and this console holds its " +
  "record of that disclosure. Going on removes the run and the record with it, " +
  "and neither party can recreate it. Download it from the exchange-record " +
  "panel on this page first if you need the accounting entry.";

/** The title the confirm heads with over a record the console holds and
 * cannot read. It names the file rather than the record's contents, which
 * is the part that is established. */
export const UNDESCRIBABLE_RECORD_CONFIRM_TITLE =
  "Leave the unreadable exchange record behind?";

/**
 * What that confirm says. The console offers no download for such a file,
 * so the confirm cannot point at the panel's own download as the
 * untaken-record one does; it points at the file where it sits instead. It
 * claims only the file's presence, not what the record states, since that
 * is precisely what could not be read.
 */
export const UNDESCRIBABLE_RECORD_CONFIRM_BODY =
  "This console holds a file for this run that it cannot read as an exchange " +
  "record, so this page cannot say what it records or offer it for download. " +
  "Going on removes the run and that file, and neither party can recreate it. " +
  "Copy it out of this run's folder in the console's working directory first " +
  "if you need the accounting entry.";

/** The title the confirm heads with when the ask never answered. It asks about a
 * record it cannot say is there, because that is all an unanswered ask
 * established -- the alternative is a title that asserts one. */
export const UNKNOWN_RECORD_CONFIRM_TITLE =
  "Leave a possible exchange record behind?";

/**
 * What that confirm says. It names the silence rather than the record: the
 * ask ended without the console ever saying whether this run wrote one, so
 * the operator is deciding whether to remove a run that may hold the record
 * of a disclosure. Pointed at the one thing that turns the unknown back
 * into an answer, matching the standing notice on the record panel itself
 * ({@link ./RecordDownload}).
 */
export const UNKNOWN_RECORD_CONFIRM_BODY =
  "This console stopped answering whether this run wrote a disclosure " +
  "record. Going on removes the run and anything it wrote, and neither party " +
  "can recreate it. Reload this page to check first if you need the " +
  "accounting entry.";

/**
 * What that confirm says while the ask is still running. Same unknown, different
 * reason for it and a different way out: nothing has stopped answering yet, and
 * the answer is coming to this page on its own, so it points at waiting rather
 * than at a reload that would start the asking over.
 */
export const PENDING_RECORD_CONFIRM_BODY =
  "This console has not yet answered whether this run wrote a disclosure " +
  "record. Going on removes the run and anything it wrote, and neither party " +
  "can recreate it. Wait for the answer first if you need the accounting " +
  "entry.";

/** The title the confirm heads with once the ask has landed on the
 * console's own denial while the dialog is open. The record is settled and
 * there is none, so the question is only about the recovery the operator
 * already pressed. */
export const NO_RECORD_CONFIRM_TITLE = "Go on and remove this run?";

/**
 * What that confirm says. It is the copy for a dialog the operator opened over an
 * unresolved ask that has since answered: the answer is stated, the interruption
 * is closed out rather than vanishing under the reader, and the removal is still
 * named for what it is.
 */
export const NO_RECORD_CONFIRM_BODY =
  "This console holds no exchange record for this run, so there is none to " +
  "leave behind. Going on removes the run and its files from this console, " +
  "which cannot be undone.";

/** The heading and body of one untaken-record confirm. */
export interface UntakenRecordConfirm {
  title: string;
  body: string;
}

/**
 * The confirm a control that discards the run owes in this record-ask
 * state, or undefined where it owes none and can act straight through.
 *
 * Only the console's own `none` -- and a seat with no ask at all -- skip
 * the confirm: `none` is the one definitive answer that the run wrote no
 * record, so discarding costs nothing unseen. Every other state confirms,
 * because a run that got this far may owe a record and the discard cannot
 * be undone.
 */
export function untakenRecordConfirm(
  offer: JobExchangeRecordOfferState | undefined,
): UntakenRecordConfirm | undefined {
  if (offer?.kind === "available")
    return {
      title: UNTAKEN_RECORD_CONFIRM_TITLE,
      body: UNTAKEN_RECORD_CONFIRM_BODY,
    };
  if (offer?.kind === "undescribable")
    return {
      title: UNDESCRIBABLE_RECORD_CONFIRM_TITLE,
      body: UNDESCRIBABLE_RECORD_CONFIRM_BODY,
    };
  if (offer?.kind === "unanswered")
    return {
      title: UNKNOWN_RECORD_CONFIRM_TITLE,
      body: UNKNOWN_RECORD_CONFIRM_BODY,
    };
  if (offer?.kind === "asking")
    return {
      title: UNKNOWN_RECORD_CONFIRM_TITLE,
      body: PENDING_RECORD_CONFIRM_BODY,
    };
  return undefined;
}

/**
 * One recovery a failure surface offers -- Try again, Start over, Back to
 * your columns -- with the confirm the console's discard hazard calls for.
 *
 * Every recovery here discards the console's exchange for this run: the
 * run's folder is DELETEd to free the single slot, which is irreversible.
 * It acts straight through except where the run may have left an exchange
 * record standing untaken ({@link untakenRecordConfirm}), which it confirms
 * first, since that record cannot be recreated.
 *
 * `to` marks a recovery that navigates away rather than re-running in
 * place; the confirmed and unconfirmed forms land in the same place either
 * way. The confirming form sets `aria-haspopup="dialog"`, since the two
 * forms share a label and only that attribute states which one is showing.
 *
 * An open confirm outlives the state that opened it: if the record-offer
 * ask answers while the dialog is open, the dialog stays mounted and shows
 * the answer that arrived rather than closing under the operator.
 */
export function FailureRecoveryButton({
  label,
  onAct,
  to,
  recordConfirm,
}: {
  label: string;
  /** Fires once the operator has committed to the recovery -- immediately when
   * nothing is at risk, or from the confirm when something is. */
  onAct: () => void;
  /** The route the recovery navigates to, for a recovery that leaves this seat.
   * Omitted for one that acts in place. */
  to?: "/quick";
  /** The confirm this run's record offer calls for, or undefined where the
   * recovery destroys no record the seat can name or suspect. */
  recordConfirm: UntakenRecordConfirm | undefined;
}) {
  const [confirming, setConfirming] = useState(false);
  const commit = (marginTop: string | undefined) =>
    to === undefined ? (
      <Button
        color="red"
        variant="light"
        mt={marginTop}
        onClick={() => onAct()}
      >
        {label}
      </Button>
    ) : (
      <Button
        component={Link}
        to={to}
        color="red"
        variant="light"
        mt={marginTop}
        onClick={() => onAct()}
      >
        {label}
      </Button>
    );
  if (recordConfirm === undefined && !confirming) return commit("sm");
  // The dialog is open and the ask it was opened over has since answered that
  // there is no record: it closes out the interruption on that answer instead of
  // unmounting under the operator.
  const confirm = recordConfirm ?? {
    title: NO_RECORD_CONFIRM_TITLE,
    body: NO_RECORD_CONFIRM_BODY,
  };
  return (
    <>
      <Button
        color="red"
        variant="light"
        mt="sm"
        aria-haspopup="dialog"
        onClick={() => setConfirming(true)}
      >
        {label}
      </Button>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title={confirm.title}
        centered
        transitionProps={{ duration: 0 }}
      >
        <p>{confirm.body}</p>
        <Group mt="md">
          <Button variant="default" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          {commit(undefined)}
        </Group>
      </Modal>
    </>
  );
}

/**
 * The run's non-fatal warnings, accumulated in arrival order -- the
 * driver's `onWarning` slot rendered for the operator (e.g. the CLI's
 * cross-party host-key divergence notice, which must reach the console
 * operator). Not a terminal and not dismissible: it stays up through
 * completion or failure so a warning cannot be scrolled away by the run
 * finishing. Renders nothing while no warning has arrived. Messages are
 * sanitized by the owning hook at its display boundary before they reach
 * this prop.
 */
export function RunWarningsAlert({
  warnings,
}: {
  warnings: ReadonlyArray<string>;
}) {
  if (warnings.length === 0) return null;
  return (
    <Alert
      color="yellow"
      icon={<IconAlertTriangle aria-hidden />}
      title={
        warnings.length === 1
          ? "The exchange reported a warning"
          : "The exchange reported warnings"
      }
      role="status"
      mb="md"
    >
      {warnings.map((message, index) => (
        // Index keys are stable here: the list is append-only per run and
        // resets only with the whole run.
        <p key={index} style={{ whiteSpace: "pre-line", margin: 0 }}>
          {message}
        </p>
      ))}
    </Alert>
  );
}

/** The three states a re-attached run can be in, and the control-neutral
 * recovery heading each shows -- shared with the strand-recovery panel
 * ({@link ./RecoveredExchangePanel}) so the copy an operator sees when
 * re-attaching to an exchange the console already holds cannot drift
 * between the two surfaces. */
export type ReattachedRunState = "running" | "finished" | "stopped";

/**
 * The heading a re-attached run shows in place of the fresh-run title. A busy
 * (409) create at start -- a second tab, a navigate-away-and-back, or a job the
 * server created whose recovery record was lost -- means this tab did not open
 * the exchange it is now watching, so the surface names it as an exchange already
 * started from this console rather than a fresh success.
 */
export function recoveredExchangeHeading(state: ReattachedRunState): string {
  return state === "running"
    ? "An exchange started from this console is still running"
    : state === "finished"
      ? "An exchange started from this console has finished"
      : "An exchange started from this console stopped";
}

/**
 * The recovery-style lead a re-attached console run shows under its
 * heading, in place of the fresh-run share framing: it names why the
 * operator is on an exchange they did not just start, and on a
 * still-running re-attachment includes the leave-and-return reassurance the
 * fresh-run keep-open callout would have. It references no Stop/Discard
 * controls, unlike the strand-recovery panel's body -- the console run
 * column has its own (Try again, Set up another exchange) -- so it stays
 * control-neutral. `role="status"` announces the swap into recovery.
 */
export function ReattachedRunNotice({ state }: { state: ReattachedRunState }) {
  return (
    <div className={styles.callout} role="status">
      <p className={styles.calloutLead}>
        You are back on an exchange this console already holds.
      </p>
      <p className={styles.small}>
        {state === "finished"
          ? "This exchange was already running here -- from another tab or an earlier visit -- and has finished. Its results are below."
          : state === "stopped"
            ? "This exchange was already running here -- from another tab or an earlier visit -- and has stopped. The reason is below."
            : "This exchange was already running here -- from another tab or an earlier visit -- so you are watching it rather than starting a new one."}
      </p>
      {state === "running" && (
        <p className={styles.small}>
          You can leave this page -- the exchange keeps running here. Return to
          this console to pick it up or discard it.
        </p>
      )}
    </div>
  );
}

/** The heading a re-attached run shows during the brief reconnecting
 * interim, in place of the fresh-run title, so the surface never reads
 * "Your invitation is ready" while it is actually re-attaching to an
 * exchange the console already holds. */
export const RECONNECTING_HEADING = "Reconnecting to your exchange";

/**
 * The interim notice shown the moment a busy (409) create is detected,
 * before the liveness probe resolves: it stands in for the fresh-run share
 * block (which is suppressed the same instant, so it never flashes) and
 * announces (`role="status"`) that the surface is reconnecting to the
 * exchange already holding the console's slot. It gives way to the full
 * recovery view on a live probe, or to the run's alert when no live
 * exchange is found.
 */
export function ReattachingNotice() {
  return (
    <div className={styles.callout} role="status">
      <p className={styles.calloutLead}>
        Reconnecting to the exchange this console already holds...
      </p>
      <p className={styles.small}>
        This console already holds an exchange. Reconnecting so you can watch it
        here.
      </p>
    </div>
  );
}

/** The workfoot link out to a fresh exchange, shown at completion and after
 * an output failure (whose exchange already succeeded). `onNavigate` fires
 * as the operator leaves for a new exchange -- the console seat passes its
 * `abandonRun` here so a settled server-job exchange is discarded
 * (cancel-if-needed + DELETE), freeing the console's single slot for the
 * next one; the browser seat leaves it unset. It does not block the
 * navigation.
 *
 * On a server-job completion the result/record/keys exist only as console
 * endpoint hrefs, with no browser blob, so the discard is an irreversible
 * removal of data the operator may not have downloaded. `confirmBeforeLeave`
 * gates the leave behind a confirm there; a browser run keeps its results
 * in local blobs and needs none, so it stays false. */
export function AnotherExchangeFoot({
  onNavigate,
  confirmBeforeLeave = false,
}: {
  onNavigate?: () => void;
  confirmBeforeLeave?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  if (!confirmBeforeLeave)
    return (
      <div className={styles.workFoot}>
        <Button component={Link} to="/quick" onClick={() => onNavigate?.()}>
          Set up another exchange
        </Button>
      </div>
    );
  return (
    <div className={styles.workFoot}>
      <Button onClick={() => setConfirming(true)}>
        Set up another exchange
      </Button>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title="Start another exchange?"
        centered
        transitionProps={{ duration: 0 }}
      >
        <p>
          Starting another exchange removes this one&apos;s results from this
          console -- download anything you need first.
        </p>
        <Group mt="md">
          <Button variant="default" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            component={Link}
            to="/quick"
            color="red"
            variant="light"
            onClick={() => onNavigate?.()}
          >
            Set up another exchange
          </Button>
        </Group>
      </Modal>
    </div>
  );
}
