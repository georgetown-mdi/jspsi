import { sanitizeForDisplay, summarizeLinkageShortfall } from "@psilink/core";

import type { LinkageField } from "@psilink/core";

import type { AlertContent } from "@components/csvIntake";
import type { LinkageRefusal } from "@psi/linkageRefusal";

/** The missing field types, as a parenthesised trailing fragment, or the empty
 * string for an empty list. The names and types are terms content -- partner-
 * authored wherever the terms arrived with an invitation -- so each is escaped at
 * this sink. */
function missingFieldsDetail(fields: ReadonlyArray<LinkageField>): string {
  if (fields.length === 0) return "";
  return (
    " (missing: " +
    fields
      .map(
        (f) => `${sanitizeForDisplay(f.name)} (${sanitizeForDisplay(f.type)})`,
      )
      .join(", ") +
    ")"
  );
}

/**
 * The operator-facing alert for a file that cannot satisfy the linkage terms its
 * run would be held to, shared by the direct-exchange confirm screen and both
 * inviter mint gates so the wording cannot drift: each renders it from the
 * {@link LinkageRefusal} its own verdict produced, and the mint gates from the one
 * an {@link InvitationFileError} raised at the mint-time re-check.
 *
 * Total over {@link LinkageRefusal}, which exists only for a verdict that refuses,
 * so a seat holding a refusal always has copy for it and a seat holding none shows
 * nothing.
 *
 * The shortfall sentence is core's {@link summarizeLinkageShortfall} -- the same
 * fragment the run-boundary refusal states -- so the advance notice and the refusal
 * that follows it cannot describe one fault in two ways. It holds fixed copy and
 * counts only: a linkage KEY's name is never shown. The unproducible FIELDS are,
 * as the missing-types guidance every seat gives, escaped at this sink.
 *
 * The first-party copy around it assumes no partner and no agreement yet -- it
 * names the terms and the files on both sides -- so it reads the same for a seat
 * minting terms from the operator's own columns and one held to terms an
 * invitation brought. The fragment is taken on the `"draft"` standing: every seat
 * that renders this alert holds terms no partner has agreed to, so the shortfall
 * is counted against draft keys rather than agreed ones.
 *
 * The return shape is the structural {@link AlertContent} (`{ title, message }`)
 * every caller assigns into its error state and renders through the shared alert
 * slot.
 */
export function unlinkableFileAlert(refusal: LinkageRefusal): AlertContent {
  if (refusal.kind === "no-linkable-key")
    return {
      title: "This file cannot be linked",
      message:
        "Your CSV cannot satisfy any default linkage key" +
        missingFieldsDetail(refusal.missingFields) +
        ". No matches would be possible. Choose a file that includes columns " +
        "for the required field types (for example name, date of birth, or SSN).",
    };
  return {
    title: "This file cannot satisfy the linkage terms",
    message:
      "An exchange runs every linkage key its terms declare, and " +
      `${summarizeLinkageShortfall(refusal.verdict, "draft")}` +
      missingFieldsDetail(refusal.verdict.unsatisfiedFields) +
      ". It would be refused before any data left this device. Choose a file " +
      "that satisfies every linkage key in the terms, or set terms that " +
      "declare only the keys the files on both sides can supply.",
  };
}
