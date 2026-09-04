import "./tokens.css";
import styles from "./bench.module.css";

import type { ReactNode } from "react";

/**
 * The full-height page surface every console route renders on: the background,
 * text color, and base type scale of the linkage console design. It is the
 * outermost console element and declares no landmark -- the single `<main>` is in
 * {@link BenchShell}'s work column or a route's own lobby layout.
 */
export function BenchPage({ children }: { children: ReactNode }) {
  return <div className={styles.page}>{children}</div>;
}
