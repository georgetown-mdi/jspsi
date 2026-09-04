import fs from "node:fs";
import path from "node:path";

import { expect, test, vi } from "vitest";
import logLibrary from "loglevel";
import type { Arguments } from "yargs";
import { UsageError } from "@psilink/core";

import { logLevelFlag } from "../../src/util/logging";
import {
  argv,
  captureStdio,
  snapshotDiagnosticSinkAndLevel,
} from "../loggingTestSupport";

import { handler as acceptHandler } from "../../src/commands/accept";
import { mountHandler, probeHandler } from "../../src/commands/doctor";
import { handler as exchangeHandler } from "../../src/commands/exchange";
import { handler as fingerprintHandler } from "../../src/commands/fingerprint";
import { handler as initHandler } from "../../src/commands/init";
import { handler as inviteHandler } from "../../src/commands/invite";
import { handler as probeHostKeyHandler } from "../../src/commands/probeHostKey";
import { handler as verifyReceiptHandler } from "../../src/commands/verifyReceipt";
import { handler as zeroSetupHandler } from "../../src/commands/zeroSetup";

// logLevelFlag is the single --log-level resolve every command reads through, but
// it stops at the UsageError: each command maps that to an exit through its own
// boundary (parseOrExit, runOrExit, or a caller of parseCommonBootstrapArgs). So
// the resolve is pinned here directly, and the exit-64 outcome it must produce is
// pinned at every command entry point below -- the property an operator sees,
// which no single boundary owns.

snapshotDiagnosticSinkAndLevel();

// --- The resolve -------------------------------------------------------------

test("logLevelFlag: an absent --log-level resolves to info", () => {
  expect(logLevelFlag(argv({}))).toBe(logLibrary.levels.INFO);
});

test("logLevelFlag: an empty --log-level resolves to info", () => {
  expect(logLevelFlag(argv({ "log-level": "" }))).toBe(logLibrary.levels.INFO);
});

test.each([
  ["silent", logLibrary.levels.SILENT],
  ["error", logLibrary.levels.ERROR],
  ["warn", logLibrary.levels.WARN],
  ["info", logLibrary.levels.INFO],
  ["debug", logLibrary.levels.DEBUG],
  ["trace", logLibrary.levels.TRACE],
])("logLevelFlag: %s resolves to its loglevel constant", (name, expected) => {
  expect(logLevelFlag(argv({ "log-level": name }))).toBe(expected);
});

test("logLevelFlag: the level name is matched case-insensitively", () => {
  expect(logLevelFlag(argv({ "log-level": "DeBuG" }))).toBe(
    logLibrary.levels.DEBUG,
  );
});

test("logLevelFlag: an unrecognized name is a UsageError", () => {
  expect(() => logLevelFlag(argv({ "log-level": "bogus" }))).toThrow(
    UsageError,
  );
});

test("logLevelFlag: the rejection echoes the value as the operator typed it", () => {
  // The echo is the pre-lowercase value, so the message names the token on the
  // command line rather than a normalized form the operator never wrote.
  expect(() => logLevelFlag(argv({ "log-level": "BoGuS" }))).toThrow(
    "unrecognized log-level: BoGuS",
  );
});

test("logLevelFlag: an Object.prototype member is not a level name", () => {
  // The lookup key is operator-supplied, so a level table an inherited member
  // answers would hand a function back where a level number is expected and slip
  // past the rejection, reaching loglevel's own "invalid level" throw instead of
  // the usage error every other typo gets.
  for (const name of [
    "constructor",
    "toString",
    "valueOf",
    "hasOwnProperty",
    "__proto__",
  ])
    expect(() => logLevelFlag(argv({ "log-level": name }))).toThrow(
      `unrecognized log-level: ${name}`,
    );
});

test("logLevelFlag: a repeated --log-level is rejected before the resolve", () => {
  expect(() => logLevelFlag(argv({ "log-level": ["info", "debug"] }))).toThrow(
    "--log-level may be given only once",
  );
});

// --- The exit at every command entry point -----------------------------------

interface CommandEntryPoint {
  // `<module file>#<export>` under src/commands, checked against the modules
  // themselves by the drift guard at the end of this file.
  entryPoint: string;
  run: (args: Arguments) => Promise<void>;
}

const COMMAND_ENTRY_POINTS: CommandEntryPoint[] = [
  { entryPoint: "accept.ts#handler", run: acceptHandler },
  { entryPoint: "doctor.ts#mountHandler", run: mountHandler },
  { entryPoint: "doctor.ts#probeHandler", run: probeHandler },
  { entryPoint: "exchange.ts#handler", run: exchangeHandler },
  { entryPoint: "fingerprint.ts#handler", run: fingerprintHandler },
  { entryPoint: "init.ts#handler", run: initHandler },
  { entryPoint: "invite.ts#handler", run: inviteHandler },
  { entryPoint: "probeHostKey.ts#handler", run: probeHostKeyHandler },
  { entryPoint: "verifyReceipt.ts#handler", run: verifyReceiptHandler },
  { entryPoint: "zeroSetup.ts#handler", run: zeroSetupHandler },
];

// Two shapes of unrecognized value: a plain typo, and a name Object.prototype
// carries. The second exits 64 only because the resolve rejects it -- a table
// that answered it would send a function into loglevel's setLevel, whose throw is
// not a UsageError and so escapes every command's usage boundary.
const REJECTED_VALUES = ["bogus", "constructor"];

test.each(
  COMMAND_ENTRY_POINTS.flatMap((entry) =>
    REJECTED_VALUES.map((value) => ({ ...entry, value })),
  ),
)("$entryPoint: --log-level $value exits 64", async ({ run, value }) => {
  const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  // The runOrExit-based commands report through a logger onto the diagnostic
  // sink rather than console.error, so both descriptors are captured too.
  const { restore } = captureStdio();
  const exitSpy = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  try {
    // Every command resolves the log level before it reads any other option or
    // touches the filesystem, so the rejection lands with no more argv than the
    // bad flag; `input` is carried for the commands whose option parse reads it
    // on the way to the resolve.
    await expect(
      run(argv({ input: "x.csv", "log-level": value })),
    ).rejects.toThrow("exit:64");
  } finally {
    exitSpy.mockRestore();
    restore();
    errSpy.mockRestore();
  }
});

test("every command entry point is covered by the table above", () => {
  // A new command inherits --log-level (through optionDefinitions or its own
  // builder) but not the exit above, so the table is checked against the command
  // modules rather than left to be remembered. A future command that does not
  // take the flag fails this and gets an explicit decision, which is the point.
  const commandsDir = path.join(__dirname, "..", "..", "src", "commands");
  const declared: string[] = [];
  for (const file of fs.readdirSync(commandsDir)) {
    if (!file.endsWith(".ts")) continue;
    const source = fs.readFileSync(path.join(commandsDir, file), "utf8");
    for (const match of source.matchAll(
      /^export (?:async )?function (\w*[Hh]andler)\(/gm,
    ))
      declared.push(`${file}#${match[1]}`);
  }
  expect(declared.sort()).toEqual(
    COMMAND_ENTRY_POINTS.map((entry) => entry.entryPoint).sort(),
  );
});
