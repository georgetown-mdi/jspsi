import { useEffect, useRef, useState } from "react";

import { Alert, Button, CopyButton, Group, Modal } from "@mantine/core";
import { IconAlertCircle, IconAlertTriangle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { DEFAULT_PEER_TIMEOUT_MS } from "@psilink/core";

import { dateTimeLabel } from "./inviterModel";
import styles from "./bench.module.css";

import type { ReactNode } from "react";
import type { RunFailure } from "./useInviterExchange";

/**
 * The keep-open callout body for a run the console appliance conducts on the
 * operator's behalf (a server-job run): the appliance runs the exchange, so
 * leaving the page leaves it running -- the console re-attaches to it (or discards
 * it) on return, rather than losing it. Shared by both seats' run columns so the
 * two cannot drift.
 */
export const SERVER_JOB_KEEP_OPEN_BODY =
  "This appliance is running the exchange. If you leave this page the run " +
  "continues here; return to this console to pick it up or discard it.";

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
 * both consoles running their halves at once, and the appliance waits only about
 * the peer-timeout window before it stops. Its duration is derived from core's
 * `DEFAULT_PEER_TIMEOUT_MS` so the copy cannot drift from the CLI default. The
 * console never sets `peerTimeoutMs`, so this is the window every console-composed
 * exchange actually runs under.
 */
export const SERVER_JOB_PEER_WINDOW_BODY =
  "Your partner's console must run its half while yours is running. This " +
  `appliance waits about ${peerWindowDurationPhrase(DEFAULT_PEER_TIMEOUT_MS)} ` +
  "for the partner before the exchange stops; if it stops, coordinate a time " +
  "and run it again.";

const PREVIEW_EDGE_CHARS = 8;
const COPY_STATUS_CLEAR_MS = 2000;

/**
 * The short preview of a copy-only artifact: the secret's first and last
 * {@link PREVIEW_EDGE_CHARS} characters around an ellipsis, with a deep link's
 * origin-and-route head (everything through the first `#`, mirroring
 * `tokenFromInput`'s split) rendered in full. Built by slicing the string --
 * never CSS truncation over the full value, which would still hand the whole
 * secret to screen readers and select-all. A value too short to elide renders
 * whole.
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
 * A labelled, copy-to-clipboard view of one shareable artifact -- the invitation
 * link/code on the share screen and the save surface. The DOM carries only a
 * head/tail preview of the value; the Copy button puts the full value on the
 * clipboard (announced through a polite status region), and a disclosure
 * toggle expands an in-place readonly textarea holding the full value for the
 * cases where the clipboard cannot be used. The reveal never persists: a fresh
 * mount is collapsed. Client-only by construction (both surfaces mount from a
 * handler, so neither server-renders); the `typeof navigator` check is
 * defence-in-depth and hides the button on non-secure origins, where
 * `navigator.clipboard` is undefined -- the reveal remains for a manual copy.
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
 * The role-neutral run/completion furniture shared by both bench seats' run
 * columns: the download rows, the completion panel, the withheld-result inset,
 * the failure alert block, and the "set up another exchange" workfoot. Each
 * inviter-rendered output is preserved byte for byte -- the inviter section
 * composes these, the acceptor section composes the same pieces with its own
 * vocabulary. Nothing here is role-aware; the calling section decides which
 * downloads exist, what the failure recoveries are, and what the panel says.
 */

/** A labelled download link. The accessible name carries the caveat as well as
 * the filename: the caveat is part of what the operator agrees to by
 * downloading, so a screen reader browsing links must hear it, not only the
 * filename. */
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

/** The completion panel: the big "Exchange complete" line with the matched-row
 * count when one exists, and the finished-at timestamp. */
export function DonePanel({
  matchedRecordCount,
  finishedAt,
}: {
  matchedRecordCount: number | undefined;
  finishedAt: Date | undefined;
}) {
  return (
    <div className={styles.donePanel}>
      <p className={styles.bigCount}>
        Exchange complete
        {matchedRecordCount !== undefined && (
          <>
            {" - "}
            <span className={styles.mono}>
              {new Intl.NumberFormat("en-US").format(matchedRecordCount)}
            </span>{" "}
            matched records
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
export function WithheldResultInset() {
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
      <span style={{ whiteSpace: "pre-line" }}>{failure.message}</span>
      {children}
    </Alert>
  );
}

/**
 * The run's non-fatal warnings, accumulated in arrival order -- the driver's
 * `onWarning` slot rendered for the operator (e.g. the CLI's cross-party
 * host-key divergence notice, which must reach the appliance operator). Not a
 * terminal and not dismissible: it stays up through completion or failure so a
 * warning cannot be scrolled away by the run finishing. Renders nothing while
 * no warning has arrived. Messages are sanitized by the owning hook at its
 * display boundary before they reach this prop.
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

/** The workfoot link out to a fresh exchange, shown at completion and after an
 * output failure (whose exchange already succeeded). `onNavigate` fires as the
 * operator leaves for a new exchange -- the console seat passes its `abandonRun`
 * here so a settled server-job exchange is discarded (cancel-if-needed + DELETE),
 * freeing the appliance's single slot for the next one; the browser seat leaves
 * it unset. It does not block the navigation.
 *
 * On a server-job completion the result/record/keys exist only as appliance
 * endpoint hrefs -- there is no browser blob -- so the discard is an irreversible
 * removal of data the operator may not have downloaded. `confirmBeforeLeave` gates
 * the leave behind a confirm there; a browser run keeps its results in local blobs
 * and needs none, so it stays false and navigates straight through. */
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
          appliance -- download anything you need first.
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
