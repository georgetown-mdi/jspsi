import { expect, test } from "vitest";

import {
  assessOutboundPayloadConsent,
  assertOutboundPayloadConsented,
} from "../src/payloadExchange";
import { prepareForExchange, resolveExchangeInputs } from "../src/exchange";
import { parseExchangeSpec } from "../src/config/exchangeSpec";
import { UsageError } from "../src/errors";

import type { Metadata } from "../src/config/metadata";
import type { LinkageTerms, Output } from "../src/config/linkageTerms";
import type { OutboundPayloadConsent } from "../src/config/outboundPayloadConsent";

// The acceptor shape this whole mechanism exists for: an invitation authors the
// inviter's send and no receive, so the mirror leaves the acceptor's own
// `payload.send` ABSENT and its outbound set comes from its own CSV header, where
// every unrecognized column is transmitted by default. The consent record is what
// makes that set chosen rather than inferred, so these fixtures deliberately carry
// no payload block at all.

const acceptorTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "Acceptor",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "first_name", type: "first_name" }],
  linkageKeys: [{ name: "FN", elements: [{ field: "first_name" }] }],
};

const SHARES: Output = { expectsOutput: true, shareWithPartner: true };
const SHARES_NOTHING: Output = { expectsOutput: true, shareWithPartner: false };

/** Metadata whose disclosed set is exactly `columns`, plus a linkage column. */
function metadataDisclosing(columns: string[]): Metadata {
  return [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    ...columns.map((name) => ({
      name,
      type: "other" as const,
      role: "payload" as const,
      isPayload: true,
    })),
  ];
}

// --- assessOutboundPayloadConsent --------------------------------------------

test("assessOutboundPayloadConsent: no record leaves the party lazy, as every non-acceptor is", () => {
  // An inviter, a zero-setup run, and a hand-authored config carry no record: the
  // field's absence is the whole of the backwards-compatible path, so it must not
  // be readable as anything else.
  expect(
    assessOutboundPayloadConsent(
      undefined,
      metadataDisclosing(["diagnosis"]),
      SHARES,
    ),
  ).toEqual({ status: "not-required", reason: "no-record" });
});

test("assessOutboundPayloadConsent: nothing transmitted needs no confirmation, even unconfirmed", () => {
  // runExchange builds this party's payload only when the PARTNER is entitled to
  // the result, so with shareWithPartner false no column leaves whatever the
  // metadata discloses -- the same output gate assertPayloadSendDisclosed applies,
  // and the same one the acceptance display's no-payload line states.
  expect(
    assessOutboundPayloadConsent(
      { status: "pending" },
      metadataDisclosing(["diagnosis"]),
      SHARES_NOTHING,
    ),
  ).toEqual({ status: "not-required", reason: "nothing-transmitted" });
});

test("assessOutboundPayloadConsent: a pending record names the set it would send", () => {
  // The accept-with-no-input case. The verdict carries the resolved set so the
  // surface that asks can show what it is asking about, not merely that it must.
  const verdict = assessOutboundPayloadConsent(
    { status: "pending" },
    metadataDisclosing(["diagnosis", "notes"]),
    SHARES,
  );
  expect(verdict).toEqual({
    status: "confirmation-required",
    reason: "unconfirmed",
    columns: ["diagnosis", "notes"],
    confirmed: undefined,
    added: [],
    removed: [],
  });
});

test("assessOutboundPayloadConsent: a confirmed set the run still resolves is current", () => {
  const verdict = assessOutboundPayloadConsent(
    { status: "confirmed", columns: ["diagnosis", "notes"] },
    metadataDisclosing(["diagnosis", "notes"]),
    SHARES,
  );
  expect(verdict).toEqual({
    status: "current",
    columns: ["diagnosis", "notes"],
  });
});

test("assessOutboundPayloadConsent: a reordered header is not a changed disclosure", () => {
  // Metadata order decides the order columns are transmitted in, not WHICH are, so
  // comparing by order would ask the operator to re-confirm a disclosure that did
  // not change -- and a confirmation asked for nothing is one answered without
  // reading.
  expect(
    assessOutboundPayloadConsent(
      { status: "confirmed", columns: ["notes", "diagnosis"] },
      metadataDisclosing(["diagnosis", "notes"]),
      SHARES,
    ).status,
  ).toBe("current");
});

