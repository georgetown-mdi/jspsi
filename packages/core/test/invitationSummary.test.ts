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
