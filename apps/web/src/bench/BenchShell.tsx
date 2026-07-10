import { BenchPage } from "./BenchPage";
import styles from "./bench.module.css";

import type { ReactNode } from "react";

/**
 * The three-region working surface of the linkage bench: a section rail on the
 * left, the work column in the center, and the standing disclosure ledger on
 * the right. The work column is the page's single `<main>` landmark; the rail
 * and ledger are landmarks of their own (`<nav>` in {@link Rail}, `<aside>` in
 * {@link Ledger}). Omitting both collapses to the mockup's single-column
 * "no-rail" layout; omitting one drops just that region's grid track.
 */
export function BenchShell({
  rail,
  ledger,
  children,
}: {
  rail?: ReactNode;
  ledger?: ReactNode;
  children: ReactNode;
}) {
  const gridClass =
    rail === undefined && ledger === undefined
      ? `${styles.grid} ${styles.gridPlain}`
      : rail === undefined
        ? `${styles.grid} ${styles.gridNoRail}`
        : ledger === undefined
          ? `${styles.grid} ${styles.gridNoLedger}`
          : styles.grid;
  return (
    <BenchPage>
      <div className={gridClass}>
        {rail}
        <main className={styles.work}>{children}</main>
        {ledger}
      </div>
    </BenchPage>
  );
}
