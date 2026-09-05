/**
 * The shapes a screen's step spine renders from: the step, the quiet fact
 * beside an optional surface, and the entry in the work column's Problems
 * block. Types only -- each product builds its own rows.
 */

/**
 * Where a step stands in the exchange's progression, rendered by the console's
 * top-bar Stepper. `current` is announced to assistive tech via
 * `aria-current="step"`; the other two are conveyed by the Stepper's own
 * completed/inactive styling.
 */
export type RailStepState = "done" | "current" | "pending";

/** One entry in a step spine or timeline list, rendered as a Mantine
 * Stepper.Step. A completed step with `onSelect` is clickable, per the
 * design's done-steps-are-links rule; the current and pending steps are not. */
export interface RailStep {
  label: string;
  state: RailStepState;
  onSelect?: () => void;
}

/**
 * One row in the Customize menu: an optional-surface label and the quiet
 * fact summarizing its state ("3 fields", "2 keys"). An absent fact renders
 * as an em-dash; `tone` colors the fact only when the surface has been
 * edited or needs attention. With `onSelect` the row opens that surface;
 * `current` marks the open tab.
 */
export interface RailFact {
  label: string;
  fact?: string;
  tone?: "edited" | "attention";
  onSelect?: () => void;
  current?: boolean;
}

/** One entry in the work column's Problems block. `key` is the render key when
 * labels may repeat; absent, the label is the key. */
export interface RailProblem {
  label: string;
  key?: string;
  onSelect?: () => void;
}
