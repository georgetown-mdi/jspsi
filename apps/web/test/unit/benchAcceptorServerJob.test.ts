import { describe, expect, test } from "vitest";

import { disclosedColumnNames } from "@psilink/core";

import { acceptorServerJobConfig } from "@bench/useAcceptorExchange";

import type {
  InvitationToken,
  LinkageTerms,
  Metadata,
  Standardization,
} from "@psilink/core";
import type { AcceptorDataEdits } from "@psi/acceptInvitation";

// The inviter-perspective terms an accepted invitation carries: the inviter is
// the identity, it SENDS `program_code` and REQUESTS nothing back, and it shares
// the result with the acceptor. The acceptor's server-job config must run on the
// MIRROR of these, not this raw set.
const inviterTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: false, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
  payload: {
    send: [{ name: "program_code" }],
  },
};

const token: InvitationToken = {
  version: "1",
  linkageTerms: inviterTerms,
  sharedSecret: "a".repeat(43),
  disclosedPayloadColumns: ["program_code"],
};

// The acceptor's OWN authored column metadata (its own CSV namespace). `secret`
// is roled `ignored`, and `notes` is a plain payload column the operator chose to
// disclose. This is the operator's data-prep edit the server-job path must carry
// so the appliance's CLI honors it rather than inferring metadata from the column
// names -- inference would default the unrecognized `secret` column to disclosed
// payload.
const editedMetadata: Metadata = [
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
  { name: "notes", type: "other", role: "payload", isPayload: true },
  { name: "secret", type: "other", role: "ignored", isPayload: true },
];

const editedStandardization: Standardization = [
  {
    output: "firstName",
    input: "first_name",
    steps: [{ function: "trim" }, { function: "to_lowercase" }],
  },
];

const edits: AcceptorDataEdits = {
  metadata: editedMetadata,
  standardization: editedStandardization,
};

const inputCsv = "first_name,last_name,notes,secret\nAlice,Smith,hi,shh\n";

function configFor() {
  return acceptorServerJobConfig({
    token,
    acceptorName: "Accepting Org",
    edits,
    inputCsv,
  });
}

describe("acceptorServerJobConfig", () => {
  test("runs on the acceptor's OWN-PERSPECTIVE derived terms, not the raw inviter terms", () => {
    const config = configFor();

    // Identity is the acceptor's, not the inviter's.
    expect(config.linkageTerms.identity).toBe("Accepting Org");
    expect(config.linkageTerms.identity).not.toBe(inviterTerms.identity);
    // Output direction is mirrored: the inviter does not expect output but shares,
    // so the acceptor expects output and does not share.
    expect(config.linkageTerms.output).toStrictEqual({
      expectsOutput: true,
      shareWithPartner: false,
    });
  });

  test("mirrors the payload so `receive` is the inviter's disclosed `send`", () => {
    const config = configFor();

    // This is the security-relevant lock-in source on the server-job path: with no
    // explicit expectedPayloadColumns in the composed config, the CLI enforces its
    // received-payload lock-in off linkageTerms.payload.receive, and the mirror
    // makes that equal the inviter's disclosed send -- the SAME set the browser
    // path locks in from disclosedPayloadColumns.
    expect(config.linkageTerms.payload?.receive).toEqual([
      { name: "program_code" },
    ]);
    expect(config.linkageTerms.payload?.receive?.map((c) => c.name)).toEqual(
      token.disclosedPayloadColumns,
    );
  });

  test("carries the acceptor's raw CSV text and the token's shared secret verbatim", () => {
    const config = configFor();

    expect(config.inputCsv).toBe(inputCsv);
    expect(config.sharedSecret).toBe(token.sharedSecret);
  });

  test("carries the operator's authored metadata and standardization edits", () => {
    const config = configFor();

    expect(config.metadata).toEqual(editedMetadata);
    expect(config.standardization).toEqual(editedStandardization);
  });

  test("an operator-ignored column is NOT disclosed on the server-job path", () => {
    // The actual disclosure gap this slice closes: without the carried metadata
    // the appliance's CLI would infer `secret` as an unrecognized column and
    // default it to disclosed payload. The carried metadata roles it `ignored`, so
    // isDisclosedToPartner excludes it -- the single source of truth for what
    // leaves the machine. `notes`, a real payload column, is still disclosed.
    const config = configFor();
    const disclosed = disclosedColumnNames(config.metadata ?? []);
    expect(disclosed).toContain("notes");
    expect(disclosed).not.toContain("secret");
  });
});
