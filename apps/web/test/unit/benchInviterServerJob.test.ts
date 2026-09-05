import { describe, expect, test } from "vitest";

import { inviterServerJobConfig } from "@bench/useInviterExchange";

import type { LinkageTerms, Metadata, Standardization } from "@psilink/core";

// The terms embedded in the minted token: this party is the identity, it SENDS
// `program_code` and requests nothing back. The inviter's server-job config runs
// on these verbatim -- the acceptor is the side that mirrors them.
const mintedTerms: LinkageTerms = {
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

// The inviter's OWN authored column metadata, as the mint resolved it. `secret` is
// roled `ignored`: the server-job path must hold these edits so the console's
// CLI honors them rather than inferring metadata from the column names.
const mintedMetadata: Metadata = [
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
  { name: "program_code", type: "other", role: "payload", isPayload: true },
  { name: "secret", type: "other", role: "ignored", isPayload: true },
];

const mintedStandardization: Standardization = [
  {
    output: "firstName",
    input: "first_name",
    steps: [{ function: "trim" }, { function: "to_lowercase" }],
  },
];

const sharedSecret = "a".repeat(43);

const minted = {
  linkageTerms: mintedTerms,
  sharedSecret,
  metadata: mintedMetadata,
  standardization: mintedStandardization,
};

const inputCsv =
  "first_name,last_name,program_code,secret\nAlice,Smith,42,shh\n";

function configFor() {
  return inviterServerJobConfig({
    minted,
    inputSource: { kind: "inline", csv: inputCsv },
    transport: { channel: "filedrop" },
  });
}

describe("inviterServerJobConfig", () => {
  test("states the inviter side, which is what records NO outbound consent", () => {
    // The composer derives an outbound_payload_consent record for the acceptance
    // alone. A config that stated the acceptor side here would record one against
    // terms this party already authored at mint -- the invitation IS its statement
    // of what it sends.
    expect(configFor().side).toBe("inviter");
  });

  test("runs on the minted terms verbatim, not a re-derived set", () => {
    // The set the partner adopts from the token and the set this run executes on
    // must be one and the same, or the terms-compatibility handshake fails.
    const config = configFor();

    expect(config.linkageTerms).toBe(mintedTerms);
    expect(config.linkageTerms.identity).toBe("County Health Department");
    expect(config.linkageTerms.output).toStrictEqual({
      expectsOutput: false,
      shareWithPartner: true,
    });
  });

  test("holds the inline CSV source and the mint's shared secret verbatim", () => {
    const config = configFor();

    expect(config.inputSource).toEqual({ kind: "inline", csv: inputCsv });
    expect(config.sharedSecret).toBe(sharedSecret);
  });

  test("threads a console workFile reference through as the input source verbatim", () => {
    // The console invite sources from the operator-mounted file: the driver config
    // holds only the reference (name + profiled freshness pair), never content, so
    // the console's create can resolve and freshness-check the mounted file.
    const workFile = {
      kind: "workFile" as const,
      name: "clients.csv",
      sizeBytes: 4096,
      modifiedAt: 1_700_000_000_000,
    };
    const config = inviterServerJobConfig({
      minted,
      inputSource: workFile,
      transport: { channel: "filedrop" },
    });
    expect(config.inputSource).toEqual(workFile);
  });

  test("rides the transport it is given (filedrop)", () => {
    expect(configFor().transport).toEqual({ channel: "filedrop" });
  });

  test("rides the sftp transport for a console SFTP invite", () => {
    // The console SFTP invite runs the same server job on the sftp intent arm; the
    // arm holds no connection field (the console reads the operator-authored
    // connection off GET /api/jobs/sftp), so only the channel changes here.
    const config = inviterServerJobConfig({
      minted,
      inputSource: { kind: "inline", csv: inputCsv },
      transport: { channel: "sftp" },
    });
    expect(config.transport).toEqual({ channel: "sftp" });
    // Everything below the transport discriminant is channel-independent.
    expect(config.side).toBe("inviter");
    expect(config.linkageTerms).toBe(mintedTerms);
  });

  test("holds the mint's authored metadata and standardization", () => {
    const config = configFor();

    expect(config.metadata).toEqual(mintedMetadata);
    expect(config.standardization).toEqual(mintedStandardization);
  });

  test("forwards an unresolved metadata or standardization as absent", () => {
    // The mint's own guards leave these undefined; forwarding the key with an
    // undefined value would send an explicit null through the intent schema.
    const config = inviterServerJobConfig({
      minted: { linkageTerms: mintedTerms, sharedSecret },
      inputSource: { kind: "inline", csv: inputCsv },
      transport: { channel: "filedrop" },
    });
    expect(config).not.toHaveProperty("metadata");
    expect(config).not.toHaveProperty("standardization");
  });

  test("sets no received-payload commitment -- that one is the acceptor's", () => {
    // The commitment mirrors an invitation's disclosed set, which only the accepting
    // side has to mirror; the inviter authored the set itself.
    expect(configFor().expectedPayloadColumns).toBeUndefined();
  });
});
