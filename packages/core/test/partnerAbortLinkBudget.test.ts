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
// partner plants private-key material, a forged link boundary, a forged reason
// separator, a value ending in the escape's own token, or an unbounded value in
// ONE of the reasons it chose, and when it repeats one reason for every place
// the chain has. The whole class is asserted at once, over every plant in every
// position, rather than one site at a time: the guarantee is a property of the
// branded type and its one elimination (src/utils/partnerOriginText.ts), so a
// new abort site inherits it and a regression shows up here whichever site
// introduces it.
//
// The property, in one sentence: the first-party sentence and every reason the
// partner did NOT plant in arrive whole, no reason renders past the per-value
// budget, and what the ceiling does not show is counted rather than dropped.
// This is the terms-exchange analogue of
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
// them. A reason cannot spell it (src/utils/partnerOriginText.ts), so it opens
// the next reason's label exactly where the composition placed it.
const VALUE_SEPARATOR = sanitizeErrorForDisplay(new Error("a\n\nb")).slice(
  1,
  -1,
);

const linksOf = (rendered: string): string[] => rendered.split(CAUSE_SEPARATOR);

const FIRST_PARTY_SENTENCE = "partner aborted linkage terms exchange";
const REASON_LABEL = "reason the partner gave: ";

// The first-party text opening the reason at a 1-based position: the position
// the elimination leads every label with (src/utils/partnerOriginText.ts),
// then the label protocolSetup passes it.
const labelAt = (position: number): string => `${position}. ${REASON_LABEL}`;

// One link's labelled reasons, partitioned where the next reason's label opens
// rather than on the separator alone: a reason ending in the escape's own token
// renders a separator-shaped span of its own four characters ahead of the one
// the composition placed, and the label behind it is what tells the two apart.
const reasonsOnLink = (link: string, first: number): string[] => {
  const reasons: string[] = [];
  let cursor = 0;
  for (let position = first + 1; ; position++) {
    const opening = link.indexOf(
      `${VALUE_SEPARATOR}${labelAt(position)}`,
      cursor,
    );
    if (opening === -1) {
      reasons.push(link.slice(cursor));
      return reasons;
    }
    reasons.push(link.slice(cursor, opening));
    cursor = opening + VALUE_SEPARATOR.length;
  }
};

// Every reason the chain renders, in order. The counted tail link holds no
// label, so it arrives as one trailing entry.
const reasonsOf = (rendered: string): string[] => {
  const reasons: string[] = [];
  for (const link of linksOf(rendered).slice(1))
    reasons.push(...reasonsOnLink(link, reasons.length + 1));
  return reasons;
};

const REDACTION = "[redacted private key]";

const BEGIN_MARKER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const END_MARKER = "-----END OPENSSH PRIVATE KEY-----";
const KEY_BODY = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB";

// The tail a plant carries, so a plant that ate what follows it inside its own
// link is caught: the render boundary redacts each link too, so a plant with
// nothing behind it renders the same whether or not the link redacted before
// it clipped.
const PLANT_TAIL = " and the rest of what the partner wrote";

// What one reason may hold that the reasons beside it must survive, written
// against the position the plant takes: each marker on its own (a dangling
// BEGIN reaches forward to the end of what it is composed with; a lone END must
// delete nothing), a whole block, a forged link boundary, a forged opening for
// the reason packed behind it, a reason ending in the escape's own token, and a
// value long enough to spend a whole message's display budget on its own.
const PLANTS: Record<string, (position: number) => string> = {
  "a dangling BEGIN marker": () => `${BEGIN_MARKER}${PLANT_TAIL}`,
  "a lone END marker": () => `${END_MARKER}${PLANT_TAIL}`,
  "a whole private-key block": () =>
    `${BEGIN_MARKER}\n${KEY_BODY.repeat(30)}\n${END_MARKER}${PLANT_TAIL}`,
  "a forged link boundary": () =>
    `\ncaused by: a sentence the partner wrote${PLANT_TAIL}`,
  "a forged reason separator": (position) =>
    `\\x0a\\x0a${labelAt(position + 1)}a reason the partner never sent${PLANT_TAIL}`,
  "a reason ending in the escape's own token": () =>
    `a reason the partner wrote${PLANT_TAIL}\\x0a`,
  "an unbounded value": () => "w".repeat(10_000),
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
  "a reason ending in the escape's own token": true,
  "an unbounded value": false,
};

// What a plant whose point is its ending must end in: the token it spells
// renders with its backslash doubled, so those four characters belong to the
// reason and the separator behind them opens the next label, rather than the
// partition landing four characters early.
const PLANT_ENDS: Record<string, string> = {
  "a reason ending in the escape's own token": "\\\\x0a",
};

// Plain reasons an honest partner sends, one per position: each must arrive
// whole whichever position the plant takes.
const PLAIN_REASONS = [
  "the operator declined the terms",
  "payload mismatch: local receive columns do not match partner send columns",
  "identity mismatch",
];

// A refusal the size of a real one: more reasons than one link carries and
// more than the chain shows, so a plant has whole reasons on either side of it
// and the ceiling's counted tail behind them.
const MANY_REASONS = Array.from(
  { length: 20 },
  (_, index) => `reason number ${index + 1} the partner stated`,
);

// Where a plant goes in that list: the first, middle and last slot of a
// three-reason pack, on the first link and on links the chain fills later, and
// the last position the ceiling shows.
const SHOWN_POSITIONS = [1, 2, 3, 9, 14, 17, 18];

// The positions the ceiling leaves to the count, where a plant must reach the
// operator not at all.
const COUNTED_POSITIONS = [19, 20];

