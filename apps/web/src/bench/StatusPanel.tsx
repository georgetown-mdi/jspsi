import {
  currentStageLabel,
  progressPercent,
  timeOfDayLabel,
} from "./exchangeRun";
import styles from "./bench.module.css";

import type { ExchangeRun } from "./exchangeRun";

/**
 * The run's status panel: the live stage label, the protocol progress bar, and
 * the visited-stage history with completion times. Rendered through every
 * post-create phase from one stable mount, so the polite live region around
 * the stage label persists and each stage change (including the final "Done")
 * is announced -- a region replaced with its phase would announce nothing.
 * At completion (`done`) the panel drops its frame and history and keeps just
 * the label and the filled bar, per the design; while `halted` (the run
 * failed) the spinner stops presenting the open stage as in flight and the
 * adjacent alert carries the state.
 */
export function StatusPanel({
  run,
  done,
  halted,
}: {
  run: ExchangeRun;
  done: boolean;
  halted: boolean;
}) {
  const percent = progressPercent(run);
  const lastVisit = run.visits[run.visits.length - 1];
  return (
    <section
      className={
        done
          ? `${styles.statusPanel} ${styles.statusPanelDone}`
          : styles.statusPanel
      }
      aria-label="Status"
    >
      {!done && <h2>Status</h2>}
      <p className={styles.stageLabel}>
        {!done && !halted && (
          <span className={styles.spinner} aria-hidden="true" />
        )}
        <span className={styles.mono} aria-live="polite" aria-atomic="true">
          {currentStageLabel(run)}
        </span>
      </p>
      <div
        className={
          done
            ? `${styles.progress} ${styles.progressDone}`
            : halted
              ? `${styles.progress} ${styles.progressHalted}`
              : styles.progress
        }
        role="progressbar"
        aria-label="Exchange progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className={styles.progressBar} style={{ width: `${percent}%` }} />
      </div>
      {!done && (
        <ol className={styles.stageHistory}>
          {run.visits.map((visit) => (
            <li
              key={visit.id}
              className={
                visit === lastVisit && visit.completedAt === undefined
                  ? styles.historyNow
                  : undefined
              }
            >
              <span className={styles.tick} aria-hidden="true" />
              <span>
                {visit.label}
                {visit.completedAt !== undefined && (
                  <>
                    {" - done "}
                    <span className={styles.mono}>
                      {timeOfDayLabel(visit.completedAt)}
                    </span>
                  </>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
