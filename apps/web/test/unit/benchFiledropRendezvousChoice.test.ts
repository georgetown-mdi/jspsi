import { describe, expect, test } from "vitest";

import { decodeInvitation, encodeInvitation } from "@psilink/core";

import {
  SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT,
  acceptKitEndpointForRendezvous,
  filedropEndpointForRendezvous,
  splitRendezvousRetainProblem,
} from "@console/filedropRendezvousChoice";

import type { InvitationToken } from "@psilink/core";
import type { JobRendezvousConfig } from "@psi/workInputClient";

/** A schema-valid token to hang a minted endpoint off, so the endpoint is checked
 * by the same encode a real mint runs rather than by a restated rule. */
const BASE_TOKEN: InvitationToken = {
  version: "1",
  sharedSecret: "A".repeat(43),
  linkageTerms: {
    version: "1.0.0",
    identity: "County Health",
    date: "2026-08-20",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: [{ name: "ssn", type: "ssn" }],
    linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
  },
};

const SHARED: JobRendezvousConfig = {
  configured: true,
  locator: "psilink",
  folderName: "psilink",
};

const SPLIT: JobRendezvousConfig = {
  configured: true,
  split: true,
  locator: "from-partner",
  folderName: "from-partner",
  outboundLocator: "to-partner",
  outboundFolderName: "to-partner",
};

describe("the invitation endpoint a console filedrop mints", () => {
  test("a single mount has the one shared locator", () => {
    expect(filedropEndpointForRendezvous(SHARED)).toEqual({
      channel: "filedrop",
      path: "psilink",
    });
  });

  test("a split console has the pair as THIS party authored it", () => {
    // Not mirrored here: an endpoint's pair is defined from the inviter's side and
    // the swap belongs to the single consumer that builds a connection from one.
    expect(filedropEndpointForRendezvous(SPLIT)).toEqual({
      channel: "filedrop",
      inboundPath: "from-partner",
      outboundPath: "to-partner",
    });
  });

  test("the minted pair survives core's own endpoint refines", async () => {
    // The endpoint the console composes has to decode on the partner's side, and
    // core refuses a filedrop endpoint whose halves resolve alike -- so this is
    // the check that the console's two locators reach a real mint distinct, rather
    // than a restatement of the rule. Minted with the retain declaration core
    // requires beside a split pair, as a console mint of this rendezvous holds.
    const decoded = await decodeInvitation(
      await encodeInvitation({
        ...BASE_TOKEN,
        connectionEndpoint: filedropEndpointForRendezvous(SPLIT),
        inviterRetainsFiles: true,
      }),
    );
    expect(decoded.connectionEndpoint).toEqual({
      channel: "filedrop",
      inboundPath: "from-partner",
      outboundPath: "to-partner",
    });
  });

  test("core refuses a mint whose two locators resolve alike", async () => {
    // The refusal the boot-time name check exists to keep an operator from
    // meeting here, where it names nothing they can act on. Matched on the
    // distinctness message and minted with the retain declaration, so the split
    // pair's own mint rule cannot stand in for the refusal under test.
    await expect(
      encodeInvitation({
        ...BASE_TOKEN,
        connectionEndpoint: filedropEndpointForRendezvous({
          ...SPLIT,
          outboundLocator: "from-partner",
        }),
        inviterRetainsFiles: true,
      }),
    ).rejects.toThrow(/must differ/);
  });

  test("no mount, or a mount with no locator, mints nothing", () => {
    expect(filedropEndpointForRendezvous(undefined)).toBeUndefined();
    expect(
      filedropEndpointForRendezvous({ configured: false }),
    ).toBeUndefined();
    expect(filedropEndpointForRendezvous({ configured: true })).toBeUndefined();
    expect(
      filedropEndpointForRendezvous({
        configured: true,
        split: true,
        locator: "in",
      }),
    ).toBeUndefined();
  });
});

describe("what the partner's accept kit is told about the rendezvous", () => {
  test("a single mount names the folder only where the console has a name", () => {
    expect(acceptKitEndpointForRendezvous(SHARED)).toEqual({
      channel: "filedrop",
      path: "psilink",
    });
    expect(
      acceptKitEndpointForRendezvous({ configured: true, locator: "psilink" }),
    ).toEqual({ channel: "filedrop" });
  });

  test("a split console has the SHAPE whether or not it has the names", () => {
    expect(acceptKitEndpointForRendezvous(SPLIT)).toEqual({
      channel: "filedrop",
      split: true,
      inboundPath: "from-partner",
      outboundPath: "to-partner",
    });
    // A sheet naming one folder of a two-folder rendezvous would be treated as
    // though the other did not exist, so it is both names or neither.
    expect(
      acceptKitEndpointForRendezvous({
        ...SPLIT,
        outboundFolderName: undefined,
      }),
    ).toEqual({ channel: "filedrop", split: true });
  });

  test("an unavailable console describes no rendezvous at all", () => {
    expect(
      acceptKitEndpointForRendezvous({ configured: false }),
    ).toBeUndefined();
  });
});

describe("the retain-mode precondition a split rendezvous has", () => {
  test("a split console without retain mode states the requirement", () => {
    expect(splitRendezvousRetainProblem(SPLIT, false)).toBe(
      SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT,
    );
    expect(SPLIT_RENDEZVOUS_RETAIN_REQUIREMENT).toContain(
      "Keep every exchange file",
    );
  });

  test("retain mode on, or no split at all, is no problem", () => {
    expect(splitRendezvousRetainProblem(SPLIT, true)).toBeUndefined();
    expect(splitRendezvousRetainProblem(SHARED, false)).toBeUndefined();
    expect(splitRendezvousRetainProblem(undefined, false)).toBeUndefined();
    expect(
      splitRendezvousRetainProblem({ configured: false }, false),
    ).toBeUndefined();
  });
});
