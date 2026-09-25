import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  generateSharedSecret,
  getDefaultLinkageTerms,
  snakeizeKeys,
} from "@alcove/core";

import { stringify as stringifyYaml } from "yaml";

import {
  ManagedConfigurationRefusedError,
  ManagedKeyFileRefusedError,
  readManagedCommandLineConfiguration,
  readManagedCommandLineKeyFile,
  readManagedCommandLinePair,
} from "@psi/managed/managedCommandLineImport";
import {
  ManagedImportAlreadyHeldError,
  ManagedImportBackupNotConfigurationError,
  ManagedImportChosenCopyError,
  ManagedImportCustodyUnreadableError,
  ManagedImportHandedOffError,
  ManagedImportSideMismatchError,
  ManagedImportStoredCopyError,
  importManagedCommandLinePair,
} from "@psi/managed/managedExchangeImport";
import {
  applyManagedExchangeCommandLinePair,
  buildManagedExchangeRecord,
  composeManagedExchangeFile,
  runnableManagedExchange,
  runnableManagedExchangeOrRefuse,
} from "@psi/managed/managedExchangeRecord";
import {
  encodeManagedExchangeArtifact,
  serializeManagedExchangeArtifact,
} from "@psi/managed/managedExchangeArtifact";
import { composeManagedCronExport } from "@psi/managed/managedCronExport";

