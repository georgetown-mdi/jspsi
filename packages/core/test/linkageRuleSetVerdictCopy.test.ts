import { describe, expect, test } from "vitest";

import {
  LINKAGE_RULE_SET_VERDICT_COPY,
  RECORDED_LINKAGE_RULE_SET_CAVEAT,
  distinctLinkageRuleSetVerdicts,
  linkageRuleSetVerdictNote,
} from "../src/consentFacts";

import type { LinkageRuleSetCitationVerdict } from "../src/defaults/linkageTerms";

/**
 * The shared copy every surface renders beside a rule-set citation: which caveats
 * are stated and in what order, which reading each reader gets, and what the
 * surfaces reading a filed record say instead.
 */

/** Every member of the verdict union, read off the copy table -- a `Record` over
 * the union, so this list cannot fall behind it the way a transcribed one
 * would. */
const ALL_VERDICTS = Object.keys(
  LINKAGE_RULE_SET_VERDICT_COPY,
) as Array<LinkageRuleSetCitationVerdict>;

describe("distinctLinkageRuleSetVerdicts", () => {
  test("states each reached verdict once, most severe first", () => {
    expect(
      distinctLinkageRuleSetVerdicts("consistent", "contradicted"),
    ).toStrictEqual(["contradicted", "consistent"]);
    expect(
      distinctLinkageRuleSetVerdicts("consistent", "consistent"),
    ).toStrictEqual(["consistent"]);
    expect(distinctLinkageRuleSetVerdicts()).toStrictEqual([]);
  });

  test("carries every member of the union rather than dropping an unranked one", () => {
    // A surface renders no marker and no caveat for a verdict this drops, so the
    // ordering must be total over the union: the ranking is a Record over it,
    // which is what fails a new member at compile time, and this is the runtime
    // half of the same guarantee.
    expect(
      new Set(distinctLinkageRuleSetVerdicts(...ALL_VERDICTS)),
    ).toStrictEqual(new Set(ALL_VERDICTS));
    expect(distinctLinkageRuleSetVerdicts(...ALL_VERDICTS)[0]).toBe(
      "contradicted",
    );
  });
});

describe("linkageRuleSetVerdictNote", () => {
  test("gives the recipient the table's own sentence, for every verdict", () => {
    for (const verdict of ALL_VERDICTS)
      expect(linkageRuleSetVerdictNote(verdict, "recipient")).toBe(
        LINKAGE_RULE_SET_VERDICT_COPY[verdict].note,
      );
  });

  test("swaps the remedy, not the finding, for the party that wrote the citation", () => {
    const recipient = linkageRuleSetVerdictNote("contradicted", "recipient");
    const author = linkageRuleSetVerdictNote("contradicted", "citing-party");

    expect(author).not.toBe(recipient);
    // The finding is one sentence for both readers -- what this build checked
    // cannot depend on who is reading it -- while the remedy is the one the
    // reader in front of it can act on.
    expect(author).toContain("are NOT drawn from that set");
    expect(recipient).toContain("settle it with the other party");
    expect(author).not.toContain("settle it with the other party");
    expect(author).toContain("yours to correct");
  });

  test("withholds the caveat where a verdict has no author reading", () => {
    // The other two caveats attribute the citation to a partner, so the surfaces
    // showing a viewer its own citation withhold them rather than rewording
    // them; nothing here invents a second sentence for them.
    for (const verdict of ["consistent", "unchecked"] as const)
      expect(
        linkageRuleSetVerdictNote(verdict, "citing-party"),
      ).toBeUndefined();
  });

  test("never reads a partner-attributed sentence back to the citing party", () => {
    // The misattribution this pins is a fallback: handing the party that wrote
    // the citation the recipient's copy, which tells them their own declaration
    // is their partner's word. Over the whole union rather than the two verdicts
    // withheld today, so one that later gains an author reading is held to the
    // same rule.
    for (const verdict of ALL_VERDICTS) {
      const citingParty = linkageRuleSetVerdictNote(verdict, "citing-party");
      if (citingParty === undefined) continue;
      expect(citingParty).not.toBe(LINKAGE_RULE_SET_VERDICT_COPY[verdict].note);
      expect(citingParty).not.toContain("Your partner");
    }
  });
});

describe("RECORDED_LINKAGE_RULE_SET_CAVEAT", () => {
  test("points a record's reader at the verdict instead of denying or restating one", () => {
    // A record's citation is always paired with the writing party's verdict, so
    // the one sentence that serves all three verdicts must neither claim nothing
    // was checked nor read as verification -- and must not put the verdict's own
    // vocabulary on a surface that does not hold the value.
    expect(RECORDED_LINKAGE_RULE_SET_CAVEAT).toContain("exchange record");
    expect(RECORDED_LINKAGE_RULE_SET_CAVEAT).toContain("matching basis");
    expect(RECORDED_LINKAGE_RULE_SET_CAVEAT).not.toContain("has not checked");
    for (const verdict of ALL_VERDICTS) {
      expect(RECORDED_LINKAGE_RULE_SET_CAVEAT).not.toContain(
        LINKAGE_RULE_SET_VERDICT_COPY[verdict].marker,
      );
      expect(RECORDED_LINKAGE_RULE_SET_CAVEAT).not.toContain(verdict);
    }
  });
});
