import { useEffect, useRef } from "react";

import { Alert, Button, CopyButton } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { dateTimeLabel } from "./inviterModel";
import styles from "./bench.module.css";

import type { ReactNode } from "react";
import type { RunFailure } from "./useInviterExchange";

/**
 * A labelled, copy-to-clipboard view of one shareable artifact -- the invitation
 * link/code on the share screen and the save surface. Client-only by
 * construction (both surfaces mount from a handler, so neither server-renders);
 * the `typeof navigator` check is defence-in-depth and hides the button on
 * non-secure origins, where `navigator.clipboard` is undefined -- the text
 * itself stays selectable for a manual copy.
 */
export function CopyRow({
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

/** The workfoot link out to a fresh exchange, shown at completion and after an
 * output failure (whose exchange already succeeded). */
export function AnotherExchangeFoot() {
  return (
    <div className={styles.workFoot}>
      <Button component={Link} to="/">
        Set up another exchange
      </Button>
    </div>
  );
}
