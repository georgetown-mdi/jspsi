import { useEffect, useRef } from "react";

import { Alert, Button, CopyButton } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { awaitingPartner } from "./exchangeRun";
import { dateTimeLabel } from "./inviterModel";

import { StatusPanel } from "./StatusPanel";
import styles from "./bench.module.css";

import type { InviterRunOutputs, RunFailure } from "./useInviterExchange";

import type { ExchangeRun } from "./exchangeRun";
import type { GeneratedInvitation } from "@psi/invitation";

/** A labelled, copy-to-clipboard view of one shareable artifact. Client-only
 * by construction (the post-create section mounts from the create handler, so
 * it never server-renders); the `typeof navigator` check is defence-in-depth
 * and hides the button on non-secure origins, where `navigator.clipboard` is
 * undefined -- the text itself stays selectable for a manual copy. */
function CopyRow({
  label,
  hint,
  value,
}: {
  label: string;
  hint: string;
  value: string;
}) {
  return (
    <div className={styles.copyRow}>
      <span className={styles.copyLabel}>{label}</span>
      <span className={styles.copyHint}>{hint}</span>
      <div className={styles.copyBox}>
        <div className={`${styles.codeBlock} ${styles.mono}`}>{value}</div>
        {
          // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
          typeof navigator !== "undefined" && navigator.clipboard ? (
            <CopyButton value={value} timeout={1000}>
              {({ copied, copy }) => (
                <Button
                  className={styles.copyBtn}
                  variant="default"
                  onClick={copy}
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
    </div>
  );
}

function DownloadRow({
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
      {/* The accessible name carries the caveat as well as the filename: the
          caveat is part of what the operator agrees to by downloading, so a
          screen reader browsing links must hear it, not only the filename. */}
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
 * The inviter's post-create work column, through the run's three phases: the
 * share screen (copy artifacts, one-time-secret guidance, expiry) while the
 * browser listens for the partner, the running screen once a protocol stage
 * begins, and the completion panel with the downloads and their caveats. The
 * status panel spans all three from one stable mount so its live region
 * persists. A failed run renders the failure vocabulary's alert for its
 * category, each with its one concrete way forward; no failure clears what
 * the operator authored.
 */
export function InviterExchangeSection({
  invitation,
  run,
  outputs,
  failure,
  onTryAgain,
  onStartOver,
}: {
  invitation: GeneratedInvitation;
  run: ExchangeRun;
  outputs: InviterRunOutputs | undefined;
  failure: RunFailure | undefined;
  onTryAgain: () => void;
  onStartOver: () => void;
}) {
  const phase =
    outputs !== undefined ? "done" : awaitingPartner(run) ? "share" : "running";

  // The phase-level focus throughline. The bench host moves focus to the h1
  // when the section mounts; within the section, focus moves again when the
  // partner connects or a retry clears the alert -- the share block or the
  // alert (either of which may hold focus, on a copy button or the Try again
  // button) unmounts, so without this the browser drops focus to <body> --
  // and at completion, so the results are read. The recovery moves fire only
  // when focus was actually orphaned onto <body>, so focus the user placed on
  // a live element is not stolen; completion always moves it. While a failure
  // is showing, the alert-focus effect below owns the moment.
  const headingRef = useRef<HTMLHeadingElement>(null);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (phase === "done") {
      headingRef.current?.focus();
      return;
    }
    if (failure !== undefined) return;
    const active = document.activeElement;
    if (!active || active === document.body) headingRef.current?.focus();
  }, [phase, failure]);

  // A failure alert receives focus when it appears, so the message is read
  // before anything else. Failure and completion are mutually exclusive (a
  // failed run never reaches `done`), so the two effects cannot fight.
  const alertRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (failure !== undefined) alertRef.current?.focus();
  }, [failure]);

  const title =
    phase === "done"
      ? "Exchange complete"
      : phase === "running"
        ? "Exchange in progress"
        : "Your invitation is ready";

  return (
    <>
      <h1 tabIndex={-1} ref={headingRef}>
        {title}
      </h1>
      {failure !== undefined && (
        <Alert
          color="red"
          icon={<IconAlertCircle aria-hidden />}
          title={failure.title}
          ref={alertRef}
          tabIndex={-1}
          mb="md"
        >
          <span style={{ whiteSpace: "pre-line" }}>{failure.message}</span>
          {failure.category === "exchange" && (
            <Button color="red" variant="light" mt="sm" onClick={onTryAgain}>
              Try again
            </Button>
          )}
          {(failure.category === "security" ||
            failure.category === "config") && (
            <Button color="red" variant="light" mt="sm" onClick={onStartOver}>
              Start over with a fresh invitation
            </Button>
          )}
        </Alert>
      )}
      {/* The share block drops out once the partner connects (nothing left to
          share) and on a security failure (a link that failed authentication
          must not keep being advertised for copying); a retryable failure
          keeps it, since the same link stays valid for another attempt. */}
      {phase === "share" && failure?.category !== "security" && (
        <>
          <h2>Share this invitation</h2>
          <p>
            Send one of these to your partner over a trusted channel (for
            example, secure email). It carries a one-time secret, so treat it as
            confidential. Keep this tab open while your partner accepts.
          </p>
          <CopyRow
            label="Invitation link"
            hint="Opens the accept page with the invitation prefilled"
            value={invitation.deepLink}
          />
          <CopyRow
            label="Invitation code"
            hint="Paste into the accept form if the link cannot be used"
            value={invitation.encoded}
          />
          <p className={styles.small}>
            <strong>
              This invitation expires{" "}
              <span className={styles.mono}>
                {dateTimeLabel(new Date(invitation.expires))}
              </span>
              .
            </strong>
          </p>
          <div className={styles.callout}>
            <p className={styles.calloutLead}>Keep this tab open.</p>
            <p className={styles.small}>
              Your browser is listening for your partner. Closing the tab
              cancels the invitation; reloading starts over.
            </p>
          </div>
        </>
      )}
      {phase === "done" && (
        <div className={styles.donePanel}>
          <p className={styles.bigCount}>
            Exchange complete
            {outputs?.matchedRecordCount !== undefined && (
              <>
                {" - "}
                <span className={styles.mono}>
                  {new Intl.NumberFormat("en-US").format(
                    outputs.matchedRecordCount,
                  )}
                </span>{" "}
                matched records
              </>
            )}
          </p>
          {run.finishedAt !== undefined && (
            <p className={`${styles.small} ${styles.sub} ${styles.mono}`}>
              Finished {dateTimeLabel(run.finishedAt)}
            </p>
          )}
        </div>
      )}
      <StatusPanel
        run={run}
        done={phase === "done"}
        halted={failure !== undefined}
      />
      {phase === "done" && outputs !== undefined && (
        <>
          <h2>Downloads</h2>
          {outputs.resultWithheld === true ? (
            <div className={styles.stateInset}>
              <p className={styles.stateLabel}>Results withheld by the terms</p>
              <p className={styles.small} style={{ margin: 0 }}>
                Your records contributed to the match. By the agreed terms, you
                receive no result table, so there is nothing to download here.
              </p>
            </div>
          ) : (
            <DownloadRow
              label="Download result"
              href={outputs.resultsUrl}
              fileName="results.csv"
            />
          )}
          {outputs.record !== undefined && (
            <>
              <DownloadRow
                label="Download record (safe to share)"
                href={outputs.record.recordUrl}
                fileName={outputs.record.recordFileName}
              />
              <DownloadRow
                label="Download verification keys"
                caveat="keep private"
                href={outputs.record.keysUrl}
                fileName={outputs.record.keysFileName}
              />
              <div className={styles.callout}>
                <p className={styles.calloutLead}>Keep a record.</p>
                <p className={styles.small}>
                  File the record JSON with your project documentation - it is
                  safe to share and lets either party verify this run later. The
                  verification keys prove the record came from this exchange;
                  store them where only you can read them.
                </p>
              </div>
            </>
          )}
        </>
      )}
      {(phase === "done" || failure?.category === "output") && (
        <div className={styles.workFoot}>
          <Button component={Link} to="/bench">
            Set up another exchange
          </Button>
        </div>
      )}
    </>
  );
}
