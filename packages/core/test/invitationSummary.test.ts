import { describe, expect, test } from "vitest";

import { getDefaultLinkageTerms } from "../src/defaults/linkageTerms.js";
import {
  summarizeInvitation,
  TRANSFORM_FUNCTION_GLOSSARY,
} from "../src/invitationSummary.js";
import { disclosedColumnNames, inferMetadata } from "../src/config/metadata.js";

import type { ConnectionEndpoint } from "../src/config/invitation.js";

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
});

describe("the consent summary's retain disclosure", () => {
  const terms = getDefaultLinkageTerms(
    "Inviter",
    inferMetadata(LINKAGE_ONLY_COLUMNS),
  );
  const SPLIT_ENDPOINT: ConnectionEndpoint = {
    channel: "filedrop",
    inboundPath: "/mnt/share/in",
    outboundPath: "/mnt/share/out",
  };
  const SHARED_ENDPOINT: ConnectionEndpoint = {
    channel: "filedrop",
    path: "/mnt/share",
  };

  test("states retention where the token declares it", () => {
    expect(
      summarizeInvitation({ linkageTerms: terms, inviterRetainsFiles: true })
        .disclosesRetainedFiles,
    ).toBe(true);
  });

  // The second ground, and the gap it closes: a split-directory endpoint seeds
  // the accepting side into retain mode whatever the token declares (a split
  // connection cannot be configured without it), so a display reading only the
  // declaration would leave that party consenting to a permanent transcript with
  // nothing said. psilink's own mints do not produce this pair, but a foreign or
  // older token can, and the shape is decidable right here at display time.
  test("states retention for a split-directory endpoint that declares nothing", () => {
    expect(
      summarizeInvitation({
        linkageTerms: terms,
        connectionEndpoint: SPLIT_ENDPOINT,
      }).disclosesRetainedFiles,
    ).toBe(true);
  });

  // The shape test is the seeding's own predicate, so it must not widen to "has
  // an endpoint": a single shared directory seeds no options at all, and its
  // acceptor sets its own mode.
  test("states nothing for a shared-directory endpoint that declares nothing", () => {
    expect(
      summarizeInvitation({
        linkageTerms: terms,
        connectionEndpoint: SHARED_ENDPOINT,
      }).disclosesRetainedFiles,
    ).toBe(false);
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
    {
      case: "a webrtc endpoint, which has no retain mode",
      source: {
        connectionEndpoint: {
          channel: "webrtc",
          host: "peer.example",
        } as ConnectionEndpoint,
      },
    },
  ])("discloses no retention for $case", ({ source }) => {
    expect(
      summarizeInvitation({ linkageTerms: terms, ...source })
        .disclosesRetainedFiles,
    ).toBe(false);
  });

  // A declared delete mode does not cancel the shape: the acceptor is still
  // seeded into retain mode by the split pair, so the line it is shown states
  // the mode its own run would be in. Through decode this pair can no longer
  // arrive -- the token schema's refusal is pinned by invitation.test.ts's
  // retain-declaration cases -- but summarizeInvitation also renders non-token
  // sources, such as the inviter's own pre-mint preview, so the branch stays
  // live rather than dead.
  test("a split endpoint states retention even against a declared false", () => {
    expect(
      summarizeInvitation({
        linkageTerms: terms,
        connectionEndpoint: SPLIT_ENDPOINT,
        inviterRetainsFiles: false,
      }).disclosesRetainedFiles,
    ).toBe(true);
  });
});

describe("the consent summary's fan-out register", () => {
  const metadata = inferMetadata(LINKAGE_ONLY_COLUMNS);
  const baseTerms = getDefaultLinkageTerms("Inviter", metadata);
  const fanOutTerms = {
    ...baseTerms,
    linkageKeys: [
      {
        name: "last name",
        elements: [
          {
            field: "last_name",
            transform: [{ function: "split_on", params: { delimiter: " " } }],
          },
        ],
      },
    ],
  };

  test("a fan-out element under single-pass is marked as matching on several values", () => {
    // The element matches on every candidate it realizes, so the header marker
    // names that breadth. The two flags beside it are what selects the consent
    // fact each surface renders.
    const summary = summarizeInvitation({
      linkageTerms: { ...fanOutTerms, linkageStrategy: "single-pass" },
    });
    expect(summary.linkageKeys[0].headerFields).toEqual([
      "last name (multiple)",
    ]);
    expect(summary.fansOut).toBe(true);
    expect(summary.fanOutApplied).toBe(true);
  });

  test("the same element under cascade is marked as not supported", () => {
    // Refused before the exchange runs, so no matching of any breadth happens
    // and naming one would describe a run that does not occur.
    const summary = summarizeInvitation({
      linkageTerms: { ...fanOutTerms, linkageStrategy: "cascade" },
    });
    expect(summary.linkageKeys[0].headerFields).toEqual([
      "last name (not supported)",
    ]);
    expect(summary.fansOut).toBe(true);
    expect(summary.fanOutApplied).toBe(false);
  });

  test("terms declaring no fan-out are in neither register", () => {
    const summary = summarizeInvitation({
      linkageTerms: { ...baseTerms, linkageStrategy: "single-pass" },
    });
    expect(summary.fansOut).toBe(false);
  });

  test("the deduplicate register follows the same strategy split, the other way", () => {
    // The cascade matches a deduplicating cardinality and single-pass matches
    // none, so the applied flag is the strategy's verdict on the term -- the
    // signal a surface reads to withhold what a deduplicating run discloses for
    // an invitation acceptance refuses outright.
    const applied = (linkageStrategy: "cascade" | "single-pass"): boolean =>
      summarizeInvitation({
        linkageTerms: { ...baseTerms, deduplicate: true, linkageStrategy },
      }).deduplicateApplied;
    expect(applied("cascade")).toBe(true);
    expect(applied("single-pass")).toBe(false);
  });

  test("the glossary line for the splitting step describes what it does to matching", () => {
    // The line an acceptor reads beside the step, which must state the widening
    // rather than a refusal that no longer covers every strategy.
    expect(TRANSFORM_FUNCTION_GLOSSARY.split_on).toMatch(
      /each able to match independently/,
    );
    expect(TRANSFORM_FUNCTION_GLOSSARY.split_on).not.toMatch(/refuses/);
  });
});
