import { describe, expect, test } from "vitest";

import { generateSharedSecret } from "@alcove/core";

import {
  BACKUP_NOT_PAIR_REASON,
  UNREADABLE_CONFIGURATION_REASON,
  alreadyHeldImportReason,
  pairImportFailureReason,
} from "@recurring/managedImportFailure";
import {
  KEY_FILE_ALONE_REASON,
  NOT_A_PAIR_REASON,
  PAIR_IMPORTED_NOTICE,
  TOO_MANY_FILES_REASON,
  managedImportFileChoice,
} from "@recurring/managedImportFiles";
import {
  ManagedKeyFileRefusedError,
  readManagedCommandLineKeyFile,
} from "@psi/managed/managedCommandLineImport";
import {
  custodyUnreadablePairImportReason,
  handedOffPairImportReason,
} from "@recurring/managedHandoffGate";
import { ManagedImportBackupNotConfigurationError } from "@psi/managed/managedExchangeImport";

// Sorting a control's chosen files into one file or a configuration with its key
// file, by name alone, and what the pair import says when it refuses or lands.

const named = (name: string) => ({ name });

describe("sorting the chosen files", () => {
  test("nothing chosen is no choice", () => {
    expect(managedImportFileChoice([])).toBeUndefined();
  });

  test("one file that is not a key file is imported on its own", () => {
    const file = named("alcove.yaml");
    expect(managedImportFileChoice([file])).toEqual({ kind: "one", file });
  });

  test.each([".alcove.key", "alcove.key", "ALCOVE.KEY"])(
    "%s chosen alone is refused, naming the configuration to add",
    (name) => {
      expect(managedImportFileChoice([named(name)])).toEqual({
        kind: "refused",
        reason: KEY_FILE_ALONE_REASON,
      });
    },
  );

  test("a configuration and a key file are a pair, in either order", () => {
    const configurationFile = named("alcove.yaml");
    const keyFile = named(".alcove.key");
    const pair = { kind: "pair", configurationFile, keyFile };
    expect(managedImportFileChoice([configurationFile, keyFile])).toEqual(pair);
    expect(managedImportFileChoice([keyFile, configurationFile])).toEqual(pair);
  });

  test.each([[["alcove.yaml", "other.yaml"]], [[".alcove.key", "alcove.key"]]])(
    "two files that are not one of each (%o) are refused",
    (names) => {
      expect(managedImportFileChoice(names.map(named))).toEqual({
        kind: "refused",
        reason: NOT_A_PAIR_REASON,
      });
    },
  );

  test("more than two files are refused", () => {
    expect(
      managedImportFileChoice(
        ["alcove.yaml", ".alcove.key", "backup.json"].map(named),
      ),
    ).toEqual({ kind: "refused", reason: TOO_MANY_FILES_REASON });
  });
});

describe("what the pair import says", () => {
  test("a landed pair says the exchange runs here now and names the run to stop", () => {
    expect(PAIR_IMPORTED_NOTICE.lead).toContain("runs in this browser now");
    expect(PAIR_IMPORTED_NOTICE.lead).toContain("stop that first");
  });

  test("a refused key file states its own reason, and never the secret", () => {
    const sharedSecret = generateSharedSecret();
    let refusal: unknown;
    try {
      readManagedCommandLineKeyFile(
        JSON.stringify({ sharedSecret, stray: sharedSecret }),
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(ManagedKeyFileRefusedError);
    const reason = pairImportFailureReason(refusal);
    expect(reason).toContain("holds a field other than");
    expect(reason).not.toContain(sharedSecret);
  });

  test("a backup file as the configuration is named as a backup", () => {
    expect(
      pairImportFailureReason(new ManagedImportBackupNotConfigurationError()),
    ).toBe(BACKUP_NOT_PAIR_REASON);
  });

  test("anything else leaves the configuration file to check", () => {
    expect(pairImportFailureReason(new Error("x"))).toBe(
      UNREADABLE_CONFIGURATION_REASON,
    );
  });

  test("the store's refusals name the exchange, or name it neutrally", () => {
    expect(alreadyHeldImportReason("Riverbend")).toContain('"Riverbend"');
    expect(alreadyHeldImportReason("")).toMatch(/^That exchange/);
    expect(handedOffPairImportReason("command-line", "Riverbend")).toContain(
      "Take this exchange back",
    );
    expect(handedOffPairImportReason("command-line", "")).toMatch(
      /^That exchange/,
    );
    expect(custodyUnreadablePairImportReason("Riverbend")).toContain(
      "alcove.yaml and .alcove.key again",
    );
  });
});
