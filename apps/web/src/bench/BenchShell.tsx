import { BenchPage } from "./BenchPage";
import styles from "./bench.module.css";
import { useNarrowBench } from "./narrowViewport";

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
 *
 * At or below the narrow cut-over the ledger is placed AHEAD of the work
 * column in the DOM, so its collapsible share bar (see {@link Ledger}) is the
 * page's first interactive element -- a focus/DOM-order commitment CSS
 * reordering alone cannot make.
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
  const narrow = useNarrowBench();
  // gridUnderBar raises the ledger's sticky offset above the stuck top bar;
  // a ledger with no bar (a generic layout this shell permits even though no
  // current bench composes it) keeps the plain offset.
  const gridClass =
    topBar === undefined && ledger === undefined
      ? `${styles.grid} ${styles.gridPlain}`
      : ledger === undefined
        ? styles.grid
        : topBar === undefined
          ? `${styles.grid} ${styles.gridLedger}`
          : `${styles.grid} ${styles.gridLedger} ${styles.gridUnderBar}`;
  const work = <main className={styles.work}>{children}</main>;
  return (
    <BenchPage>
      {topBar}
      <div className={gridClass}>
        {narrow && ledger !== undefined ? (
          <>
            {ledger}
            {work}
          </>
        ) : (
          <>
            {work}
            {ledger}
          </>
        )}
      </div>
    </BenchPage>
  );
}
