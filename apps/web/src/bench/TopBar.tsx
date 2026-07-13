import { Button, Menu, Stepper } from "@mantine/core";

import styles from "./bench.module.css";

import type { RailFact, RailStep } from "./inviterModel";

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
 * state). Only the model-`current` step carries `aria-current="step"`.
 */
function BenchStepper({ steps }: { steps: ReadonlyArray<RailStep> }) {
  return (
    <Stepper
      size="xs"
      active={activeIndex(steps)}
      onStepClick={(index) => steps[index]?.onSelect?.()}
      classNames={{ root: styles.topBarStepper }}
    >
      {steps.map((step) => (
        <Stepper.Step
          key={step.label}
          label={step.label}
          withIcon={false}
          allowStepSelect={step.state === "done" && step.onSelect !== undefined}
          aria-current={step.state === "current" ? "step" : undefined}
        />
      ))}
    </Stepper>
  );
}

/** One row of the Customize dropdown: the surface's label on the left, its
 * quiet fact on the right, in the tone the model chose. */
function CustomizeMenuItem({ entry }: { entry: RailFact }) {
  return (
    <Menu.Item
      disabled={entry.onSelect === undefined}
      onClick={entry.onSelect}
      aria-current={entry.current === true ? "true" : undefined}
      rightSection={
        <span
          className={
            entry.tone === undefined
              ? styles.val
              : entry.tone === "edited"
                ? `${styles.val} ${styles.valEdited}`
                : `${styles.val} ${styles.valAttention}`
          }
        >
          {entry.fact ?? "\u2014"}
        </span>
      }
    >
      {entry.label}
    </Menu.Item>
  );
}

/**
 * The optional-surfaces dropdown next to the Stepper: a muted "Customize"
 * button whose menu lists each {@link RailFact}, so the surfaces read as
 * optional next to the required spine. `note`, when given, is the group's
 * standing hint ("Filled in from your file."); an open Customize tab marks
 * both its menu item (`aria-current="true"`) and the button itself.
 */
function CustomizeMenu({
  note,
  facts,
}: {
  note?: string;
  facts: ReadonlyArray<RailFact>;
}) {
  const open = facts.some((entry) => entry.current === true);
  return (
    <Menu position="bottom-start" withinPortal>
      <Menu.Target>
        <Button
          variant={open ? "light" : "default"}
          size="xs"
          aria-current={open ? "true" : undefined}
        >
          Customize
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        {note !== undefined && <Menu.Label>{note}</Menu.Label>}
        {facts.map((entry) => (
          <CustomizeMenuItem key={entry.label} entry={entry} />
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}

/**
 * The bench's top bar: the wordmark, a `<nav>` landmark named by `navLabel`
 * wrapping the required-spine or protocol-timeline Stepper, the optional
 * Customize dropdown (when the phase has one), and the right-aligned
 * transport note. See {@link BenchShell}.
 */
export function TopBar({
  navLabel,
  steps,
  customize,
  transportNote,
}: {
  navLabel: string;
  steps: ReadonlyArray<RailStep>;
  /** The Customize dropdown's contents; omitted in sealed/inapplicable
   * phases (share, save, launched), which show no Customize control. */
  customize?: { note?: string; facts: ReadonlyArray<RailFact> };
  /** The right-aligned transport note ("Browser" / "SFTP" / "Shared
   * directory"), shown once the exchange's channel is fixed. */
  transportNote?: string;
}) {
  return (
    <div className={styles.topBar}>
      <div className={styles.wordmark}>psilink</div>
      <nav aria-label={navLabel} className={styles.topBarNav}>
        <BenchStepper steps={steps} />
      </nav>
      {customize !== undefined && (
        <CustomizeMenu note={customize.note} facts={customize.facts} />
      )}
      {transportNote !== undefined && (
        <p className={styles.topBarNote}>{transportNote}</p>
      )}
    </div>
  );
}
