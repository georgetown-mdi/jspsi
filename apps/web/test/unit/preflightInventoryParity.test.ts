import { describe, expect, test } from "vitest";

import {
  PREFLIGHT_INVENTORY,
  authoredPreflightIds,
  dispositionReason,
  preflightIds,
} from "@psilink/testkit/preflightInventory";

import {
  CONNECTION_PER_POLL_SHORT_INTERVAL_ADVISORY,
  FILEDROP_CONNECTION_TUNING,
  LOW_POLL_INTERVAL_ADVISORY,
} from "@bench/connectionTuningModel";
import {
  EMPTY_SFTP_FORM,
  KEYBOARD_INTERACTIVE_REQUIRES_PASSWORD,
  PASSPHRASE_REQUIRES_PRIVATE_KEY,
  SPLIT_DIRECTORY_RETAIN_REQUIREMENT,
  sftpFormError,
} from "@bench/sftpConnectionForm";
import {
  acceptorDisclosedColumns,
  acceptorPayloadDeclarationConflict,
} from "@bench/acceptorColumnsModel";
import { StandardizationPreview } from "@components/StandardizationPreview";
import { linkageRefusalFor } from "@psi/linkageRefusal";
import { probePeerAnswerCopy } from "@bench/SftpAuthoringForm";

import type { PreflightId } from "@psilink/testkit/preflightInventory";
import type { SftpConnectionFormValues } from "@bench/sftpConnectionForm";

// This is the console half of the preflight parity inventory
// (`@psilink/testkit/preflightInventory`); the CLI half is
// apps/cli/test/unit/preflightInventoryParity.test.ts. A row claiming the
// console states it at a control has to name the control, and the control
// has to exist.

/** What the console has for a row: the module it is stated in and the symbol
 * that states it, or `null` for a row whose disposition says the console states
 * it nowhere. */
type ConsoleSurface = readonly [module: string, symbol: unknown] | null;

/** Where each row lands in the console. A row added to the inventory fails to
 * compile until it is bound here. */
const CONSOLE_SURFACES: Record<PreflightId, ConsoleSurface> = {
  linkageSatisfiability: ["@psi/linkageRefusal", linkageRefusalFor],
  unacceptedPayloadColumns: [
    "@bench/acceptorColumnsModel",
    acceptorPayloadDeclarationConflict,
  ],
  valueConstraints: [
    "@components/StandardizationPreview",
    StandardizationPreview,
  ],
  passphraseRequiresPrivateKey: [
    "@bench/sftpConnectionForm",
    PASSPHRASE_REQUIRES_PRIVATE_KEY,
  ],
  keyboardInteractiveRequiresPassword: [
    "@bench/sftpConnectionForm",
    KEYBOARD_INTERACTIVE_REQUIRES_PASSWORD,
  ],
  lowPollingFrequency: [
    "@bench/connectionTuningModel",
    LOW_POLL_INTERVAL_ADVISORY,
  ],
  connectionPerPollShortInterval: [
    "@bench/connectionTuningModel",
    CONNECTION_PER_POLL_SHORT_INTERVAL_ADVISORY,
  ],
  unsupportedChannelFlags: [
    "@bench/connectionTuningModel",
    FILEDROP_CONNECTION_TUNING,
  ],
  ignoredOfflineOverrides: null,
  keyFilePath: null,
  hostKeyTrust: ["@bench/SftpAuthoringForm", probePeerAnswerCopy],
  identityDivergence: null,
  outboundPayloadConsent: [
    "@bench/acceptorColumnsModel",
    acceptorDisclosedColumns,
  ],
  splitDirectoryRequiresRetain: [
    "@bench/sftpConnectionForm",
    SPLIT_DIRECTORY_RETAIN_REQUIREMENT,
  ],
  jobAdmission: null,
};

/** A savable connection form, so a credential-combination case fails on the
 * combination rather than on a field left blank. */
function connectionForm(
  overrides: Partial<SftpConnectionFormValues>,
): SftpConnectionFormValues {
  return {
    ...EMPTY_SFTP_FORM,
    host: "sftp.partner.example",
    username: "linkage",
    hostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
    source: { kind: "mount", subPath: ["partner-password"] },
    ...overrides,
  };
}

