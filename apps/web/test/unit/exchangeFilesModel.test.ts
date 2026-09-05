import { describe, expect, test } from "vitest";

import { parse as parseYaml } from "yaml";

import {
  CONFIG_EXCHANGE_FILES,
  EXCHANGE_FILES_DEFAULT,
  ZERO_SETUP_EXCHANGE_FILES,
  exchangeFilesOptions,
  exchangeFilesProblems,
} from "@console/exchangeFilesModel";
import { composeConfigDocument, zeroSetupOptionsArgv } from "@jobs/intent";
import { PEER_ID_SHAPE_MESSAGE } from "@psi/peerIdLabel";

import { validIntent } from "../utils/jobFixtures";

import type { ExchangeFilesDraft } from "@console/exchangeFilesModel";

const draft = (
  overrides: Partial<ExchangeFilesDraft> = {},
): ExchangeFilesDraft => ({ ...EXCHANGE_FILES_DEFAULT, ...overrides });

const composedOptions = (
  authored: ExchangeFilesDraft,
): Record<string, unknown> => {
  const options = exchangeFilesOptions(authored, CONFIG_EXCHANGE_FILES);
  const doc = parseYaml(
    composeConfigDocument(
      validIntent(options !== undefined ? { options } : {}),
      "/srv/jobs/x/exchange",
    ),
  ) as { connection: { options?: Record<string, unknown> } };
  return doc.connection.options ?? {};
};

describe("the authored draft becomes an option block", () => {
  test("an untouched draft has no options at all", () => {
    expect(exchangeFilesOptions(EXCHANGE_FILES_DEFAULT)).toBeUndefined();
    expect(exchangeFilesProblems(EXCHANGE_FILES_DEFAULT)).toEqual([]);
  });

  // The implication is core's (withRetainModeImplications), not the card's:
  // switching retain on and leaving the other two automatic has to produce the
  // same trio `--retain-files` alone produces at the command line.
  test("retain alone yields all three", () => {
    expect(exchangeFilesOptions(draft({ retainFiles: true }))).toEqual({
      retainFiles: true,
      locklessRendezvous: true,
      timestampInFilename: true,
    });
  });

  test("retain alone yields all three in the composed config", () => {
    expect(composedOptions(draft({ retainFiles: true }))).toMatchObject({
      retain_files: true,
      lockless_rendezvous: true,
      timestamp_in_filename: true,
    });
  });

  test("retain alone yields all three on a zero-setup command line", () => {
    const options = exchangeFilesOptions(
      draft({ retainFiles: true }),
      ZERO_SETUP_EXCHANGE_FILES,
    );
    expect(zeroSetupOptionsArgv(options)).toEqual([
      "--retain-files",
      "--lockless-rendezvous",
      "--timestamp-in-filename",
    ]);
  });

  test("an explicitly-stated toggle is left as the operator stated it", () => {
    expect(
      exchangeFilesOptions(
        draft({ retainFiles: true, locklessRendezvous: "off" }),
      ),
    ).toEqual({
      retainFiles: true,
      locklessRendezvous: false,
      timestampInFilename: true,
    });
  });

  test("a toggle on its own needs no retain mode", () => {
    expect(exchangeFilesOptions(draft({ locklessRendezvous: "on" }))).toEqual({
      locklessRendezvous: true,
    });
  });

  test("a blank party name is unset, and a padded one is trimmed", () => {
    expect(exchangeFilesOptions(draft({ peerId: "   " }))).toBeUndefined();
    expect(
      exchangeFilesOptions(
        draft({ peerId: "  clinic-a  ", timestampInFilename: "on" }),
      ),
    ).toEqual({ peerId: "clinic-a", timestampInFilename: true });
  });

  test("the foreign-file policy is withheld from a zero-setup run", () => {
    const authored = draft({ unexpectedFiles: "warn" });
    expect(exchangeFilesOptions(authored, CONFIG_EXCHANGE_FILES)).toEqual({
      unexpectedFiles: "warn",
    });
    // A zero-setup command has no flag for it, so the card never offers it there
    // and the draft's value never reaches an intent that would drop it.
    expect(
      exchangeFilesOptions(authored, ZERO_SETUP_EXCHANGE_FILES),
    ).toBeUndefined();
  });
});

describe("an inadmissible combination is a form problem, not a failed job", () => {
  test("retain with timestamps explicitly off reports core's own message", () => {
    const problems = exchangeFilesProblems(
      draft({ retainFiles: true, timestampInFilename: "off" }),
    );
    expect(problems.length).toBeGreaterThan(0);
    expect(
      problems.some((problem) =>
        problem.includes("retain_files requires timestamp_in_filename"),
      ),
    ).toBe(true);
  });

  test("retain with the lockless rendezvous explicitly off reports core's message", () => {
    expect(
      exchangeFilesProblems(
        draft({ retainFiles: true, locklessRendezvous: "off" }),
      ).some((problem) =>
        problem.includes("retain_files requires lockless_rendezvous"),
      ),
    ).toBe(true);
  });

  test("a party name without timestamped filenames reports core's dependency", () => {
    expect(
      exchangeFilesProblems(draft({ peerId: "clinic-a" })).some((problem) =>
        problem.includes("peer_id requires timestamp_in_filename"),
      ),
    ).toBe(true);
  });

  test("the reserved party name is refused in core's words", () => {
    expect(
      exchangeFilesProblems(
        draft({ peerId: "temp", timestampInFilename: "on" }),
      ).some((problem) => problem.includes("reserved")),
    ).toBe(true);
  });

  test.each([
    ["a path separator", "../etc/passwd"],
    ["a leading dash", "-save"],
    ["an accented letter", "clinique-café"],
    ["an over-long label", "a".repeat(65)],
  ])("a party name with %s is refused by shape", (_label, peerId) => {
    expect(
      exchangeFilesProblems(draft({ peerId, timestampInFilename: "on" })),
    ).toEqual([PEER_ID_SHAPE_MESSAGE]);
  });

  test("an admissible combination reports nothing", () => {
    expect(
      exchangeFilesProblems(draft({ retainFiles: true, peerId: "clinic-a" })),
    ).toEqual([]);
  });
});
