import { expect, test } from "vitest";

import { exchangeTerms, PROTOCOL_VERSION } from "../src/protocolSetup";
import type { LinkageTerms } from "../src/config/linkageTermsSchema";
import {
  createMessagePipe,
  type MessageConnection,
} from "../src/connection/messageConnection";
import { MAX_PARTNER_VALUES_SHOWN } from "../src/utils/partnerOriginText";
import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DEFAULT_MAX_DISPLAY_LENGTH,
} from "../src/utils/sanitizeForDisplay";
import {
  CAUSE_DEPTH_ELISION_MARKER,
  sanitizeErrorForDisplay,
} from "../src/utils/sanitizeErrorForDisplay";

// What each abort-bearing message class of the terms exchange delivers when the
// partner plants private-key material, a forged link boundary, a forged
// reason separator, or an unbounded value in ONE of the reasons it chose. The whole class is asserted
// at once, over every plant in every position, rather than one site at a time:
// the guarantee is a property of the branded type and its one elimination
// (src/utils/partnerOriginText.ts), so a new abort site inherits it and a
// regression shows up here whichever site introduces it.
//
// The property, in one sentence: the first-party sentence and every reason the
// partner did NOT plant in arrive whole, no reason renders past the per-value
// budget, and what the ceiling does not show is counted rather than dropped. This is the terms-exchange analogue of
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

// The separator between two reasons packed on one link, read back the same
// way: the line breaks the elimination places, as the sink's escape renders
// them. A reason cannot spell it (src/utils/partnerOriginText.ts), which is
// what makes this split exact rather than a guess at the framing.
const VALUE_SEPARATOR = sanitizeErrorForDisplay(new Error("a\n\nb")).slice(
  1,
  -1,
);

const linksOf = (rendered: string): string[] => rendered.split(CAUSE_SEPARATOR);

const reasonsOf = (rendered: string): string[] =>
  linksOf(rendered)
    .slice(1)
    .flatMap((link) => link.split(VALUE_SEPARATOR));

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
// link boundary, a forged separator between two reasons of one link, and a
// value long enough to spend a whole message's display budget on its own.
const PLANTS: Record<string, string> = {
  "a dangling BEGIN marker": `${BEGIN_MARKER}${PLANT_TAIL}`,
  "a lone END marker": `${END_MARKER}${PLANT_TAIL}`,
  "a whole private-key block": `${BEGIN_MARKER}\n${KEY_BODY.repeat(30)}\n${END_MARKER}${PLANT_TAIL}`,
  "a forged link boundary": `\ncaused by: a sentence the partner wrote${PLANT_TAIL}`,
  "a forged reason separator": `\\x0a\\x0a${REASON_LABEL}a reason the partner never sent${PLANT_TAIL}`,
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
  "a forged reason separator": true,
  "an unbounded value": false,
};

// Plain reasons an honest partner sends, one per position: each must arrive
// whole whichever position the plant takes.
const PLAIN_REASONS = [
  "the operator declined the terms",
  "payload mismatch: local receive columns do not match partner send columns",
  "identity mismatch",
];

// A refusal the size of a real one: more reasons than one link carries and
// more than the chain shows, so the plant sits mid-pack with whole reasons on
// either side of it and the ceiling's counted tail behind them.
const MANY_REASONS = Array.from(
  { length: 20 },
  (_, index) => `reason number ${index + 1} the partner stated`,
);
const PLANTED_POSITION = 14;

/**
 * What every rendered abort must hold, whichever reason the partner planted
 * in: the first-party sentence on its own link, one labelled place per reason
 * the ceiling admits, each reason inside the per-value budget, each link
 * inside the renderer's per-link budget, and every reason the partner did not
 * plant in arriving whole.
 */
function expectPartitioned(
  rendered: string,
  reasons: readonly string[],
  planted: number,
): string {
  const links = linksOf(rendered);
  expect(links[0]).toBe(FIRST_PARTY_SENTENCE);
  for (const link of links)
    expect(link.length).toBeLessThanOrEqual(
      COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
    );

  const shown = Math.min(reasons.length, MAX_PARTNER_VALUES_SHOWN);
  const rendersReasons = reasonsOf(rendered).slice(0, shown);
  expect(rendersReasons).toHaveLength(shown);

  for (let index = 0; index < shown; index++) {
    const reason = rendersReasons[index]!;
    expect(reason.startsWith(REASON_LABEL)).toBe(true);
    // The separator the elimination places appears only where it placed it: a
    // reason that spells it renders with its backslashes doubled, so the token
    // never opens a second reason inside one.
    expect(reason).not.toContain(VALUE_SEPARATOR);
    // Every reason is charged to the per-value budget on its own, so no reason
    // can spend the budget another reason's disclosure needs.
    expect(reason.length).toBeLessThanOrEqual(
      REASON_LABEL.length + DEFAULT_MAX_DISPLAY_LENGTH,
    );
    if (index !== planted)
      expect(reason).toBe(`${REASON_LABEL}${reasons[index]}`);
  }

  return rendersReasons[planted]!;
}

/** What the planted reason itself must deliver: no key body, and no more. */
function expectPlantContained(reason: string, plantName: string): void {
  const plant = PLANTS[plantName]!;
  expect(reason).not.toContain(KEY_BODY);
  if (plant.includes(BEGIN_MARKER)) expect(reason).toContain(REDACTION);
  expect(reason.includes(PLANT_TAIL)).toBe(PLANT_KEEPS_TAIL[plantName]);
}

for (const [className, render] of Object.entries(MESSAGE_CLASSES)) {
  for (const [plantName, plant] of Object.entries(PLANTS)) {
    for (let planted = 0; planted < PLAIN_REASONS.length; planted++)
      test(`${className}: ${plantName} at reason ${planted + 1} leaves every other reason whole`, async () => {
        const reasons = PLAIN_REASONS.map((reason, index) =>
          index === planted ? plant : reason,
        );

        expectPlantContained(
          expectPartitioned(await render(reasons), reasons, planted),
          plantName,
        );
      });

    test(`${className}: ${plantName} mid-pack of ${MANY_REASONS.length} reasons leaves every neighbour whole`, async () => {
      const reasons = MANY_REASONS.map((reason, index) =>
        index === PLANTED_POSITION ? plant : reason,
      );
      const rendered = await render(reasons);

      expectPlantContained(
        expectPartitioned(rendered, reasons, PLANTED_POSITION),
        plantName,
      );
      // The reasons past the ceiling are counted, not dropped in silence, and
      // the renderer's own depth marker never appears: the count says how many
      // reasons the operator has not read.
      const links = linksOf(rendered);
      expect(links[links.length - 1]).toBe(
        `${reasons.length - MAX_PARTNER_VALUES_SHOWN} further values the partner sent are not shown`,
      );
      expect(rendered).not.toContain(CAUSE_DEPTH_ELISION_MARKER);
    });
  }
}
