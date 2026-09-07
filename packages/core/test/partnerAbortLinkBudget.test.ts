import { expect, test } from "vitest";

import { exchangeTerms, PROTOCOL_VERSION } from "../src/protocolSetup";
import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import {
  createMessagePipe,
  type MessageConnection,
} from "../src/connection/messageConnection";
import { DEFAULT_MAX_DISPLAY_LENGTH } from "../src/utils/sanitizeForDisplay";
import { sanitizeErrorForDisplay } from "../src/utils/sanitizeErrorForDisplay";

// What each abort-bearing message class of the terms exchange delivers when the
// partner plants private-key material, a forged link boundary, or an
// unbounded value in ONE of the reasons it chose. The whole class is asserted
// at once, over every plant in every position, rather than one site at a time:
// the guarantee is a property of the branded type and its one elimination
// (src/utils/partnerOriginText.ts), so a new abort site inherits it and a
// regression shows up here whichever site introduces it.
//
// The property, in one sentence: the first-party sentence and every reason the
// partner did NOT plant in arrive whole, and no reason renders past the
// per-value budget. This is the terms-exchange analogue of
// test/connection/transportRefusalBudget.test.ts, which holds the same
// partition for the bounded-transport refusals.

const sharedFields: LinkageTerms["linkageFields"] = [
  { name: "ssn", type: "ssn" },
];
const sharedKeys: LinkageTerms["linkageKeys"] = [
  { name: "SSN", elements: [{ field: "ssn" }] },
];

const termsA: LinkageTerms = {
  version: "1.0.0",
  identity: "Party A",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: sharedFields,
  linkageKeys: sharedKeys,
};

const termsB: LinkageTerms = { ...termsA, identity: "Party B" };

const makeConnections = (): [MessageConnection, MessageConnection] =>
  createMessagePipe();

/**
 * Message 2's abort slot: the responder's terms-and-decision frame carries the
 * reasons, and the initiator renders them.
 */
async function messageTwoAbort(reasons: string[]): Promise<string> {
  const [connA, connB] = makeConnections();
  const initiator = exchangeTerms(connA, "initiator", termsA, 100);
  await connB.receive();
  await connB.send({
    linkageTerms: termsB,
    decision: "abort",
    protocolVersion: PROTOCOL_VERSION,
    abortReasons: reasons,
  });
  return sanitizeErrorForDisplay(await initiator.catch((err: unknown) => err));
}

/**
 * Message 3's abort slot: the initiator's decision frame carries the reasons,
 * and the responder renders them.
 */
async function messageThreeAbort(reasons: string[]): Promise<string> {
  const [connA, connB] = makeConnections();
  const responder = exchangeTerms(connB, "responder", termsB, 200);
  await connA.send({
    linkageTerms: termsA,
    recordCount: 100,
    protocolVersion: PROTOCOL_VERSION,
  });
  await connA.receive();
  await connA.send({ decision: "abort", abortReasons: reasons });
  return sanitizeErrorForDisplay(await responder.catch((err: unknown) => err));
}

const MESSAGE_CLASSES = {
  "terms exchange message 2": messageTwoAbort,
  "terms exchange message 3": messageThreeAbort,
};

// The renderer's own link separator, read back off a two-link render rather
// than restated, so splitting a render into links cannot drift from the
// framing the renderer emits.
const CAUSE_SEPARATOR = sanitizeErrorForDisplay(
  new Error("a", { cause: new Error("b") }),
).slice(1, -1);

const linksOf = (rendered: string): string[] => rendered.split(CAUSE_SEPARATOR);

const FIRST_PARTY_SENTENCE = "partner aborted linkage terms exchange";
const REASON_LABEL = "reason the partner gave: ";
const REDACTION = "[redacted private key]";

const BEGIN_MARKER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const END_MARKER = "-----END OPENSSH PRIVATE KEY-----";
const KEY_BODY = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB";

// The tail a plant carries, so a plant that ate what follows it inside its own
// link is caught: the render boundary redacts each link too, so a plant with
// nothing behind it renders the same whether or not the link redacted before
// it clipped.
const PLANT_TAIL = " and the rest of what the partner wrote";

// What one reason may hold that the reasons beside it must survive: each
// marker on its own (a dangling BEGIN reaches forward to the end of what it
// is composed with; a lone END must delete nothing), a whole block, a forged
// link boundary, and a value long enough to spend a whole message's display
// budget on its own.
const PLANTS: Record<string, string> = {
  "a dangling BEGIN marker": `${BEGIN_MARKER}${PLANT_TAIL}`,
  "a lone END marker": `${END_MARKER}${PLANT_TAIL}`,
  "a whole private-key block": `${BEGIN_MARKER}\n${KEY_BODY.repeat(30)}\n${END_MARKER}${PLANT_TAIL}`,
  "a forged link boundary": `\ncaused by: a sentence the partner wrote${PLANT_TAIL}`,
  "an unbounded value": "w".repeat(10_000),
};

// What each plant must still deliver on its own link. A dangling BEGIN is
// fail-closed forward by design, so its tail is expected to go; every other
// plant keeps one, and the whole block keeps its tail only because the link
// redacts BEFORE it clips.
const PLANT_KEEPS_TAIL: Record<string, boolean> = {
  "a dangling BEGIN marker": false,
  "a lone END marker": true,
  "a whole private-key block": true,
  "a forged link boundary": true,
  "an unbounded value": false,
};

// Plain reasons an honest partner sends, one per position: each must arrive
// whole whichever position the plant takes.
const PLAIN_REASONS = [
  "the operator declined the terms",
  "payload mismatch: local receive columns do not match partner send columns",
  "identity mismatch",
];

for (const [className, render] of Object.entries(MESSAGE_CLASSES))
  for (const [plantName, plant] of Object.entries(PLANTS))
    for (let planted = 0; planted < PLAIN_REASONS.length; planted++)
      test(`${className}: ${plantName} at reason ${planted + 1} leaves every other reason whole`, async () => {
        const reasons = PLAIN_REASONS.map((reason, index) =>
          index === planted ? plant : reason,
        );
        const links = linksOf(await render(reasons));

        // One link for the first-party sentence and one per reason: a planted
        // separator does not add a link, and no reason is dropped.
        expect(links).toHaveLength(1 + reasons.length);
        expect(links[0]).toBe(FIRST_PARTY_SENTENCE);

        for (let index = 0; index < reasons.length; index++) {
          const link = links[index + 1]!;
          expect(link.startsWith(REASON_LABEL)).toBe(true);
          // The escape's own control-character token, which only a control
          // character the COMPOSITION placed can produce: a reason's own are
          // replaced where the link is built, so the two are never confusable
          // (a literal `\x0a` the partner types escapes its backslash).
          expect(link).not.toMatch(/\\x[0-9a-f]{2}/);
          // Every link is charged to the per-value budget on its own, so no
          // reason can spend the budget another reason's disclosure needs.
          expect(link.length).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH);
          if (index !== planted)
            expect(link).toBe(`${REASON_LABEL}${PLAIN_REASONS[index]}`);
        }

        const plantedLink = links[planted + 1]!;
        expect(plantedLink).not.toContain(KEY_BODY);
        if (plant.includes(BEGIN_MARKER))
          expect(plantedLink).toContain(REDACTION);
        expect(plantedLink.includes(PLANT_TAIL)).toBe(
          PLANT_KEEPS_TAIL[plantName],
        );
      });
