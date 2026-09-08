import { describe, expect, test, vi } from "vitest";

import type { InvitationToken, LinkageTerms } from "@psilink/core";

// The flag the mocked summarizer answers with, read fresh on every call so one
// test can drive both directions. Hoisted because vi.mock's factory is lifted
// above every declaration in the file.
const forced = vi.hoisted(() => ({ acceptorTableWithheld: false }));

// displayInvitation summarizes the token it is handed, so a summary that
// contradicts that token's own terms can only reach the renderer by answering
// for the summarizer. Every other export passes through, so the fixtures and
// the asserted copy stay core's own.
vi.mock("@psilink/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@psilink/core")>();
  return {
    ...actual,
    summarizeInvitation: (token: InvitationToken) => ({
      ...actual.summarizeInvitation(token),
      acceptorTableWithheld: forced.acceptorTableWithheld,
    }),
  };
});

import {
  CONSENT_FACTS,
  generateSharedSecret,
  getDefaultLinkageTerms,
  inferMetadata,
} from "@psilink/core";

import { displayInvitation } from "../../src/invitationDisplay";

const LINKAGE_COLUMNS = ["first_name", "last_name", "dob", "ssn"];

function soleReceiverTerms(overrides: Partial<LinkageTerms>): LinkageTerms {
  return {
    ...getDefaultLinkageTerms(
      "Inviter Org",
      inferMetadata(LINKAGE_COLUMNS, []),
    ),
    deduplicate: true,
    output: { expectsOutput: true, shareWithPartner: false },
    ...overrides,
  };
}

// The document whose terms derive no withholding: a cascade carries each
// party's matched positions as the rounds go.
const CASCADE_TERMS = soleReceiverTerms({ linkageStrategy: "cascade" });

// The document whose terms derive the withholding: single-pass, the inviting
// party the sole receiver, and no column requested of this party.
const WITHHOLDING_TERMS = soleReceiverTerms({
  linkageStrategy: "single-pass",
  payload: { send: [], receive: [] },
});

function tokenFor(linkageTerms: LinkageTerms): InvitationToken {
  return {
    version: "1",
    linkageTerms,
    sharedSecret: generateSharedSecret(),
  };
}

function render(token: InvitationToken): string {
  const lines: Array<string> = [];
  displayInvitation({
    token,
    ownOutboundSend: undefined,
    emit: (line) => {
      lines.push(line);
    },
    promptFollows: true,
  });
  return lines.join("\n");
}

describe("displayInvitation: the deduplicate variant's one input", () => {
  test("the sole-receiver deduplicating variant follows core's resolved flag against the terms rendered beside it", async () => {
    // The prompt states the exchange's own non-receipt only where the run
    // holds it, and the whole of what it reads that from is
    // acceptorTableWithheld. Both documents here are rendered under the
    // OPPOSITE flag to the one their own terms derive, so a prompt
    // re-deriving the verdict from the strategy and the payload request --
    // faithful to the protocol rule until that rule grows a condition --
    // prints the other sentence and fails.
    const core =
      await vi.importActual<typeof import("@psilink/core")>("@psilink/core");

    // Non-vacuity: each fixture contradicts the flag it is rendered under, so
    // neither case can pass by the two agreeing.
    expect(
      core.summarizeInvitation(tokenFor(CASCADE_TERMS)).acceptorTableWithheld,
    ).toBe(false);
    expect(
      core.summarizeInvitation(tokenFor(WITHHOLDING_TERMS))
        .acceptorTableWithheld,
    ).toBe(true);

    forced.acceptorTableWithheld = true;
    const cascadeUnderWithheld = render(tokenFor(CASCADE_TERMS));
    expect(cascadeUnderWithheld).toContain(
      `    ${CONSENT_FACTS.duplicateGroupingWithheld.note}`,
    );
    expect(cascadeUnderWithheld).not.toContain(
      CONSENT_FACTS.duplicateGroupingDisplayLimit.note,
    );

    forced.acceptorTableWithheld = false;
    const withholdingUnderDisplayLimit = render(tokenFor(WITHHOLDING_TERMS));
    expect(withholdingUnderDisplayLimit).toContain(
      `    ${CONSENT_FACTS.duplicateGroupingDisplayLimit.note}`,
    );
    expect(withholdingUnderDisplayLimit).not.toContain(
      CONSENT_FACTS.duplicateGroupingWithheld.note,
    );
  });
});
