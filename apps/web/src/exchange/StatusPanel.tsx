import { useEffect, useState } from "react";

import styles from "@styles/app.module.css";

import {
  currentStageLabel,
  progressPercent,
  psiProgressLabel,
  stageIsKnown,
  timeOfDayLabel,
} from "./exchangeRun";

import type { ExchangeRun } from "./exchangeRun";

/** How often the running operation's elapsed figure is redrawn. A second is the
 * resolution the figure itself is stated at, so a shorter interval would redraw
 * the same text. */
const PSI_ELAPSED_TICK_MS = 1000;

/** The clock the running operation's elapsed figure is read against: a fresh
 * reading each second while an operation runs, and no timer at all when none
 * does. Re-read at the start of each operation so the first line a long one
 * draws is its own elapsed time rather than the previous one's. */
function useElapsedClock(run: ExchangeRun): Date {
  const startedAtMs = run.psiOperation?.startedAt.getTime();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (startedAtMs === undefined) return;
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), PSI_ELAPSED_TICK_MS);
    return () => clearInterval(timer);
  }, [startedAtMs]);
  return now;
}

/**
 * The run's status panel: the live stage label, the protocol progress bar, and
 * the visited-stage history with completion times. Rendered through every
 * post-create phase from one stable mount, so the polite live region around
 * the stage label persists and each stage change (including the final "Done")
 * is announced -- a region replaced with its phase would announce nothing.
 * At completion (`done`) the panel drops its frame and history and keeps just
 * the label and the filled bar; while `halted` (the run failed) the spinner
 * stops showing the open stage as in flight and the adjacent alert states it.
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
  const elapsedClock = useElapsedClock(run);
  const progress = psiProgressLabel(run, elapsedClock);
  // runExchange emits stage ids from the same prepared exchange the tree was built
  // from, or from the single-pass set the run model labels, so anything else is a
  // desync bug. This is a development-only signal, not a guarantee: a production
  // render degrades instead, taking the raw id as the label and holding the bar at
  // the last known stage.
  if (import.meta.env.DEV && !stageIsKnown(run, run.stageId))
    console.warn(`StatusPanel: unknown stageId "${run.stageId}"`);
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
      {progress !== undefined && !done && !halted && (
        // Outside the live region above: this line restates its figures every
        // second, and a region announcing it would talk over everything else a
        // screen reader is reading. The stage label it sits under is announced,
        // and it is read on demand like any other text.
        <p className={styles.psiProgress}>{progress}</p>
      )}
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
