import { ownResultColumnNames } from "@psilink/core";

import type {
  Algorithm,
  Metadata,
  Output,
  OwnColumnSelection,
} from "@psilink/core";

/**
 * The pure model behind the authoring surface's "Your own columns in the
 * result" control: the three states the operator chooses between, whether the
 * exchange being authored can act on the choice at all, and the config field
 * the choice contributes. No React and no I/O.
 *
 * The setting is LOCAL. It selects which of this party's own input columns its
 * OWN result file holds beside the partner's values (core's
 * `include_own_columns`); nothing is added to what the partner receives, to
 * either party's consent display, or to the agreed terms. See
 * docs/EXCHANGE_REFERENCE.md, "Your own columns in the result".
 */

/**
 * The control's three states: core's two selections plus the `"none"` that
 * stands for the config key's absence. `"none"` is a state of the control, not
 * a value of the key -- {@link ownColumnsField} emits no key for it, so an
 * untouched control composes the exact document an exchange authored before
 * the control existed composes.
 */
export type OwnColumnsChoice = "none" | OwnColumnSelection;

/** The control's starting state: the result the partner's values alone make up. */
export const OWN_COLUMNS_DEFAULT: OwnColumnsChoice = "none";

/** The choices in the order the control offers them, least to most included. */
export const OWN_COLUMNS_ORDER: ReadonlyArray<OwnColumnsChoice> = [
  "none",
  "disclosed",
  "all",
];

/** The option label for each choice, stating what the operator's own result
 * file holds -- never what the partner receives, which no choice changes. */
export const OWN_COLUMNS_LABELS: Record<OwnColumnsChoice, string> = {
  none: "Nothing of mine - my partner's values only",
  disclosed: "The columns I send my partner",
  all: "Every column of my file",
};

/**
 * Whether the exchange being authored writes THIS party a result file the
 * choice can act on: a count-only (`psi-c`) exchange writes none for either
 * party, and a party whose agreed output gives it no result table has none of
 * its own to write into.
 *
 * The same predicate gates the control and the emission, so the composed
 * config states only what the surface offered: an operator who set the choice
 * and then made the exchange count-only, or handed the result to the partner
 * alone, composes no key rather than one core would refuse (`psi-c`, refused
 * at config parse) or silently ignore (no result table).
 */
export function ownColumnsActionable(terms: {
  algorithm: Algorithm;
  output: Output;
}): boolean {
  return terms.algorithm !== "psi-c" && terms.output.expectsOutput;
}

/**
 * The config field a choice contributes to this party's exchange document,
 * absent for `"none"` and for terms the choice cannot act on
 * ({@link ownColumnsActionable}). Spread into an assembly, so an absent field
 * is an omitted key rather than an explicit `undefined`.
 */
export function ownColumnsField(
  choice: OwnColumnsChoice,
  terms: { algorithm: Algorithm; output: Output },
): { includeOwnColumns?: OwnColumnSelection } {
  if (choice === "none" || !ownColumnsActionable(terms)) return {};
  return { includeOwnColumns: choice };
}

/**
 * The columns this party's result file would hold under a choice, in metadata
 * order -- core's own selection ({@link ownResultColumnNames}), never a
 * re-derivation, so the names the control previews are the names the result
 * gets. Empty for `"none"`, and for a selection that resolves to nothing (a
 * file whose only column is the identifier, which the result's first column
 * already holds).
 */
export function ownColumnsPreview(
  metadata: Metadata,
  choice: OwnColumnsChoice,
): Array<string> {
  if (choice === "none") return [];
  return ownResultColumnNames(metadata, choice);
}

/** What the control says the setting does NOT do, stated at the control rather
 * than left to the reference: the operator is choosing beside a grid whose
 * every other row governs what the partner sees. */
export const OWN_COLUMNS_LOCAL_NOTICE =
  "This choice changes only the result file you download. Your partner is " +
  "sent nothing extra, sees no change in what they agree to, and their own " +
  "result file is untouched.";

/** What the control says where `all` resolves to no column: every column the
 * file has is the identifier the result already begins with. */
export const OWN_COLUMNS_EMPTY_ALL_NOTICE =
  "No column is left to add: your result file already begins with your record " +
  "identifier, and this file has no other column to write beside it.";

/** What the control says where `disclosed` resolves to no column: the file may
 * hold plenty of columns, but none beside the record identifier is marked as
 * sent, and the identifier already heads the result on its own. */
export const OWN_COLUMNS_EMPTY_DISCLOSED_NOTICE =
  "No column is left to add: no column other than your record identifier is " +
  "marked as sent to your partner, so this choice adds nothing. The " +
  "identifier already begins your result file; mark another column as sent " +
  "to keep it in your result file.";

/** The notice for a selection that resolves to no column, so the operator is
 * not left reading a chosen setting with nothing under it. Which one applies is
 * the selection's: a file with columns to spare still selects none under
 * `disclosed` when its disclosure choices mark none as sent. */
export function ownColumnsEmptySelectionNotice(
  selection: OwnColumnSelection,
): string {
  return selection === "disclosed"
    ? OWN_COLUMNS_EMPTY_DISCLOSED_NOTICE
    : OWN_COLUMNS_EMPTY_ALL_NOTICE;
}
