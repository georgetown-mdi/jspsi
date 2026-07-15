import { Stepper } from "@mantine/core";

import styles from "./bench.module.css";
import { useNarrowBench } from "./narrowViewport";

import type { RailStep } from "./inviterModel";

/**
 * The Stepper's active index for {@link RailStep} steps that carry no
 * `current` entry -- the Customize tabs, where the step the operator came
 * from stays visually done rather than jumping back to current. Mirrors the
 * done-count rule except when every step is done, where the whole spine
 * should render completed rather than parking on the last step.
 */
function activeIndex(steps: ReadonlyArray<RailStep>): number {
  const current = steps.findIndex((step) => step.state === "current");
  if (current !== -1) return current;
  const doneCount = steps.filter((step) => step.state === "done").length;
  return doneCount;
}

/**
 * The bench's top-bar Stepper, rendered from a {@link RailStep} spine or
 * timeline without changing the pure model: a step is clickable exactly when
 * it is done and carries `onSelect` (the post-create timelines carry no
 * `onSelect` at all, so they render zero interactive steps regardless of
 * state). Only the model-`current` step carries `aria-current="step"`. The
 * three states read at a glance through Mantine's step indicators -- a filled
 * checkmark for done, an accent-ringed number for current (its label
 * emboldened as well), a muted number for pending.
 */
function BenchStepper({ steps }: { steps: ReadonlyArray<RailStep> }) {
  return (
    <Stepper
      size="xs"
      active={activeIndex(steps)}
      onStepClick={(index) => steps[index]?.onSelect?.()}
      classNames={{
        root: styles.topBarStepper,
        stepLabel: styles.topBarStepLabel,
      }}
    >
      {steps.map((step) => (
        <Stepper.Step
          key={step.label}
          label={step.label}
          allowStepSelect={step.state === "done" && step.onSelect !== undefined}
          aria-current={step.state === "current" ? "step" : undefined}
        />
      ))}
    </Stepper>
  );
}

/**
 * The narrow-viewport spine: the full Stepper compresses to a one-line strip
 * naming the current position ("Step 2 of 3 - Matching & sharing"), the USWDS
 * step-indicator small variant. The strip is plain text -- no step is a link
 * here -- so it never precedes the collapsible share bar as an interactive
 * element. The "N/M" badge is a decorative echo, hidden from assistive tech
 * since the sentence already carries the position.
 */
function StepStrip({ steps }: { steps: ReadonlyArray<RailStep> }) {
  // activeIndex returns steps.length when every step is done, so clamp to the
  // last real step before naming it.
  const position = Math.min(activeIndex(steps), steps.length - 1);
  const humanPosition = position + 1;
  return (
    <p className={styles.stepStrip}>
      <span>
        Step {humanPosition} of {steps.length} - {steps[position].label}
      </span>
      <span className={styles.mono} aria-hidden="true">
        {humanPosition}/{steps.length}
      </span>
    </p>
  );
}

/**
 * The bench's top bar: the wordmark, a `<nav>` landmark named by `navLabel`
 * wrapping the required-spine or protocol-timeline Stepper, and the
 * right-aligned transport note -- pure wayfinding; the optional Customize
 * surfaces live on the disclosure ledger. See {@link BenchShell}.
 *
 * At or below the narrow cut-over the Stepper compresses to a {@link
 * StepStrip}; the switch is by conditional render, not `display`, so only one
 * spine is ever in the accessibility tree.
 */
export function TopBar({
  navLabel,
  steps,
  transportNote,
}: {
  navLabel: string;
  steps: ReadonlyArray<RailStep>;
  /** The right-aligned transport note ("Browser" / "SFTP" / "Shared
   * directory"), shown once the exchange's channel is fixed. */
  transportNote?: string;
}) {
  const narrow = useNarrowBench();
  return (
    <div className={styles.topBar}>
      <div className={styles.wordmark}>psilink</div>
      <nav aria-label={navLabel} className={styles.topBarNav}>
        {narrow ? <StepStrip steps={steps} /> : <BenchStepper steps={steps} />}
      </nav>
      {transportNote !== undefined && (
        <p className={styles.topBarNote}>{transportNote}</p>
      )}
    </div>
  );
}
