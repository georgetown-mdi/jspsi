import styles from "./bench.module.css";

import type { RailFact } from "./inviterModel";
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

const FACT_TONE_CLASS = {
  edited: `${styles.val} ${styles.valEdited}`,
  attention: `${styles.val} ${styles.valAttention}`,
} as const;

/** A Customize row's quiet fact: the em-dash "nothing yet" mark when absent,
 * the model's tone color when present. The fact is plain text inside the row,
 * so an attention state is never conveyed by color alone. */
function CustomizeFactValue({ entry }: { entry: RailFact }) {
  return (
    <span
      className={
        entry.tone === undefined ? styles.val : FACT_TONE_CLASS[entry.tone]
      }
    >
      {entry.fact ?? "\u2014"}
    </span>
  );
}

/**
 * The ledger's Customize group, shown only while the terms are editable: one
 * plain button per optional surface (normal tab order, no menu semantics),
 * pairing the surface's label with its quiet fact. The open tab's row carries
 * `aria-current="true"` and the accent style; a surface not yet reachable
 * (no file read) renders its row disabled.
 */
function LedgerCustomize({ facts }: { facts: ReadonlyArray<RailFact> }) {
  return (
    <div className={styles.ledgerCustomize}>
      <p className={styles.ledgerGroupLabel}>Customize</p>
      <ul>
        {facts.map((entry) => (
          <li key={entry.label}>
            <button
              type="button"
              className={styles.customizeRow}
              disabled={entry.onSelect === undefined}
              onClick={entry.onSelect}
              aria-current={entry.current === true ? "true" : undefined}
            >
              <span
                className={
                  entry.current === true ? styles.customizeCurrent : undefined
                }
              >
                {entry.label}
              </span>
              <CustomizeFactValue entry={entry} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The standing disclosure ledger on the bench's right: always visible,
 * filling in as the exchange takes shape -- the running answer to "what leaves
 * this machine". Rendered as an `<aside>` landmark named by its title. While
 * the terms are editable it also hosts the Customize group's surface rows
 * ({@link LedgerCustomize}); the hosting bench withholds `customize` once the
 * terms seal or the run launches.
 */
export function Ledger({
  title = "This exchange",
  tag,
  rows,
  customize,
  footer,
}: {
  title?: string;
  /** A standing state marker under the title -- "Terms locked when the
   * invitation was created" once the invitation is minted and the ledger
   * stops being editable. */
  tag?: string;
  rows: ReadonlyArray<LedgerRow>;
  /** The optional surfaces' Customize rows; absent once the terms seal (the
   * share/save/launched phases). */
  customize?: ReadonlyArray<RailFact>;
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
      {customize !== undefined && <LedgerCustomize facts={customize} />}
      {footer !== undefined && <p className={styles.trust}>{footer}</p>}
    </aside>
  );
}