test("assessOutboundPayloadConsent: a widened set reports what was added", () => {
  // The input file changed between accept and run and now discloses one more
  // column: the disclosure this party consented to would silently grow.
  const verdict = assessOutboundPayloadConsent(
    { status: "confirmed", columns: ["diagnosis"] },
    metadataDisclosing(["diagnosis", "ssn_note"]),
    SHARES,
  );
  expect(verdict).toEqual({
    status: "confirmation-required",
    reason: "changed",
    columns: ["diagnosis", "ssn_note"],
    confirmed: ["diagnosis"],
    added: ["ssn_note"],
    removed: [],
  });
});

test("assessOutboundPayloadConsent: a narrowed set is a mismatch too", () => {
  // Narrowing discloses less, but the exchange record and the partner's consent
  // surface state the CONFIRMED set, so a run that transmits a different one is
  // still transmitting a set no party chose. It asks again rather than proceed.
  const verdict = assessOutboundPayloadConsent(
    { status: "confirmed", columns: ["diagnosis", "notes"] },
    metadataDisclosing(["diagnosis"]),
    SHARES,
  );
  expect(verdict).toMatchObject({
    status: "confirmation-required",
    reason: "changed",
    added: [],
    removed: ["notes"],
  });
});

test("assessOutboundPayloadConsent: a confirmed empty set against an empty disclosure is current", () => {
  // Confirming that nothing is sent is a real confirmation, not an absent record,
  // and a run that still sends nothing honors it.
  expect(
    assessOutboundPayloadConsent(
      { status: "confirmed", columns: [] },
      metadataDisclosing([]),
      SHARES,
    ),
  ).toEqual({ status: "current", columns: [] });
});

test("assessOutboundPayloadConsent: a confirmed empty set against any disclosure asks again", () => {
  expect(
    assessOutboundPayloadConsent(
      { status: "confirmed", columns: [] },
      metadataDisclosing(["diagnosis"]),
      SHARES,
    ),
  ).toMatchObject({ reason: "changed", added: ["diagnosis"] });
});

// --- assertOutboundPayloadConsented ------------------------------------------

test("assertOutboundPayloadConsented: an unconfirmed set is refused, naming it and how to confirm", () => {
  expect(() =>
    assertOutboundPayloadConsented(
      { status: "pending" },
      metadataDisclosing(["diagnosis"]),
      SHARES,
    ),
  ).toThrow(UsageError);
  const err = (() => {
    try {
      assertOutboundPayloadConsented(
        { status: "pending" },
        metadataDisclosing(["diagnosis"]),
        SHARES,
      );
    } catch (e) {
      return e as Error;
    }
    throw new Error("expected a refusal");
  })();
  expect(err.message).toContain("diagnosis");
  expect(err.message).toContain("interactive terminal");
  expect(err.message).toContain("naming your input file");
});

test("assertOutboundPayloadConsented: a changed set is refused, naming both directions", () => {
  const err = (() => {
    try {
      assertOutboundPayloadConsented(
        { status: "confirmed", columns: ["diagnosis", "notes"] },
        metadataDisclosing(["diagnosis", "ssn_note"]),
        SHARES,
      );
    } catch (e) {
      return e as Error;
    }
    throw new Error("expected a refusal");
  })();
  expect(err).toBeInstanceOf(UsageError);
  expect(err.message).toContain("ssn_note");
  expect(err.message).toContain("notes");
});

test("assertOutboundPayloadConsented: the passing cases throw nothing", () => {
  const metadata = metadataDisclosing(["diagnosis"]);
  expect(() =>
    assertOutboundPayloadConsented(undefined, metadata, SHARES),
  ).not.toThrow();
  expect(() =>
    assertOutboundPayloadConsented(
      { status: "confirmed", columns: ["diagnosis"] },
      metadata,
      SHARES,
    ),
  ).not.toThrow();
  expect(() =>
    assertOutboundPayloadConsented(
      { status: "pending" },
      metadata,
      SHARES_NOTHING,
    ),
  ).not.toThrow();
});

// --- prepareForExchange wiring -----------------------------------------------

// The run-boundary backstop: whatever front end prepared the exchange, a set this
// party never confirmed does not reach a connection. These drive the CSV-header
// path (no metadata in the spec), which is the acceptor's own -- an unrecognized
// column becomes transmitted payload with no operator choice involved.

const acceptorRows = [{ first_name: "Alice", diagnosis: "A" }];
const acceptorColumns = ["first_name", "diagnosis"];

test("prepareForExchange: refuses a pending consent before it prepares anything", () => {
  expect(() =>
    prepareForExchange(
      {
        linkageTerms: acceptorTerms,
        outboundPayloadConsent: { status: "pending" },
      },
      "Acceptor",
      acceptorRows,
      acceptorColumns,
    ),
  ).toThrow(/has not confirmed which of its own columns/);
});

