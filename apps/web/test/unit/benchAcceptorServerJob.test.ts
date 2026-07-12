import { describe, expect, test } from "vitest";

import { acceptorServerJobConfig } from "@bench/useAcceptorExchange";

import type { InvitationToken, LinkageTerms } from "@psilink/core";

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

const inputCsv = "first_name,last_name\nAlice,Smith\n";

describe("acceptorServerJobConfig", () => {
  test("runs on the acceptor's OWN-PERSPECTIVE derived terms, not the raw inviter terms", () => {
    const config = acceptorServerJobConfig({
      token,
      acceptorName: "Accepting Org",
      inputCsv,
    });

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
    const config = acceptorServerJobConfig({
      token,
      acceptorName: "Accepting Org",
      inputCsv,
    });

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
    const config = acceptorServerJobConfig({
      token,
      acceptorName: "Accepting Org",
      inputCsv,
    });

    expect(config.inputCsv).toBe(inputCsv);
    expect(config.sharedSecret).toBe(token.sharedSecret);
  });
});
