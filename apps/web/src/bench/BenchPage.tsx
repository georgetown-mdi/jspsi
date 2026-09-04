import "./tokens.css";
import styles from "./bench.module.css";

import type { ReactNode } from "react";

/**
 * The full-height page surface every bench route renders on: the background,
 * text color, and base type scale of the linkage bench design. It is the
 * outermost bench element and declares no landmark -- the single `<main>` is in
 * {@link BenchShell}'s work column or a route's own lobby layout.
 */
export function BenchPage({ children }: { children: ReactNode }) {
  return <div className={styles.page}>{children}</div>;
}
