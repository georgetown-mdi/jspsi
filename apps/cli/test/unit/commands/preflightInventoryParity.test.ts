import { describe, expect, test } from "vitest";

import {
  PREFLIGHT_INVENTORY,
  dispositionReason,
  preflightIds,
} from "@psilink/testkit/preflightInventory";

import * as hostKeyTrust from "../../../src/hostKeyTrust";
import * as keyFilePreflight from "../../../src/keyFilePreflight";
import * as linkagePreflight from "../../../src/commands/linkagePreflight";
import * as optionDefinitions from "../../../src/optionDefinitions";
import * as outboundPayloadConsent from "../../../src/outboundPayloadConsent";
import * as signingIdentityDivergence from "../../../src/signingIdentityDivergence";
import * as valueConstraintWarnings from "../../../src/commands/valueConstraintWarnings";
import { applyConnectionOverrides } from "../../../src/config";

import type { PreflightId } from "@psilink/testkit/preflightInventory";
import type { ConnectionConfig } from "@psilink/core";

// This is the CLI half of the preflight parity inventory
// (`@psilink/testkit/preflightInventory`, whose header holds the whole
// argument and the closure test's stated limit). `packages/` cannot import
// `apps/`, so binding a row to its enforcing code belongs in this app's test
// tree. The console half is apps/web/test/unit/console/preflightInventoryParity.test.ts,
// compared against the same inventory and so against each other.

/** The CLI modules whose whole purpose is preflight. Every function they export
 * is a preflight check and must be claimed by a row. */
const DEDICATED_PREFLIGHT_MODULES: Record<string, Record<string, unknown>> = {
  "commands/linkagePreflight": linkagePreflight,
  "commands/valueConstraintWarnings": valueConstraintWarnings,
  hostKeyTrust,
  keyFilePreflight,
  outboundPayloadConsent,
  signingIdentityDivergence,
};

/** The option surface is not a preflight module -- it is where the flags are
 * declared -- so only its advisories count, which it names by prefix. */
const FLAG_ADVISORY_PREFIX = "warn";

/** How a row is anchored on the CLI side. */
type CliAnchor =
  /** Exported by a preflight module (or as a flag advisory), and so inside what
   * the closure test below enumerates. */
  | {
      readonly kind: "export";
      readonly module: string;
      readonly names: Array<string>;
    }
  /** Enforced inside another export, so outside the closure test's reach; the
   * behavioural assertions below are what hold these. */
  | { readonly kind: "inline"; readonly inside: string }
  /** No CLI check of its own, for the stated reason. */
  | { readonly kind: "none"; readonly because: string };

/** Where each row is enforced in the CLI. A row added to the inventory fails to
 * compile until it is anchored here. */
const CLI_ANCHORS: Record<PreflightId, CliAnchor> = {
  linkageSatisfiability: {
    kind: "export",
    module: "commands/linkagePreflight",
    names: ["checkLinkageSatisfiability"],
  },
  unacceptedPayloadColumns: {
    kind: "export",
    module: "commands/linkagePreflight",
    names: ["warnColumnsTheInvitationWillNotAccept"],
  },
  valueConstraints: {
    kind: "export",
    module: "commands/valueConstraintWarnings",
    names: ["warnOnValueConstraints"],
  },
  passphraseRequiresPrivateKey: {
    kind: "inline",
    inside: "applyConnectionOverrides",
  },
  keyboardInteractiveRequiresPassword: {
    kind: "inline",
    inside: "applyConnectionOverrides",
  },
  lowPollingFrequency: {
    kind: "export",
    module: "optionDefinitions",
    names: ["warnLowPollingFrequency"],
  },
  connectionPerPollShortInterval: {
    kind: "export",
    module: "optionDefinitions",
    names: ["warnConnectionPerPollShortInterval"],
  },
  unsupportedChannelFlags: {
    kind: "export",
    module: "optionDefinitions",
    names: ["warnUnsupportedFileSyncFlags", "warnUnsupportedWebRTCServerFlags"],
  },
  ignoredOfflineOverrides: {
    kind: "export",
    module: "optionDefinitions",
    names: [
      "warnServerOverridesIgnoredOffline",
      "warnOptionsOverridesIgnoredOffline",
    ],
  },
  keyFilePath: {
    kind: "export",
    module: "keyFilePreflight",
    names: ["preflightKeyFilePath"],
  },
  hostKeyTrust: {
    kind: "export",
    module: "hostKeyTrust",
    names: ["establishHostKeyTrust"],
  },
  identityDivergence: {
    kind: "export",
    module: "signingIdentityDivergence",
    names: ["assertIdentityMatchesAgreedTerms", "warnOnIdentityDivergence"],
  },
  outboundPayloadConsent: {
    kind: "export",
    module: "outboundPayloadConsent",
    names: ["confirmOutboundPayloadConsent"],
  },
  splitDirectoryRequiresRetain: {
    kind: "inline",
    inside: "applyConnectionOverrides",
  },
  jobAdmission: {
    kind: "none",
    because:
      "core's run boundary raises it; the CLI restates no advance form of it",
  },
};

