import { BenchPage } from "./BenchPage";
import styles from "./bench.module.css";

import type { ReactNode } from "react";

/**
 * The linkage bench's working surface: a full-width top bar above a two-region
 * grid, the work column in the center and the standing disclosure ledger on
 * the right. The work column is the page's single `<main>` landmark; the
 * ledger is a landmark of its own (`<aside>` in {@link Ledger}), as is the
 * top bar's Stepper nav (see {@link TopBar}). Omitting both `topBar` and
 * `ledger` collapses to the single-column "plain" layout {@link
 * VerifyReceiptBench} uses; omitting only the ledger keeps the work column
 * alone under the top bar.
 */
export function BenchShell({
  topBar,
  ledger,
  children,
}: {
  topBar?: ReactNode;
  ledger?: ReactNode;
  children: ReactNode;
}) {
  const gridClass =
    topBar === undefined && ledger === undefined
      ? `${styles.grid} ${styles.gridPlain}`
      : ledger === undefined
        ? styles.grid
        : `${styles.grid} ${styles.gridLedger}`;
  return (
    <BenchPage>
      {topBar}
      <div className={gridClass}>
        <main className={styles.work}>{children}</main>
        {ledger}
      </div>
    </BenchPage>
  );
}
