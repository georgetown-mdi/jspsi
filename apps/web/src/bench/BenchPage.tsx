import "./tokens.css";
import styles from "./bench.module.css";

import type { ReactNode } from "react";

/**
 * The full-height page surface every bench route renders on: the warm paper
 * ground, ink text color, and base type scale of the linkage bench design.
 * This is the outermost bench element; it carries no landmark -- the single
 * `<main>` lives in {@link BenchShell}'s work column or a route's own lobby
 * layout.
 */
export function BenchPage({ children }: { children: ReactNode }) {
  return <div className={styles.page}>{children}</div>;
}
