import styles from "./bench.module.css";

import type { ReactNode } from "react";

/**
 * One row of the disclosure ledger: an uppercase label, the value in the
 * bench's monospace data voice, and an optional reference to the spine step
 * that owns the value ("Step 2"). `muted` is the named empty state ("None",
 * "Nothing - matching only"), rendered in the placeholder voice; with neither
 * the row shows the em-dash "not decided yet" mark.
 */
export interface LedgerRow {
  label: string;
  value?: ReactNode;
  muted?: string;
  reference?: string;
}

/**
 * The standing disclosure ledger on the bench's right: always visible,
 * filling in as the exchange takes shape -- the running answer to "what leaves
 * this machine". Rendered as an `<aside>` landmark named by its title.
 */
export function Ledger({
  title = "This exchange",
  tag,
  rows,
  footer,
}: {
  title?: string;
  /** A standing state marker under the title -- "Terms locked when the
   * invitation was created" once the invitation is minted and the ledger
   * stops being editable. */
  tag?: string;
  rows: ReadonlyArray<LedgerRow>;
  footer?: ReactNode;
}) {
  return (
    <aside className={styles.ledger} aria-label={title}>
      <h2>{title}</h2>
      {tag !== undefined && <span className={styles.sealedTag}>{tag}</span>}
      <dl>
        {rows.map((row) => (
          <div key={row.label} className={styles.ledgerRow}>
            <dt>
              {row.label}
              {row.reference !== undefined && (
                <span className={styles.ledgerRef}>{row.reference}</span>
              )}
            </dt>
            <dd>
              {row.value ?? (
                <span className={styles.dash}>{row.muted ?? "\u2014"}</span>
              )}
            </dd>
          </div>
        ))}
      </dl>
      {footer !== undefined && <p className={styles.trust}>{footer}</p>}
    </aside>
  );
}
