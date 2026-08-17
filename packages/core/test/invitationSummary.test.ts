import { describe, expect, test } from "vitest";

import { getDefaultLinkageTerms } from "../src/defaults/linkageTerms.js";
import { summarizeInvitation } from "../src/invitationSummary.js";
import { disclosedColumnNames, inferMetadata } from "../src/config/metadata.js";

// A linkable column set (ssn + names + dob give satisfiable keys) that ALSO
// carries columns the inferred metadata discloses: `notes` infers as an `other`
// column (role payload) and `member_id` as a single row-identifier left
// isPayload, so both are transmitted.
const DISCLOSING_COLUMNS = [
  "ssn",
  "first_name",
  "last_name",
  "dob",
  "notes",
  "member_id",
];

const LINKAGE_ONLY_COLUMNS = ["ssn", "first_name", "last_name", "dob"];

describe("the consent summary's payload block", () => {
  test("derives the received set from the carried subset with no payload.send authored", () => {
    // A CLI-style invitation: the terms author no payload block, but the token
    // carries the disclosed-columns subset. The acceptor's consent display must
    // derive the columns-it-will-receive from that carried set -- the same
    // predicate the wire transmits on -- not from the (absent) payload.send. This
    // is the under-declaration gap the dedicated field closes, and the no-drift
    // invariant: the displayed set equals the transmitted set over one metadata.
    const metadata = inferMetadata(DISCLOSING_COLUMNS);
    const disclosed = disclosedColumnNames(metadata);
    const terms = getDefaultLinkageTerms("Inviter", metadata);
    expect(terms.payload).toBeUndefined();
    const summary = summarizeInvitation({
      linkageTerms: terms,
      disclosedPayloadColumns: disclosed,
    });
    expect(summary.payload?.send).toEqual(disclosed);
  });

  test("records which source the displayed send set came from", () => {
    // Both sources are declarations, and only one of them is a lock-in: an
    // acceptance writes the CARRIED subset as what it will receive and reconciles
    // against it, while an authored send with no carried subset leaves nothing to
    // reconcile against. A surface classifying the received-columns line reads
    // this narrower flag, so it is pinned apart from sendDeclared.
    const metadata = inferMetadata(DISCLOSING_COLUMNS);
    const terms = getDefaultLinkageTerms("Inviter", metadata);
    const authoredSend = { payload: { send: [{ name: "notes" }] } };
    const authored = summarizeInvitation({
      linkageTerms: { ...terms, ...authoredSend },
    });
    expect(authored.payload).toMatchObject({
      send: ["notes"],
      sendDeclared: true,
      sendFromCarriedSubset: false,
    });
    const carried = summarizeInvitation({
      linkageTerms: { ...terms, ...authoredSend },
      disclosedPayloadColumns: disclosedColumnNames(metadata),
    });
    expect(carried.payload).toMatchObject({
      send: disclosedColumnNames(metadata),
      sendDeclared: true,
      sendFromCarriedSubset: true,
    });
  });

  test("shows no received columns when nothing is carried or authored", () => {
    const terms = getDefaultLinkageTerms(
      "Inviter",
      inferMetadata(LINKAGE_ONLY_COLUMNS),
    );
    const summary = summarizeInvitation({ linkageTerms: terms });
    expect(summary.payload).toBeUndefined();
  });

  test("surfaces an empty carried subset as a declared 'receive nothing'", () => {
    // The web inviter always carries the disclosed subset, possibly empty. An empty
    // carried set is the strict "receive nothing" lock-in (a later non-empty payload
    // aborts), NOT the lazy case -- so the section is rendered with an empty,
    // DECLARED send (the renderer shows "(none)"), distinct from a lazy/absent set
    // which suppresses the section. This keeps the consent surfaces and the runtime
    // enforcement aligned.
    const terms = getDefaultLinkageTerms(
      "Inviter",
      inferMetadata(LINKAGE_ONLY_COLUMNS),
    );
    const summary = summarizeInvitation({
      linkageTerms: terms,
      disclosedPayloadColumns: [],
    });
    expect(summary.payload).toEqual({
      send: [],
      sendDeclared: true,
      sendFromCarriedSubset: true,
      receive: [],
      receiveDeclared: false,
    });
  });

  test("surfaces an authored empty payload.receive as a declared request", () => {
    // The receive-side mirror of the declared-empty send case above: an authored
    // `payload.receive: []` is the strict "the acceptor sends nothing" assertion,
    // distinct from an absent receive (lazy). It must surface as a DECLARED receive
    // (receiveDeclared true, receive empty -> the renderer shows "(none)") so a
    // consent surface does not collapse it with the lazy case.
    const terms = getDefaultLinkageTerms(
      "Inviter",
      inferMetadata(LINKAGE_ONLY_COLUMNS),
    );
    const summary = summarizeInvitation({
      linkageTerms: { ...terms, payload: { receive: [] } },
    });
    expect(summary.payload).toEqual({
      send: [],
      sendDeclared: false,
      sendFromCarriedSubset: false,
      receive: [],
      receiveDeclared: true,
    });
  });

  test("suppresses the payload section for a lazy (absent) subset", () => {
    // No carried subset and no authored payload.send: the send side is lazy (the
    // inviter sends whatever its metadata discloses, nothing declared up front), so
    // the section is omitted -- distinct from the declared-empty case above.
    const terms = getDefaultLinkageTerms(
      "Inviter",
      inferMetadata(LINKAGE_ONLY_COLUMNS),
    );
    const summary = summarizeInvitation({ linkageTerms: terms });
    expect(summary.payload).toBeUndefined();
  });
});

describe("the consent summary's retain declaration", () => {
  const terms = getDefaultLinkageTerms(
    "Inviter",
    inferMetadata(LINKAGE_ONLY_COLUMNS),
  );

  test("states retention only where the token declares it", () => {
    expect(
      summarizeInvitation({ linkageTerms: terms, inviterRetainsFiles: true })
        .declaresRetainedFiles,
    ).toBe(true);
  });

  // The narrowing that keeps a renderer off the claim no surface may make. The
  // token's field is three-valued -- declared retain, declared delete, nothing
  // declared -- and the last two are alike here on purpose: neither is a promise
  // that the exchange cleans up after itself (a run killed outright, or one that
  // fails after the handshake, leaves files behind in either mode), so a surface
  // reading this flag cannot word one.
  test.each([
    { case: "an explicit false", source: { inviterRetainsFiles: false } },
    { case: "an absent declaration", source: {} },
  ])("declares no retention for $case", ({ source }) => {
    expect(
      summarizeInvitation({ linkageTerms: terms, ...source })
        .declaresRetainedFiles,
    ).toBe(false);
  });
});