import type {
  ManagedExchangeRecord,
  NewManagedExchange,
  RunnableManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type {
  ManagedPairReconcileOutcome,
  ManagedRetakeOutcome,
} from "@psi/managed/managedExchangeStore";
import type { ManagedPairImportDeps } from "@psi/managed/managedExchangeImport";

// The key leg of the command-line import: an alcove.yaml read with the
// .alcove.key beside it installs a runnable record, the key file is validated
// on its own terms, a matching stored exchange is reconciled on the backup
// import's rule, and the secret appears on no surface -- no refusal, no log
// line, no request. The store-backed half (real IndexedDB) is the browser
// suite's.

const linkageTerms = getDefaultLinkageTerms("County Health Dept");

function newExchange(
  overrides: Partial<NewManagedExchange> = {},
): NewManagedExchange {
  return {
    label: "Riverbend quarterly",
    exchangeFile: composeManagedExchangeFile({
      connection: { channel: "webrtc", host: "signaling.example.org" },
      linkageTerms,
    }),
    side: "acceptor",
    sharedSecret: generateSharedSecret(),
    ...overrides,
  };
}

/** The two files the app's own command-line export writes for a record. */
function exportedPair(overrides: Partial<NewManagedExchange> = {}): {
  record: RunnableManagedExchangeRecord;
  configuration: string;
  key: string;
} {
  const record = runnableManagedExchangeOrRefuse(
    buildManagedExchangeRecord(newExchange(overrides)),
  );
  const exported = composeManagedCronExport(record);
  return {
    record,
    configuration: exported.config.text,
    key: exported.key.text,
  };
}

/** A `.alcove.key` as Alcove's own writer lays it out (`saveKeyFile`,
 * `apps/cli/src/keyFile.ts`): the pair, pretty-printed, and a newline. */
function commandLineKeyText(fields: object): string {
  return JSON.stringify(fields, null, 2) + "\n";
}

/** Everything an error exposes that a surface or a log line could show. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return [
    error.name,
    error.message,
    String(error),
    error.stack ?? "",
    JSON.stringify(error),
    String(error.cause ?? ""),
  ].join("\n");
}

/** The error `run` throws; fails the test if it throws none. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

/** The error `run` rejects with; fails the test if it resolves. */
async function rejectionOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

describe("reading a .alcove.key", () => {
  test("the file Alcove writes is read as the key pair", () => {
    const sharedSecret = generateSharedSecret();
    expect(
      readManagedCommandLineKeyFile(
        commandLineKeyText({
          sharedSecret,
          expires: "2026-12-31T00:00:00.000Z",
        }),
      ),
    ).toEqual({ sharedSecret, expires: "2026-12-31T00:00:00.000Z" });
    expect(
      readManagedCommandLineKeyFile(commandLineKeyText({ sharedSecret })),
    ).toEqual({ sharedSecret });
  });

  test("the key file the app's own export writes is read back", () => {
    const { record, key } = exportedPair({
      expires: "2026-12-31T00:00:00.000Z",
      tokenMaxAgeDays: 30,
    });
    expect(readManagedCommandLineKeyFile(key)).toEqual({
      sharedSecret: record.sharedSecret,
      expires: "2026-12-31T00:00:00.000Z",
    });
  });

  // Each refusal names what is wrong in fixed words. The near-miss secret in
  // each file is the value a message must not echo.
  const nearMiss = generateSharedSecret().slice(0, 42);
  const cases: Array<[string, string, string]> = [
    [
      "bytes that are not JSON",
      `{"sharedSecret": "${nearMiss}"`,
      "not a JSON file",
    ],
    [
      "a JSON list",
      JSON.stringify([nearMiss]),
      "does not hold the sharedSecret",
    ],
    [
      "a bare JSON string",
      JSON.stringify(nearMiss),
      "does not hold the sharedSecret",
    ],
    [
      "no sharedSecret",
      commandLineKeyText({ expires: "2026-12-31T00:00:00.000Z" }),
      "it has no sharedSecret",
    ],
    [
      "a secret Alcove would not write",
      commandLineKeyText({ sharedSecret: nearMiss }),
      "its sharedSecret is not an Alcove shared secret",
    ],
    [
      "a secret that is not a string",
      JSON.stringify({ sharedSecret: 42 }),
      "its sharedSecret is not an Alcove shared secret",
    ],
    [
      "an expires that is not a date and time",
      commandLineKeyText({
        sharedSecret: generateSharedSecret(),
        expires: nearMiss,
      }),
      "its expires is not a date and time",
    ],
    [
      "a field the key file does not hold",
      commandLineKeyText({
        sharedSecret: generateSharedSecret(),
        [nearMiss]: nearMiss,
      }),
      "it holds a field other than sharedSecret and expires",
    ],
    [
      "a file over the cap",
      " ".repeat(10_001) + nearMiss,
      "larger than a key file",
    ],
  ];

  test.each(cases)(
    "%s is refused by name, echoing nothing",
    (_, source, named) => {
      const error = thrownBy(() => readManagedCommandLineKeyFile(source));
      expect(error).toBeInstanceOf(ManagedKeyFileRefusedError);
      expect((error as Error).message).toContain(named);
      expect((error as Error).message).toContain("Nothing was imported");
      expect(errorText(error)).not.toContain(nearMiss);
    },
  );

  test("a valid secret beside a bad field is still never echoed", () => {
    const sharedSecret = generateSharedSecret();
    const error = thrownBy(() =>
      readManagedCommandLineKeyFile(
        commandLineKeyText({ sharedSecret, expires: "tomorrow", extra: 1 }),
      ),
    );
    expect((error as Error).message).toContain("its expires is not");
    expect((error as Error).message).toContain("holds a field other than");
    expect(errorText(error)).not.toContain(sharedSecret);
  });
});

describe("reading a configuration with its key file", () => {
  test("the pair builds a runnable record holding the key file's secret", () => {
    const { record, configuration, key } = exportedPair({
      expires: "2026-12-31T00:00:00.000Z",
      tokenMaxAgeDays: 30,
    });
    const imported = readManagedCommandLinePair(configuration, key);
    expect(runnableManagedExchange(imported)).toBe(true);
    expect(imported.sharedSecret).toBe(record.sharedSecret);
    expect(imported.expires).toBe("2026-12-31T00:00:00.000Z");
    expect(imported.tokenMaxAgeDays).toBe(30);
    expect(imported.side).toBe("acceptor");
    expect(imported.exchangeFile).toEqual(record.exchangeFile);
    expect(imported.id).not.toBe(record.id);
    // The secret lands in the record's own secret field and nowhere else in it.
    const { sharedSecret: _secret, ...rest } = imported;
    expect(JSON.stringify(rest)).not.toContain(record.sharedSecret);
  });

  test("the configuration alone still builds an editable record that does not run", () => {
    const { configuration } = exportedPair();
    const imported = readManagedCommandLineConfiguration(configuration);
    expect(runnableManagedExchange(imported)).toBe(false);
    expect(imported.sharedSecret).toBeUndefined();
  });

  test("a refused key file refuses the pair, with no secret in the refusal", () => {
    const { configuration, record } = exportedPair();
    const error = thrownBy(() =>
      readManagedCommandLinePair(
        configuration,
        commandLineKeyText({ sharedSecret: record.sharedSecret, stray: true }),
      ),
    );
    expect(error).toBeInstanceOf(ManagedKeyFileRefusedError);
    expect(errorText(error)).not.toContain(record.sharedSecret);
  });

  test("a refused configuration refuses the pair, with no secret in the refusal", () => {
    const sharedSecret = generateSharedSecret();
    const configuration = stringifyYaml(
      snakeizeKeys({
        ...newExchange().exchangeFile,
        connection: { channel: "webrtc", server: { host: "x.example.org" } },
      }),
    );
    const error = thrownBy(() =>
      readManagedCommandLinePair(
        configuration,
        commandLineKeyText({ sharedSecret }),
      ),
    );
    expect(error).toBeInstanceOf(ManagedConfigurationRefusedError);
    expect(errorText(error)).not.toContain(sharedSecret);
  });

  test("a configuration on a channel this app does not run is refused with its key file", () => {
    const sharedSecret = generateSharedSecret();
    const configuration = stringifyYaml(
      snakeizeKeys({
        ...newExchange().exchangeFile,
        connection: {
          channel: "filedrop",
          path: "/srv/exchange",
        },
      }),
    );
    const error = thrownBy(() =>
      readManagedCommandLinePair(
        configuration,
        commandLineKeyText({ sharedSecret }),
      ),
    );
    expect(error).toBeInstanceOf(ManagedConfigurationRefusedError);
    expect((error as Error).message).toContain("runs over filedrop");
    expect((error as Error).message).toContain("on its own");
    expect(errorText(error)).not.toContain(sharedSecret);
  });

  test("a configuration with a signing block is refused with its key file", () => {
    const sharedSecret = generateSharedSecret();
    const document = newExchange().exchangeFile;
    const configuration = stringifyYaml(
      snakeizeKeys({
        ...document,
        connection: { ...document.connection, role: "inviter" },
        signing: {
          mode: "certificate",
          identityFile: "./identity.json",
          partnerFingerprint: "0123456789012345678901234567890123456789abA",
          receiptOutput: "./receipt.json",
        },
      }),
    );
    const error = thrownBy(() =>
      readManagedCommandLinePair(
        configuration,
        commandLineKeyText({ sharedSecret }),
      ),
    );
    expect(error).toBeInstanceOf(ManagedConfigurationRefusedError);
    expect((error as Error).message).toContain("holds signing");
    expect(errorText(error)).not.toContain(sharedSecret);
  });
});

describe("laying a pair over the stored record it revives", () => {
  test("the pair's fields replace the stored ones; what it has no field for stays", () => {
    const stored = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(
        newExchange({
          label: "Riverbend quarterly",
          expires: "2026-10-01T00:00:00.000Z",
          tokenMaxAgeDays: 14,
          schedule: {
            anchor: "2026-01-06T14:00:00.000Z",
            intervalDays: 7,
            windowSeconds: 10_800,
            nextWindow: "2026-01-13T14:00:00.000Z",
            consecutiveMisses: 1,
          },
          standingCondition: {
            kind: "auth",
            since: "2026-07-01T00:00:00.000Z",
          },
        }),
      ),
    );
    const imported = runnableManagedExchangeOrRefuse(
      buildManagedExchangeRecord(
        newExchange({ label: "", sharedSecret: stored.sharedSecret }),
      ),
    );
    const revived = applyManagedExchangeCommandLinePair(stored, imported);
    expect(revived.id).toBe(stored.id);
    expect(revived.label).toBe("Riverbend quarterly");
    expect(revived.schedule).toEqual(stored.schedule);
    expect(revived.standingCondition).toEqual(stored.standingCondition);
    expect(revived.expires).toBeUndefined();
    expect(revived.tokenMaxAgeDays).toBeUndefined();
    expect(revived.side).toBe(imported.side);
  });
});

