import styles from "./bench.module.css";

import type { ReactNode } from "react";

/**
 * Where a rail entry stands in the exchange's progression. `current` is
 * announced to assistive tech via `aria-current="step"`; the other two are
 * conveyed by the marker styling alone.
 */
export type RailStepState = "done" | "current" | "pending";

/** One entry in a {@link RailSteps} spine or timeline list. */
export interface RailStep {
  label: string;
  state: RailStepState;
}

/**
 * One row in a {@link RailFacts} group: an optional-surface label and the
 * quiet fact summarizing its state ("3 fields", "2 keys"). An absent fact
 * renders as an em-dash; `tone` colors the fact only when the surface has been
 * edited or needs attention, per the mockup's quiet-fact rule.
 */
export interface RailFact {
  label: string;
  fact?: string;
  tone?: "edited" | "attention";
}

/**
 * The bench's left-hand section rail: wordmark, a rule, then whatever groups
 * the screen composes ({@link RailGroup} around {@link RailSteps} and
 * {@link RailFacts}). Rendered as a `<nav>` landmark named by `label`, since
 * the rail is the exchange's orientation device before creation and its
 * protocol timeline after.
 */
export function Rail({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <nav className={styles.rail} aria-label={label}>
      <div className={styles.wordmark}>psilink</div>
      <hr className={styles.wordRule} />
      {children}
    </nav>
  );
}

/** A labeled group within the {@link Rail}, with an optional quiet note. */
export function RailGroup({
  label,
  note,
  children,
}: {
  label: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <>
      <p className={styles.railGroup}>{label}</p>
      {note !== undefined && <p className={styles.railGroupNote}>{note}</p>}
      {children}
    </>
  );
}

const STEP_STATE_CLASS: Record<RailStepState, string> = {
  done: `${styles.step} ${styles.stepDone}`,
  current: `${styles.step} ${styles.stepCurrent}`,
  pending: styles.step,
};

/**
 * The rail's ordered progression list -- the required spine before creation,
 * the protocol timeline after. Exactly the current step carries
 * `aria-current="step"`.
 */
export function RailSteps({ steps }: { steps: ReadonlyArray<RailStep> }) {
  return (
    <ol className={styles.railSteps}>
      {steps.map((step) => (
        <li key={step.label} className={STEP_STATE_CLASS[step.state]}>
          <span aria-current={step.state === "current" ? "step" : undefined}>
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

const FACT_TONE_CLASS = {
  edited: `${styles.val} ${styles.valEdited}`,
  attention: `${styles.val} ${styles.valAttention}`,
} as const;

/**
 * The rail's optional-surface group: each row pairs a label with the quiet
 * fact describing that surface's state, an em-dash when it has none.
 */
export function RailFacts({ facts }: { facts: ReadonlyArray<RailFact> }) {
  return (
    <ul className={styles.railFacts}>
      {facts.map((entry) => (
        <li key={entry.label}>
          <span>{entry.label}</span>
          <span
            className={
              entry.tone === undefined
                ? styles.val
                : FACT_TONE_CLASS[entry.tone]
            }
          >
            {entry.fact ?? "\u2014"}
          </span>
        </li>
      ))}
    </ul>
  );
}