// What the wire admits (`MAX_ABORT_REASONS`, src/protocolSetup.ts): a flood
// bound, well past what the chain shows.
const WIRE_MAX_REASONS = 256;

// One reason the partner sends over and over. The renderer drops a cause link
// whose raw message repeats the previous link's, so a repeated reason would
// take whole packs off the operator's screen -- uncounted, since the tail
// states what the ceiling left out and not what the renderer dropped -- if
// every label did not lead with the reason's own position.
const REPEATED_REASON = "the partner repeated this reason";

const plantInto = (
  reasons: readonly string[],
  position: number,
  plantName: string,
): { reasons: string[]; plant: string } => {
  const plant = PLANTS[plantName]!(position);
  return {
    plant,
    reasons: reasons.map((reason, index) =>
      index === position - 1 ? plant : reason,
    ),
  };
};

/**
 * What every rendered abort must hold, whichever reason the partner planted
 * in: the first-party sentence on its own link, one labelled place per reason
 * the ceiling admits, each reason inside the per-value budget, each link
 * inside the renderer's per-link budget, and every reason the partner did not
 * plant in arriving whole. A `planted` of -1 holds every reason to its own
 * text, for a list the partner planted nothing into or planted past the
 * ceiling.
 */
function expectPartitioned(
  rendered: string,
  reasons: readonly string[],
  planted: number,
): string[] {
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
    const label = labelAt(index + 1);
    expect(reason.startsWith(label)).toBe(true);
    // The separator the elimination places appears only where it placed it: a
    // reason that spells it renders with its backslashes doubled, so the token
    // never opens a second reason inside one.
    expect(reason).not.toContain(VALUE_SEPARATOR);
    // Every reason is charged to the per-value budget on its own, so no reason
    // can spend the budget another reason's disclosure needs.
    expect(reason.length).toBeLessThanOrEqual(
      label.length + DEFAULT_MAX_DISPLAY_LENGTH,
    );
    if (index !== planted) expect(reason).toBe(`${label}${reasons[index]}`);
  }

  return rendersReasons;
}

/** What the planted reason itself must deliver: no key body, and no more. */
function expectPlantContained(
  reason: string,
  plantName: string,
  plant: string,
): void {
  expect(reason).not.toContain(KEY_BODY);
  if (plant.includes(BEGIN_MARKER)) expect(reason).toContain(REDACTION);
  expect(reason.includes(PLANT_TAIL)).toBe(PLANT_KEEPS_TAIL[plantName]);
  const ending = PLANT_ENDS[plantName];
  if (ending !== undefined) expect(reason.endsWith(ending)).toBe(true);
}

/**
 * What a list longer than the ceiling must end in: the count of the reasons
 * the operator has not read, and never the renderer's own depth marker, which
 * holds no count.
 */
function expectCountedTail(rendered: string, sent: number): void {
  const links = linksOf(rendered);
  expect(links[links.length - 1]).toBe(
    `${sent - MAX_PARTNER_VALUES_SHOWN} further values the partner sent are not shown`,
  );
  expect(rendered).not.toContain(CAUSE_DEPTH_ELISION_MARKER);
}

for (const [className, render] of Object.entries(MESSAGE_CLASSES)) {
  for (const plantName of Object.keys(PLANTS)) {
    for (let position = 1; position <= PLAIN_REASONS.length; position++)
      test(`${className}: ${plantName} at reason ${position} leaves every other reason whole`, async () => {
        const { reasons, plant } = plantInto(
          PLAIN_REASONS,
          position,
          plantName,
        );

        expectPlantContained(
          expectPartitioned(await render(reasons), reasons, position - 1)[
            position - 1
          ]!,
          plantName,
          plant,
        );
      });

    for (const position of SHOWN_POSITIONS)
      test(`${className}: ${plantName} at reason ${position} of ${MANY_REASONS.length} leaves every neighbour whole`, async () => {
        const { reasons, plant } = plantInto(MANY_REASONS, position, plantName);
        const rendered = await render(reasons);

        expectPlantContained(
          expectPartitioned(rendered, reasons, position - 1)[position - 1]!,
          plantName,
          plant,
        );
        expectCountedTail(rendered, reasons.length);
      });

    for (const position of COUNTED_POSITIONS)
      test(`${className}: ${plantName} at reason ${position} of ${MANY_REASONS.length} is counted, never rendered`, async () => {
        const { reasons } = plantInto(MANY_REASONS, position, plantName);
        const rendered = await render(reasons);

        // A plant the ceiling leaves out changes no rendered byte: the same
        // list with the plain reason back in its place renders identically,
        // and the tail counts the plant among what it does not show.
        expect(rendered).toBe(await render(MANY_REASONS));
        expectPartitioned(rendered, reasons, -1);
        expectCountedTail(rendered, reasons.length);
      });
  }

  test(`${className}: identical reasons each keep a labelled place of their own`, async () => {
    const reasons = Array.from(
      { length: MAX_PARTNER_VALUES_SHOWN },
      () => REPEATED_REASON,
    );
    const rendered = await render(reasons);

    expectPartitioned(rendered, reasons, -1);
    expect(rendered).not.toContain("further value");
    expect(rendered).not.toContain(CAUSE_DEPTH_ELISION_MARKER);
  });

  test(`${className}: identical reasons past the ceiling are counted exactly`, async () => {
    const reasons = Array.from(
      { length: WIRE_MAX_REASONS },
      () => REPEATED_REASON,
    );
    const rendered = await render(reasons);

    expectPartitioned(rendered, reasons, -1);
    expectCountedTail(rendered, reasons.length);
  });
}