describe("every row is dispositioned in the console", () => {
  test("a row stating the console authors it names a surface that exists", () => {
    for (const id of authoredPreflightIds()) {
      const surface = CONSOLE_SURFACES[id];
      expect([id, surface !== null]).toEqual([id, true]);
      if (surface === null) continue;
      const [module, symbol] = surface;
      expect([id, module, symbol !== undefined]).toEqual([id, module, true]);
    }
  });

  test("a row the console has no surface for says why in its own words", () => {
    // The two exits from "the console states it at a control" are the accurate
    // ones -- the state cannot be composed, or the gap is known and unbuilt --
    // and each has to state its reason. A row cannot leave the question open.
    for (const id of preflightIds()) {
      const disposition = PREFLIGHT_INVENTORY[id].console;
      if (disposition.kind === "authored") continue;
      expect({ id, reason: dispositionReason(id).length > 0 }).toEqual({
        id,
        reason: true,
      });
    }
  });

  test("nothing that refuses or asks is left to the run's warnings", () => {
    // `runWarning` says the operator learns of it from a warning the child
    // emits mid-run. A check that REFUSES the run, or one that puts a question
    // to the operator, is neither: the first reaches a console operator as a
    // failed run and the second as a run that cannot answer itself. Either is a
    // gap to record as `pending`, not a disposition to claim as covered.
    for (const id of preflightIds()) {
      const row = PREFLIGHT_INVENTORY[id];
      if (row.weight === "warns") continue;
      expect([id, row.weight, row.console.kind]).not.toEqual([
        id,
        row.weight,
        "runWarning",
      ]);
    }
  });

  test("the deferred boundaries are recorded as pending, not as covered", () => {
    // The rows that are gaps by design. Each is written down rather than
    // dropped so that building the boundary is a change to this list, not a
    // rediscovery, and each names no console surface -- a pending row that still
    // pointed at a symbol would read as covered.
    for (const id of ["jobAdmission", "identityDivergence"] as const) {
      expect([id, PREFLIGHT_INVENTORY[id].console.kind]).toEqual([
        id,
        "pending",
      ]);
      expect([id, CONSOLE_SURFACES[id]]).toEqual([id, null]);
    }
  });
});

describe("the credential rules the CLI refuses are refused at the controls", () => {
  // The CLI leg drives the same two states through applyConnectionOverrides and
  // holds each one to a refusal. Here they are driven through the console's own
  // form, so the rows claiming the console states them before launch are held to
  // the wording the operator actually gets rather than to a symbol's existence.
  test("a passphrase with no private key blocks the save on its own field", () => {
    const error = sftpFormError(
      connectionForm({
        method: "password",
        passphrasePath: "@/run/secrets/key.pass",
      }),
      true,
    );
    expect(error).toEqual({
      field: "passphrase",
      message: PASSPHRASE_REQUIRES_PRIVATE_KEY,
    });
  });

  test("keyboard-interactive with no password blocks the save on the toggle", () => {
    const error = sftpFormError(
      connectionForm({ method: "private_key", keyboardInteractive: true }),
      true,
    );
    expect(error).toEqual({
      field: "keyboardInteractive",
      message: KEYBOARD_INTERACTIVE_REQUIRES_PASSWORD,
    });
  });

  test("an outbound directory without retain mode blocks the save", () => {
    const error = sftpFormError(
      connectionForm({
        remoteDirectory: "/exchange/in",
        outboundDirectory: "/exchange/out",
      }),
      false,
    );
    expect(error).toEqual({
      field: "outboundDirectory",
      message: SPLIT_DIRECTORY_RETAIN_REQUIREMENT,
    });
  });

  test("no refusal is worded in the configuration keys core states them in", () => {
    // The console's whole claim on these rows is that it says them in its own
    // controls; a message naming a config key or a CLI flag would be the CLI's
    // refusal wearing the console's clothes.
    for (const message of [
      PASSPHRASE_REQUIRES_PRIVATE_KEY,
      KEYBOARD_INTERACTIVE_REQUIRES_PASSWORD,
      SPLIT_DIRECTORY_RETAIN_REQUIREMENT,
    ]) {
      expect(message).not.toContain("--server-");
      expect(message).not.toContain("privateKeyPassphrase");
      expect(message).not.toContain("keyboard_interactive");
      expect(message).not.toContain("outbound_path");
    }
  });
});