test("prepareForExchange: refuses a set widened since it was confirmed", () => {
  // The acceptor confirmed a CSV disclosing nothing but the linkage column; this
  // run's CSV adds one, which inferMetadata makes transmittable by default.
  expect(() =>
    prepareForExchange(
      {
        linkageTerms: acceptorTerms,
        outboundPayloadConsent: { status: "confirmed", columns: [] },
      },
      "Acceptor",
      acceptorRows,
      acceptorColumns,
    ),
  ).toThrow(/diagnosis/);
});

test("prepareForExchange: prepares normally once the resolved set is the confirmed one", () => {
  const prepared = prepareForExchange(
    {
      linkageTerms: acceptorTerms,
      outboundPayloadConsent: { status: "confirmed", columns: ["diagnosis"] },
    },
    "Acceptor",
    acceptorRows,
    acceptorColumns,
  );
  expect(prepared.metadata.map((c) => c.name)).toEqual(acceptorColumns);
});

test("prepareForExchange: a party with no consent record is untouched", () => {
  // The compatibility property the absent field carries: every exchange that
  // predates this record, and every non-acceptor, prepares exactly as before.
  expect(() =>
    prepareForExchange(
      { linkageTerms: acceptorTerms },
      "Acceptor",
      acceptorRows,
      acceptorColumns,
    ),
  ).not.toThrow();
});

// --- resolveExchangeInputs ---------------------------------------------------

test("resolveExchangeInputs: resolves what prepareForExchange resolves", () => {
  // The confirmation asks about the set a front end resolved BEFORE preparing, so
  // the two resolutions have to be the same one. This pins that on both branches:
  // a spec that carries metadata, and one whose metadata comes from the header.
  for (const spec of [
    { linkageTerms: acceptorTerms },
    {
      linkageTerms: acceptorTerms,
      metadata: metadataDisclosing(["diagnosis"]),
    },
  ]) {
    const resolved = resolveExchangeInputs(spec, "Acceptor", acceptorColumns);
    const prepared = prepareForExchange(
      spec,
      "Acceptor",
      acceptorRows,
      acceptorColumns,
    );
    expect(resolved.metadata).toStrictEqual(prepared.metadata);
    expect(resolved.linkageTerms).toStrictEqual(prepared.linkageTerms);
  }
});

test("resolveExchangeInputs: derives default terms for a spec that carries none", () => {
  // The zero-setup shape, where the terms themselves come from the header.
  const resolved = resolveExchangeInputs({}, "Acceptor", acceptorColumns);
  expect(resolved.linkageTerms.identity).toBe("Acceptor");
  expect(resolved.metadata.map((c) => c.name)).toEqual(acceptorColumns);
});

// --- Schema ------------------------------------------------------------------

test("parseExchangeSpec: reads the snake_case consent record off disk", () => {
  const spec = parseExchangeSpec({
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkage_terms: {
      version: "1.0.0",
      identity: "Acceptor",
      date: "2026-01-01",
      algorithm: "psi",
      output: { expects_output: true, share_with_partner: true },
      deduplicate: false,
      linkage_fields: [{ name: "first_name", type: "first_name" }],
      linkage_keys: [{ name: "FN", elements: [{ field: "first_name" }] }],
    },
    outbound_payload_consent: {
      status: "confirmed",
      columns: ["diagnosis"],
    },
  });
  const expected: OutboundPayloadConsent = {
    status: "confirmed",
    columns: ["diagnosis"],
  };
  expect(spec.outboundPayloadConsent).toEqual(expected);
});

test("parseExchangeSpec: a confirmed record without columns is not representable", () => {
  // The discriminated union is what keeps "confirmed" from meaning "confirmed
  // nothing in particular", which would pass the check against any set at all.
  expect(() =>
    parseExchangeSpec({
      connection: { channel: "filedrop", path: "/mnt/share" },
      linkage_terms: {
        version: "1.0.0",
        identity: "Acceptor",
        date: "2026-01-01",
        algorithm: "psi",
        output: { expects_output: true, share_with_partner: true },
        deduplicate: false,
        linkage_fields: [{ name: "first_name", type: "first_name" }],
        linkage_keys: [{ name: "FN", elements: [{ field: "first_name" }] }],
      },
      outbound_payload_consent: { status: "confirmed" },
    }),
  ).toThrow();
});
