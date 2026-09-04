import { expect, test } from "vitest";

import {
  assertDisclosedNamesCarriable,
  exchangePayloads,
} from "../src/payloadExchange";
import { prepareForExchange, runExchange } from "../src/exchange";
import { overlongDisclosedColumnPositions } from "../src/config/metadata";
import { MAX_NAME_LENGTH } from "../src/config/linkageTerms";
import { UsageError } from "../src/errors";
import {
  createMessagePipe,
  ConnectionError,
} from "../src/connection/messageConnection";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type { MessageConnection } from "../src/connection/messageConnection";
import type { Metadata } from "../src/config/metadata";
import type { LinkageTerms, Output } from "../src/config/linkageTerms";

// The name of a transmitted column is held, not merely used: it rides the
// payload frame to the partner and is written into this party's exchange record,
// and both bound it at MAX_NAME_LENGTH. Metadata inferred from a CSV header passes
// through no schema, so this send-side gate is what keeps the partner's parse from
// being the first enforcement -- reached only after the frame is sent.

/** A name of exactly the ceiling: legitimate, and it must stay so. */
const atCeiling = "a".repeat(MAX_NAME_LENGTH);
const pastCeiling = atCeiling + "a";

// U+1D54F: one code POINT, two UTF-16 code units. A name of these is under the
// ceiling on a code-point count while over it on the count both bounds use,
// which is the case a code-point cut would wave through.
const ASTRAL = "\u{1D54F}";
const astralUnderCodePointsOverUnits = ASTRAL.repeat(MAX_NAME_LENGTH);
const astralAtCeiling = ASTRAL.repeat(MAX_NAME_LENGTH / 2);

const SHARES: Output = { expectsOutput: true, shareWithPartner: true };
const SHARES_NOTHING: Output = { expectsOutput: true, shareWithPartner: false };

const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "Sender",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "first_name", type: "first_name" }],
  linkageKeys: [{ name: "FN", elements: [{ field: "first_name" }] }],
};

/** Metadata for a linkage column plus one payload column of the given name,
 * disclosed unless `disclosed` says otherwise. */
function metadataSending(name: string, disclosed = true): Metadata {
  return [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    {
      name,
      type: "other",
      role: disclosed ? "payload" : "ignored",
      isPayload: disclosed,
    },
  ];
}

// --- overlongDisclosedColumnPositions ----------------------------------------

test("overlongDisclosedColumnPositions: a name at the ceiling is carryable", () => {
  expect(overlongDisclosedColumnPositions(metadataSending(atCeiling))).toEqual(
    [],
  );
});

test("overlongDisclosedColumnPositions: one character past the ceiling is reported by position", () => {
  expect(
    overlongDisclosedColumnPositions(metadataSending(pastCeiling)),
  ).toEqual([2]);
});

test("overlongDisclosedColumnPositions: the count is UTF-16 code units, not code points", () => {
  // The case a code-point count would pass and both bounds refuse.
  expect([...astralUnderCodePointsOverUnits].length).toBe(MAX_NAME_LENGTH);
  expect(astralUnderCodePointsOverUnits.length).toBe(MAX_NAME_LENGTH * 2);
  expect(
    overlongDisclosedColumnPositions(
      metadataSending(astralUnderCodePointsOverUnits),
    ),
  ).toEqual([2]);
  // And the boundary on that same count is carryable, so the unit is pinned in
  // both directions rather than only by a refusal.
  expect(astralAtCeiling.length).toBe(MAX_NAME_LENGTH);
  expect(
    overlongDisclosedColumnPositions(metadataSending(astralAtCeiling)),
  ).toEqual([]);
});

test("overlongDisclosedColumnPositions: an oversized name that is not sent is not reported", () => {
  // The scope decision, pinned: an oversized header is fully usable for matching
  // and ignoring, and refusing it would refuse a file over a name that goes
  // nowhere. Both ways of not disclosing it are covered.
  expect(
    overlongDisclosedColumnPositions(metadataSending(pastCeiling, false)),
  ).toEqual([]);
  expect(
    overlongDisclosedColumnPositions([
      { name: pastCeiling, type: "other", role: "payload", isPayload: false },
    ]),
  ).toEqual([]);
});

