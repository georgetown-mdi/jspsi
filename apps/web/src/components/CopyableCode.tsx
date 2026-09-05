import { Button, CopyButton } from "@mantine/core";

import styles from "@styles/app.module.css";

/**
 * A preformatted, copyable block: the configuration or command shown whole (with
 * horizontal scroll for long lines) beside a copy button. Every handoff surface
 * that gives an operator something to paste at a command line uses this one.
 *
 * The clipboard check covers a non-secure origin, where the block is still
 * selectable by hand.
 */
export function CopyableCode({
  code,
  ariaLabel,
}: {
  code: string;
  /** What the block holds, named for the copy button's accessible label. */
  ariaLabel: string;
}) {
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
