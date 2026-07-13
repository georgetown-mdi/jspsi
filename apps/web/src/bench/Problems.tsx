import styles from "./bench.module.css";

import type { RailProblem } from "./inviterModel";

/**
 * The work column's Problems block -- the design's error summary: it appears
 * only when something actually needs attention, at the top of the work
 * column, and each entry links into the surface that can fix it.
 */
export function Problems({
  problems,
}: {
  problems: ReadonlyArray<RailProblem>;
}) {
  if (problems.length === 0) return null;
  return (
    <section className={styles.problems} aria-label="Problems">
      <h2>Problems</h2>
      <ul>
        {problems.map((problem) => (
          <li key={problem.label}>
            {problem.onSelect !== undefined ? (
              <button
                type="button"
                className={styles.stepLink}
                onClick={problem.onSelect}
              >
                {problem.label}
              </button>
            ) : (
              problem.label
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
