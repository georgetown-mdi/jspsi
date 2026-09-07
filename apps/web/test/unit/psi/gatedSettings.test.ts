import { describe, expect, test, vi } from "vitest";

import { getDefaultLinkageTerms, inferMetadata } from "@psilink/core";

import {
  buildAdvancedTerms,
  gatedActiveSettingMessage,
  seedAdvancedInvite,
} from "../../../src/psi/authoring/advancedInvite.js";

import type { LinkageKeyElement, LinkageTerms } from "@psilink/core";
import type { AdvancedInviteDraft } from "../../../src/psi/authoring/advancedInviteTypes.js";

// The clamp and the import door read APPLIED_SETTINGS, and no flag in the
// shipped build is false, so the branch they exist for is reachable only with
// one mocked off. What they hold is that a setting the run would not honor
// cannot reach the built terms however the draft got it -- through a UI gap, or
// an imported document -- which is why the guard is structural rather than a
// disabled control alone.
vi.mock("@psilink/core", async (importOriginal) => {
  const core = await importOriginal<Record<string, unknown>>();
  return {
    ...core,
    APPLIED_SETTINGS: { deduplicate: true, fuzzyComparisons: false },
  };
});

const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

function withFuzzyOnFirstElement(terms: LinkageTerms): LinkageTerms {
  return {
    ...terms,
    linkageKeys: terms.linkageKeys.map((key, ki) =>
      ki === 0
        ? {
            ...key,
            elements: key.elements.map((el, ei) =>
              ei === 0
                ? { ...el, generateFuzzyComparisons: "transpositions" }
                : el,
            ),
          }
        : key,
    ),
  };
}

describe("a setting whose flag is off cannot reach the built terms", () => {
  test("buildAdvancedTerms strips the expansion the run would not apply", () => {
    const { draft } = seedAdvancedInvite("Org", ALL_COLUMNS);
    // Forced on past the control the same flag disables, which is the state the
    // structural clamp exists for.
    const forced: AdvancedInviteDraft = {
      ...draft,
      deduplicate: true,
      keys: draft.keys.map((entry, i) =>
        i === 0
          ? {
              ...entry,
              key: {
                ...entry.key,
                elements: entry.key.elements.map((el, j): LinkageKeyElement =>
                  j === 0
                    ? { ...el, generateFuzzyComparisons: "edit_distances" }
                    : el,
                ),
              },
            }
          : entry,
      ),
    };
    const terms = buildAdvancedTerms(forced);
    // Per setting rather than blanket: deduplicate's own flag is on, so it is
    // written through while the gated one beside it is stripped.
    expect(terms.deduplicate).toBe(true);
    expect(
      terms.linkageKeys.every((key) =>
        key.elements.every((el) => el.generateFuzzyComparisons === undefined),
      ),
    ).toBe(true);
  });

  test("gatedActiveSettingMessage refuses an import that turns it on", () => {
    const base = getDefaultLinkageTerms("Org", inferMetadata(ALL_COLUMNS, []));
    expect(gatedActiveSettingMessage(base)).toBeUndefined();
    expect(
      gatedActiveSettingMessage({ ...base, deduplicate: true }),
    ).toBeUndefined();
    expect(gatedActiveSettingMessage(withFuzzyOnFirstElement(base))).toMatch(
      /fuzzy/i,
    );
  });
});