/** `module.name` for every export a row claims. */
function claimedExports(): Array<string> {
  return preflightIds().flatMap((id) => {
    const anchor = CLI_ANCHORS[id];
    return anchor.kind === "export"
      ? anchor.names.map((name) => `${anchor.module}.${name}`)
      : [];
  });
}

/** `module.name` for every preflight function the CLI actually exports. */
function exportedPreflights(): Array<string> {
  const found: Array<string> = [];
  for (const [module, namespace] of Object.entries(DEDICATED_PREFLIGHT_MODULES))
    for (const [name, value] of Object.entries(namespace))
      if (typeof value === "function") found.push(`${module}.${name}`);
  for (const [name, value] of Object.entries(optionDefinitions))
    if (typeof value === "function" && name.startsWith(FLAG_ADVISORY_PREFIX))
      found.push(`optionDefinitions.${name}`);
  return found;
}

/** An sftp connection with the given server block, as the CLI holds one after a
 * config parse and before the overrides are merged in. */
function sftpConnection(server: Record<string, unknown>): ConnectionConfig {
  return {
    channel: "sftp",
    server: { host: "sftp.partner.example", ...server },
  } as ConnectionConfig;
}

describe("the inventory's CLI anchors are real", () => {
  test("every claimed export exists and is a function", () => {
    const exported = new Set(exportedPreflights());
    for (const claim of claimedExports())
      expect({ claim, exported: exported.has(claim) }).toEqual({
        claim,
        exported: true,
      });
  });

  test("every exported preflight is claimed by a row", () => {
    // The direction that reddens the console's list: a preflight added to one of
    // the CLI's preflight modules -- or a new flag advisory -- fails here until
    // it has a row, and the row then fails the console leg until it is
    // dispositioned there.
    expect(exportedPreflights().sort()).toEqual(claimedExports().sort());
  });

  test("an anchor outside that enumeration names where it is instead", () => {
    // The closure test above cannot see these two shapes, so what each one is
    // held to is its own statement of where the rule lives -- and, for the
    // inline ones, the behavioural assertions below.
    for (const id of preflightIds()) {
      const anchor = CLI_ANCHORS[id];
      if (anchor.kind === "export") continue;
      const stated = anchor.kind === "inline" ? anchor.inside : anchor.because;
      expect([id, stated.length > 0]).toEqual([id, true]);
    }
  });

  test("every row states what it is about and what the console does", () => {
    for (const id of preflightIds()) {
      const row = PREFLIGHT_INVENTORY[id];
      expect({ id, stated: row.concern.length > 0 }).toEqual({
        id,
        stated: true,
      });
      expect({ id, disposed: dispositionReason(id).length > 0 }).toEqual({
        id,
        disposed: true,
      });
    }
  });
});

describe("the inline credential and directory rules fire", () => {
  // These three are enforced inside applyConnectionOverrides rather than as
  // preflight exports, so the closure test above cannot see them. Driving them
  // is what holds them: the console leg refuses the same three states at its own
  // controls, and a rule that stopped firing here would leave that leg asserting
  // a parity with nothing on the other side.
  test("a passphrase with no private key is refused", () => {
    expect(() =>
      applyConnectionOverrides(
        sftpConnection({ password: "@/run/secrets/pw" }),
        {
          server: { privateKeyPassphrase: "@/run/secrets/key.pass" },
        },
      ),
    ).toThrow(/--server-private-key-passphrase requires --server-private-key/);
  });

  test("keyboard-interactive with no password is refused", () => {
    expect(() =>
      applyConnectionOverrides(
        sftpConnection({ privateKey: "@/run/secrets/id" }),
        { server: { keyboardInteractive: true } },
      ),
    ).toThrow(/--server-keyboard-interactive requires --server-password/);
  });

  test("an outbound directory without retain mode is refused", () => {
    expect(() =>
      applyConnectionOverrides(
        sftpConnection({ password: "@/run/secrets/pw", path: "/exchange/in" }),
        { server: { outboundPath: "/exchange/out" } },
      ),
    ).toThrow(/--outbound-path/);
  });
});
