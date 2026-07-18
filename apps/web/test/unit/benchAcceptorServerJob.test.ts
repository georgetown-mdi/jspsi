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
    inputSource: { kind: "inline", csv: inputCsv },
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

    // The derive-mirror puts the inviter's disclosed send into the acceptor's
    // payload.receive -- the SAME set the browser path locks in from
    // disclosedPayloadColumns. On this fixture (payload.send aligned with
    // disclosedPayloadColumns) it also equals the explicit expectedPayloadColumns
    // lock-in below; the divergence describe exercises the shape where it does not.
    expect(config.linkageTerms.payload?.receive).toEqual([
      { name: "program_code" },
    ]);
    expect(config.linkageTerms.payload?.receive?.map((c) => c.name)).toEqual(
      token.disclosedPayloadColumns,
    );
  });

  test("carries the acceptor's inline CSV source and the token's shared secret verbatim", () => {
    const config = configFor();

    expect(config.inputSource).toEqual({ kind: "inline", csv: inputCsv });
    expect(config.sharedSecret).toBe(token.sharedSecret);
  });

  test("threads a console workFile reference through as the input source verbatim", () => {
    // The console accept sources from the operator-mounted file: the driver config
    // carries only the reference (name + profiled freshness pair), never content, so
    // the appliance's create can resolve and freshness-check the mounted file.
    const workFile = {
      kind: "workFile" as const,
      name: "clients.csv",
      sizeBytes: 4096,
      modifiedAt: 1_700_000_000_000,
    };
    const config = acceptorServerJobConfig({
      token,
      acceptorName: "Accepting Org",
      edits,
      inputSource: workFile,
    });
    expect(config.inputSource).toEqual(workFile);
  });

  test("rides the filedrop transport: the accept guard admits no sftp endpoint", () => {
    expect(configFor().transport).toEqual({ channel: "filedrop" });
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

  test("sets the received-payload lock-in from the disclosed set", () => {
    const config = configFor();
    expect(config.expectedPayloadColumns).toEqual(
      token.disclosedPayloadColumns,
    );
  });
});

// The received-payload lock-in the console acceptor must set EXPLICITLY, mirroring
// the browser accept path (acceptorExchange.ts sets prepared.expectedPayloadColumns
// from disclosedPayloadColumns). Without it the CLI falls back to
// linkageTerms.payload.receive, which is undefined for a token that discloses
// columns but carries no payload.send -- a fail-OPEN shape a malicious inviter can
// craft. These cases pin the empty-vs-absent distinction end to end.
describe("acceptorServerJobConfig received-payload lock-in", () => {
  // The inviter perspective a malicious inviter can craft: it advertises no
  // payload.send at all, yet the token discloses a column. The derive-mirror then
  // produces no payload.receive, so the CLI's fallback would be undefined and
  // reconcile lazily (fail open) unless expectedPayloadColumns is set explicitly.
  const noSendTerms: LinkageTerms = {
    ...inviterTerms,
    payload: undefined,
  };

  function tokenWith(disclosed: Array<string> | undefined): InvitationToken {
    return {
      version: "1",
      linkageTerms: noSendTerms,
      sharedSecret: "a".repeat(43),
      ...(disclosed !== undefined
        ? { disclosedPayloadColumns: disclosed }
        : {}),
    };
  }

  function configFrom(disclosed: Array<string> | undefined) {
    return acceptorServerJobConfig({
      token: tokenWith(disclosed),
      acceptorName: "Accepting Org",
      edits,
      inputSource: { kind: "inline", csv: inputCsv },
    });
  }

  test("locks in even when the token omits payload.send (the fail-open shape)", () => {
    const config = configFrom(["program_code"]);
    // The derive-mirror yields no payload.receive here, so the CLI fallback would be
    // undefined; the explicit lock-in is what enforces the received set.
    expect(config.linkageTerms.payload?.receive).toBeUndefined();
    expect(config.expectedPayloadColumns).toEqual(["program_code"]);
  });

  test("an empty disclosed set locks in strictly (receive nothing), not lazily", () => {
    const config = configFrom([]);
    // An empty array must SURVIVE as an empty array -- a strict "receive nothing" --
    // not be collapsed to undefined (which would reconcile lazily / fail open).
    expect(config.expectedPayloadColumns).toEqual([]);
    expect(config.expectedPayloadColumns).not.toBeUndefined();
  });

  test("an absent disclosed set leaves the lock-in undefined (lazy)", () => {
    const config = configFrom(undefined);
    expect(config.expectedPayloadColumns).toBeUndefined();
  });
});
