import { sanitizeForDisplay } from "@psilink/core";

import type { LinkageField } from "@psilink/core";

import type { AlertContent } from "@components/csvIntake";

/**
 * The operator-facing alert for a file whose columns satisfy zero default linkage
 * keys, shared by both invite surfaces so the wording cannot drift: the quick
 * invite (rendered from an {@link InvitationFileError} zero-satisfiable-keys
 * failure in {@link InvitePanel}) and the Advanced editor's file entry
 * ({@link AdvancedInvite}). When every default key references at least one field
 * type the file lacks, no match is possible and the exchange would yield a result
 * byte-indistinguishable from a legitimately empty intersection, so both surfaces
 * refuse the file EARLY with this shared message rather than running it.
 *
 * `unsatisfied` is the missing linkage fields from {@link assessLinkageSatisfiability}
 * (equivalently an {@link InvitationFileError}'s failure detail). The field names
 * and types are default-derived, not partner-controlled, but are sanitized anyway
 * for parity with the surfaces that do surface partner content. The detail is
 * omitted when the list is empty (it should always be populated on this path). The
 * return shape is the structural {@link AlertContent} (`{ title, message }`) both
 * callers assign into their error state and render through the shared alert slot.
 */
export function unlinkableFileAlert(
  unsatisfied: ReadonlyArray<LinkageField>,
): AlertContent {
  const detail =
    unsatisfied.length > 0
      ? " (missing: " +
        unsatisfied
          .map(
            (f) =>
              `${sanitizeForDisplay(f.name)} (${sanitizeForDisplay(f.type)})`,
          )
          .join(", ") +
        ")"
      : "";
  return {
    title: "This file cannot be linked",
    message:
      `Your CSV cannot satisfy any default linkage key${detail}. No ` +
      "matches would be possible. Choose a file that includes columns for " +
      "the required field types (for example name, date of birth, or SSN).",
  };
}
