/**
 * The one copy for a linkage-strategy authoring control, shared by the two
 * surfaces that offer the choice: the invitation flow's key editor
 * ({@link ../bench/KeysTab}) and the console's Direct-exchange confirm screen
 * ({@link ../bench/DirectConfirmSection}).
 *
 * Separate for the same reason as {@link ./identityLabel}: the disclosure note
 * is the consent-critical half of the choice -- the browser's wording of the
 * CLI's own `singlePassDisclosureNotice`, which the partner reads again on the
 * terms panel -- so both surfaces must state it in the same words.
 */

import type { LinkageStrategy } from "@psilink/core";

/** The label the choice is offered under, matching the caption the terms panel
 * shows the selected value beside. */
export const LINKAGE_STRATEGY_LABEL = "Linkage strategy";

/** What each strategy does, as the option's own description. Keyed by the schema
 * enum so a strategy added to core leaves this incomplete at the type level. */
export const LINKAGE_STRATEGY_OPTION_COPY: Record<
  LinkageStrategy,
  { label: string; description: string }
> = {
  cascade: {
    label: "Cascade",
    description:
      "Keys run in order; a record matched by an earlier key is settled and " +
      "never re-exposed to later, broader keys.",
  },
  "single-pass": {
    label: "Single-pass",
    description: "All keys run over all records at once.",
  },
};

/** The disclosure note's heading, shown when single-pass is selected. */
export const SINGLE_PASS_DISCLOSURE_TITLE =
  "Single-pass widens what one of you can observe";

/** The disclosure note itself: what single-pass costs, in the browser's voice
 * for the tradeoff the CLI prints at selection and the partner sees at consent. */
export const SINGLE_PASS_DISCLOSURE_BODY =
  "Every record meets every key, so the receiving side observes matches on " +
  "weaker keys that the cascade would have filtered out. The linked output " +
  "file is identical either way; the difference is what a partner can observe " +
  "while matching runs. Choose it only when both of you accept that.";