test("overlongDisclosedColumnPositions: every offending position is reported, in metadata order", () => {
  expect(
    overlongDisclosedColumnPositions([
      { name: pastCeiling, type: "other", role: "payload", isPayload: true },
      { name: "ok", type: "other", role: "payload", isPayload: true },
      {
        name: pastCeiling + "b",
        type: "other",
        role: "payload",
        isPayload: true,
      },
    ]),
  ).toEqual([1, 3]);
});

// --- assertDisclosedNamesCarriable -------------------------------------------

test("assertDisclosedNamesCarriable: refuses as a UsageError naming positions, never the name", () => {
  let thrown: unknown;
  try {
    assertDisclosedNamesCarriable(metadataSending(pastCeiling), SHARES);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(UsageError);
  const message = String(thrown);
  expect(message).toMatch(/metadata column 2 /);
  expect(message).toContain(`${MAX_NAME_LENGTH}-character limit`);
  // The offending name is longer than any message that would hold it, so it is
  // located rather than echoed.
  expect(message).not.toContain(pastCeiling);
});

test("assertDisclosedNamesCarriable: passes a disclosed name at the ceiling", () => {
  expect(() =>
    assertDisclosedNamesCarriable(metadataSending(atCeiling), SHARES),
  ).not.toThrow();
});

test("assertDisclosedNamesCarriable: pluralizes for several offending columns", () => {
  let thrown: unknown;
  try {
    assertDisclosedNamesCarriable(
      [
        { name: pastCeiling, type: "other", role: "payload", isPayload: true },
        {
          name: pastCeiling + "b",
          type: "other",
          role: "payload",
          isPayload: true,
        },
      ],
      SHARES,
    );
  } catch (err) {
    thrown = err;
  }
  expect(String(thrown)).toMatch(/metadata columns 1, 2 .*are sent/);
});

test("assertDisclosedNamesCarriable: says nothing when the partner is entitled to no result", () => {
  // Nothing leaves the machine whatever the metadata discloses, so no name
  // needs the bound, and a refusal would fail an exchange that runs. The same
  // output gate assertPayloadSendDisclosed applies to its empty case.
  expect(() =>
    assertDisclosedNamesCarriable(metadataSending(pastCeiling), SHARES_NOTHING),
  ).not.toThrow();
});

// --- prepareForExchange wiring -----------------------------------------------

const rows = [{ first_name: "Alice" }];

test("prepareForExchange: refuses an oversized disclosed CSV header before it prepares anything", () => {
  // The unbounded path this gate exists for: no metadata in the spec, so it is
  // inferred from the header, where an unrecognized column becomes transmitted
  // payload by default.
  let thrown: unknown;
  try {
    prepareForExchange({ linkageTerms: terms }, "Sender", rows, [
      "first_name",
      pastCeiling,
    ]);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(UsageError);
  expect(String(thrown)).toMatch(/metadata column 2 /);
});

test("prepareForExchange: accepts a disclosed header at the ceiling", () => {
  expect(() =>
    prepareForExchange({ linkageTerms: terms }, "Sender", rows, [
      "first_name",
      atCeiling,
    ]),
  ).not.toThrow();
});

test("prepareForExchange: accepts an oversized disclosed header when the partner receives no result", () => {
  // The direction reaches the gate: with nothing transmitted, an over-long name
  // goes nowhere and the exchange runs.
  expect(() =>
    prepareForExchange(
      { linkageTerms: { ...terms, output: SHARES_NOTHING } },
      "Sender",
      rows,
      ["first_name", pastCeiling],
    ),
  ).not.toThrow();
});

test("prepareForExchange: accepts an oversized header the metadata does not transmit", () => {
  expect(() =>
    prepareForExchange(
      { linkageTerms: terms, metadata: metadataSending(pastCeiling, false) },
      "Sender",
      rows,
      ["first_name", pastCeiling],
    ),
  ).not.toThrow();
});

// --- runExchange wiring (the bypass seat) ------------------------------------

// The run boundary re-checks the bound, so a PreparedExchange assembled without
// going through prepareForExchange is refused before anything reaches the
// partner. Every collaborator the run would touch throws when used, so the
// refusal is what the rejection can come from -- a connection frame or a PSI call
// would show up as its own error, failing these assertions.
const failIfUsed = (what: string) => (): never => {
  throw new Error(`${what} was used past the disclosed-name refusal`);
};
const unusableConnection = (): MessageConnection => ({
  send: failIfUsed("the connection"),
  receive: failIfUsed("the connection"),
  close: failIfUsed("the connection"),
});
const unusablePsiLibrary = new Proxy({} as PSILibrary, {
  get: failIfUsed("the PSI library"),
});

test("runExchange refuses an oversized disclosed name before it connects", async () => {
  // Built legitimately -- a carriable disclosed name -- then given metadata whose
  // disclosed name is over the ceiling, the way a caller that skipped
  // prepareForExchange could.
  const prepared = prepareForExchange({ linkageTerms: terms }, "Sender", rows, [
    "first_name",
    atCeiling,
  ]);
  prepared.metadata = metadataSending(pastCeiling);

  const run = runExchange(unusableConnection(), "initiator", prepared, {
    psiLibrary: unusablePsiLibrary,
  });
  await expect(run).rejects.toThrow(UsageError);
  await expect(run).rejects.toThrow(/metadata column 2 /);
});

test("runExchange reads the output declaration the run carries, not the one prepare gated on", async () => {
  // The other half of the bypass: an oversized name prepared under terms entitling
  // the partner to no result -- where nothing travels, so prepare passes it --
  // then given sharing terms, which is when the name would travel.
  const prepared = prepareForExchange(
    { linkageTerms: { ...terms, output: SHARES_NOTHING } },
    "Sender",
    rows,
    ["first_name", pastCeiling],
  );
  prepared.linkageTerms = { ...terms, output: SHARES };

  const run = runExchange(unusableConnection(), "initiator", prepared, {
    psiLibrary: unusablePsiLibrary,
  });
  await expect(run).rejects.toThrow(UsageError);
  await expect(run).rejects.toThrow(/metadata column 2 /);
});

test("runExchange runs past the guard for a carriable disclosed name", async () => {
  // The sibling of the refusal: with the same unusable collaborators, a disclosed
  // name at the ceiling reaches the terms exchange, so the failure is the
  // connection's -- proof the refusals above fired on the name rather than on the
  // fixtures.
  const prepared = prepareForExchange({ linkageTerms: terms }, "Sender", rows, [
    "first_name",
    atCeiling,
  ]);
  const run = runExchange(unusableConnection(), "initiator", prepared, {
    psiLibrary: unusablePsiLibrary,
  });
  await expect(run).rejects.toThrow(/the connection was used/);
});

// --- the gate and the wire agree ---------------------------------------------

test("the send-side gate refuses exactly the names the partner's parse refuses", async () => {
  // The property the two bounds have to hold jointly: nothing the gate passes is
  // refused after the frame is sent, and nothing it refuses would have
  // crossed. Driven at the astral boundary, where a code-point count would put
  // the two on opposite sides.
  for (const name of [atCeiling, astralAtCeiling]) {
    expect(overlongDisclosedColumnPositions(metadataSending(name))).toEqual([]);
    const [a, b] = createMessagePipe();
    const receiving = exchangePayloads(a, "initiator", { hasData: false });
    await b.receive();
    await b.send({
      hasData: true,
      columns: [name],
      rowIndices: [0],
      rows: [["v"]],
    });
    expect((await receiving).columns).toEqual([name]);
  }

  for (const name of [pastCeiling, astralUnderCodePointsOverUnits]) {
    expect(overlongDisclosedColumnPositions(metadataSending(name))).toEqual([
      2,
    ]);
    const [a, b] = createMessagePipe();
    const receiving = exchangePayloads(a, "initiator", { hasData: false });
    await b.receive();
    await b.send({
      hasData: true,
      columns: [name],
      rowIndices: [0],
      rows: [["v"]],
    });
    const err = await receiving.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConnectionError);
    expect((err as ConnectionError).kind).toBe("protocol");
  }
});