/** Injected boundaries for the pair import, recording what it wrote. */
function recordingDeps(
  reconciled: ManagedPairReconcileOutcome = { kind: "no-match" },
  retaken: ManagedRetakeOutcome = { kind: "not-handed-off" },
): ManagedPairImportDeps & {
  installed: Array<ManagedExchangeRecord>;
  reconcile: ReturnType<typeof vi.fn>;
  retake: ReturnType<typeof vi.fn>;
  markImported: ReturnType<typeof vi.fn>;
} {
  const installed: Array<ManagedExchangeRecord> = [];
  return {
    installed,
    reconcile: vi.fn(() => Promise.resolve(reconciled)),
    retake: vi.fn(() => Promise.resolve(retaken)),
    install: (record) => {
      installed.push(record);
      return Promise.resolve(record);
    },
    markImported: vi.fn(() => Promise.resolve()),
    now: () => new Date("2026-07-14T12:00:00.000Z"),
  };
}

describe("importing a configuration with its key file", () => {
  test("with no match, installs the runnable record and marks it imported", async () => {
    const { configuration, key, record } = exportedPair();
    const deps = recordingDeps();
    const { record: installed, missingGrants } =
      await importManagedCommandLinePair(configuration, key, deps);
    expect(deps.reconcile).toHaveBeenCalledOnce();
    expect(deps.installed).toEqual([installed]);
    expect(installed.sharedSecret).toBe(record.sharedSecret);
    expect(runnableManagedExchange(installed)).toBe(true);
    expect(missingGrants).toEqual([]);
    expect(deps.markImported).toHaveBeenCalledWith(
      installed.id,
      "2026-07-14T12:00:00.000Z",
    );
  });

  test("a matching stored exchange is revived in place, installing nothing", async () => {
    const { configuration, key, record } = exportedPair();
    const deps = recordingDeps({ kind: "revived", record });
    const result = await importManagedCommandLinePair(configuration, key, deps);
    expect(result.record).toBe(record);
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test.each([
    [
      { kind: "handed-off", handoff: "command-line", label: "Riverbend" },
      ManagedImportHandedOffError,
    ],
    [
      { kind: "custody-unreadable", label: "Riverbend" },
      ManagedImportCustodyUnreadableError,
    ],
    [{ kind: "held", label: "Riverbend" }, ManagedImportAlreadyHeldError],
  ] as const)(
    "a refusing match (%o) installs nothing",
    async (outcome, refusal) => {
      const { configuration, key, record } = exportedPair();
      const deps = recordingDeps(outcome);
      const error = await rejectionOf(() =>
        importManagedCommandLinePair(configuration, key, deps),
      );
      expect(error).toBeInstanceOf(refusal);
      expect((error as { label: string }).label).toBe("Riverbend");
      expect(errorText(error)).not.toContain(record.sharedSecret);
      expect(deps.installed).toHaveLength(0);
      expect(deps.markImported).not.toHaveBeenCalled();
    },
  );

  test("a stored exchange with its terms and side is offered, and nothing is written", async () => {
    const { configuration, key, record } = exportedPair();
    const copies = [
      { id: "handed", label: "Riverbend", state: "handed-off" },
    ] as const;
    const deps = recordingDeps({ kind: "stored-copy", copies });
    const error = await rejectionOf(() =>
      importManagedCommandLinePair(configuration, key, deps),
    );
    expect(error).toBeInstanceOf(ManagedImportStoredCopyError);
    expect((error as ManagedImportStoredCopyError).copies).toEqual(copies);
    expect(errorText(error)).not.toContain(record.sharedSecret);
    expect(deps.installed).toHaveLength(0);
    expect(deps.retake).not.toHaveBeenCalled();
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("the operator's answer reaches the reconciliation", async () => {
    const { configuration, key } = exportedPair();
    const at = "2026-07-14T12:00:00.000Z";
    for (const answer of [{ into: "handed" }, { besideIds: ["handed"] }]) {
      const deps = recordingDeps();
      await importManagedCommandLinePair(configuration, key, deps, answer);
      expect(deps.reconcile).toHaveBeenCalledWith(
        expect.objectContaining({ side: "acceptor" }),
        at,
        answer,
      );
    }
  });

  test("a chosen hand-off takes the pair through its re-take, installing nothing", async () => {
    const { configuration, key, record } = exportedPair();
    const deps = recordingDeps(
      { kind: "retake", id: "handed" },
      { kind: "retaken", record },
    );
    const result = await importManagedCommandLinePair(
      configuration,
      key,
      deps,
      { into: "handed" },
    );
    expect(result.record).toBe(record);
    expect(deps.retake).toHaveBeenCalledWith(
      "handed",
      "2026-07-14T12:00:00.000Z",
      expect.objectContaining({ sharedSecret: record.sharedSecret }),
    );
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test.each([
    [{ kind: "run-in-flight" }, "run-in-flight"],
    [{ kind: "gone" }, "changed"],
    [{ kind: "not-handed-off" }, "changed"],
    [{ kind: "mismatch", on: "side" }, "changed"],
  ] as const)(
    "a chosen hand-off whose re-take refuses (%o) writes nothing",
    async (retaken, reason) => {
      const { configuration, key } = exportedPair();
      const deps = recordingDeps({ kind: "retake", id: "handed" }, retaken);
      const error = await rejectionOf(() =>
        importManagedCommandLinePair(configuration, key, deps, {
          into: "handed",
        }),
      );
      expect(error).toBeInstanceOf(ManagedImportChosenCopyError);
      expect((error as ManagedImportChosenCopyError).reason).toBe(reason);
      expect(deps.installed).toHaveLength(0);
    },
  );

  test("a chosen configuration-only exchange is completed in place, installing nothing", async () => {
    const { configuration, key, record } = exportedPair();
    const deps = recordingDeps({ kind: "completed", record });
    const result = await importManagedCommandLinePair(
      configuration,
      key,
      deps,
      { into: record.id },
    );
    expect(result.record).toBe(record);
    expect(deps.installed).toHaveLength(0);
    expect(deps.markImported).not.toHaveBeenCalled();
  });

  test("a chosen exchange that changed since is refused, writing nothing", async () => {
    const { configuration, key } = exportedPair();
    const deps = recordingDeps({ kind: "chosen-copy-changed" });
    const error = await rejectionOf(() =>
      importManagedCommandLinePair(configuration, key, deps, { into: "gone" }),
    );
    expect(error).toBeInstanceOf(ManagedImportChosenCopyError);
    expect((error as ManagedImportChosenCopyError).reason).toBe("changed");
    expect(deps.installed).toHaveLength(0);
  });

  test("a moved exchange holding the secret on the other side refuses, naming it", async () => {
    const { configuration, key, record } = exportedPair();
    const deps = recordingDeps({ kind: "side-mismatch", label: "Riverbend" });
    const error = await rejectionOf(() =>
      importManagedCommandLinePair(configuration, key, deps),
    );
    expect(error).toBeInstanceOf(ManagedImportSideMismatchError);
    expect((error as ManagedImportSideMismatchError).label).toBe("Riverbend");
    expect(errorText(error)).not.toContain(record.sharedSecret);
    expect(deps.installed).toHaveLength(0);
  });

  test("a malformed key file reaches no store step", async () => {
    const { configuration } = exportedPair();
    const deps = recordingDeps();
    await expect(
      importManagedCommandLinePair(configuration, "{not json", deps),
    ).rejects.toBeInstanceOf(ManagedKeyFileRefusedError);
    expect(deps.reconcile).not.toHaveBeenCalled();
    expect(deps.installed).toHaveLength(0);
  });

  test("the app's backup file given as the configuration is refused as one", async () => {
    const { record, key } = exportedPair();
    const backup = serializeManagedExchangeArtifact(
      encodeManagedExchangeArtifact(record),
    );
    const deps = recordingDeps();
    const error = await rejectionOf(() =>
      importManagedCommandLinePair(backup, key, deps),
    );
    expect(error).toBeInstanceOf(ManagedImportBackupNotConfigurationError);
    expect(errorText(error)).not.toContain(record.sharedSecret);
    expect(deps.reconcile).not.toHaveBeenCalled();
  });

  test("a failed import marker still reports the durable install", async () => {
    const { configuration, key } = exportedPair();
    const deps = recordingDeps();
    deps.markImported.mockImplementation(() =>
      Promise.reject(new Error("marker write failed")),
    );
    const { record } = await importManagedCommandLinePair(
      configuration,
      key,
      deps,
    );
    expect(deps.installed).toEqual([record]);
  });
});

describe("the secret reaches no log line and no request", () => {
  const consoleMethods = [
    "log",
    "info",
    "warn",
    "error",
    "debug",
    "trace",
  ] as const;
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>>;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    consoleSpies = consoleMethods.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    fetchSpy = vi.fn(() => Promise.reject(new Error("no request expected")));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /** Every argument any console method was called with, as text. */
  function everythingLogged(): string {
    return consoleSpies
      .flatMap((spy) => spy.mock.calls)
      .map((call: Array<unknown>) =>
        call.map((argument) => errorText(argument)).join(" "),
      )
      .join("\n");
  }

  test("an accepted pair, and every refusal of one, logs and sends nothing holding it", async () => {
    const { configuration, key, record } = exportedPair();
    await importManagedCommandLinePair(configuration, key, recordingDeps());
    await rejectionOf(() =>
      importManagedCommandLinePair(
        configuration,
        key,
        recordingDeps({ kind: "held", label: "" }),
      ),
    );
    await rejectionOf(() =>
      importManagedCommandLinePair(
        configuration,
        commandLineKeyText({ sharedSecret: record.sharedSecret, stray: 1 }),
        recordingDeps(),
      ),
    );
    await rejectionOf(() =>
      importManagedCommandLinePair("connection: [", key, recordingDeps()),
    );
    expect(everythingLogged()).not.toContain(record.sharedSecret);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
