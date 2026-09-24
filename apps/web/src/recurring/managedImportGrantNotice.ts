/**
 * What an import tells the operator about the device-local grants it could not
 * bring: the input file the exchange reads and the folder a scheduled run writes
 * its results to (see docs/MANAGED_EXCHANGE.md, "Eviction recovery is the import
 * flow").
 *
 * Neither grant is in the artifact -- a File System Access handle belongs to the
 * browser profile that took it -- so a restored exchange holds neither until the
 * operator takes them again. Left unsaid, what reports it is a scheduled run: the
 * input side stops with a benign input failure, and the output side keeps its
 * results in the browser, both a whole window after the import that lost them. It
 * is stated at the import instead, where the operator is standing and a click away
 * from the pickers.
 *
 * Only grants the source record actually held are named. A record that never had a
 * folder grant has nothing for the operator to take again, and an exchange that ran
 * on a browser with no File System Access API had no handle to lose.
 */

import type { ManagedPlatformGrant } from "@psi/managed/managedExchangeArtifact";

/** What the import notice says: a heading, what this browser does not have, and one
 * line per grant saying what a run with nobody present does without it. */
export interface ManagedImportGrantNotice {
  /** The heading the notice is shown under. */
  title: string;
  /** What this browser does not have, and what to do about it. */
  lead: string;
  /** One line per missing grant, in the order the grants were given. */
  consequences: Array<string>;
}

/** How each grant is named to the operator. */
const GRANT_NAME: Record<ManagedPlatformGrant, string> = {
  "input-file": "input file",
  "output-folder": "results folder",
};

/** What a run with nobody present does without each grant. Stated per grant rather
 * than once for the pair, so an import missing only one does not describe the other. */
const GRANT_CONSEQUENCE: Record<ManagedPlatformGrant, string> = {
  "input-file":
    "Without an input file, a run that happens with nobody present stops.",
  "output-folder":
    "Without a results folder, a run that happens with nobody present keeps its results in the browser.",
};

/**
 * The notice for the grants an import did not bring, or `undefined` when it brought
 * everything its source had -- a revive in place, which keeps the record's own
 * handles, and an import of an exchange that held neither.
 */
export function managedImportGrantNotice(
  missingGrants: ReadonlyArray<ManagedPlatformGrant>,
): ManagedImportGrantNotice | undefined {
  if (missingGrants.length === 0) return undefined;
  const names = missingGrants.map((grant) => GRANT_NAME[grant]);
  const named = names.join(" and the ");
  const them = missingGrants.length === 1 ? "it" : "them";
  return {
    title: `Choose this exchange's ${named} again`,
    lead: `This browser does not have the ${named} this exchange used. Open the exchange to choose ${them} now.`,
    consequences: missingGrants.map((grant) => GRANT_CONSEQUENCE[grant]),
  };
}

/** The heading a scoped restore's notice takes when it names a listed exchange
 * with the same terms. */
export const RESTORED_WITH_SAME_TERMS_TITLE = "Exchange restored";

/**
 * The notice a scoped restore shows when another listed exchange has the
 * restored one's agreed terms and side: the restore went ahead, since the
 * operator chose the row, and the other exchange is named so they can tell
 * the two apart. The grants the restore did not bring follow, if any.
 */
export function restoredWithSameTermsNotice(
  label: string,
  grantNotice: ManagedImportGrantNotice | undefined,
): ManagedImportGrantNotice {
  const named = label === "" ? "another exchange in the list" : `"${label}"`;
  const restored = `This exchange was restored; ${named} has the same terms and side.`;
  return {
    title: RESTORED_WITH_SAME_TERMS_TITLE,
    lead:
      grantNotice === undefined ? restored : `${restored} ${grantNotice.lead}`,
    consequences: grantNotice?.consequences ?? [],
  };
}
