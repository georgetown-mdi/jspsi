import { afterEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import { csvDelimiterRefusal, UsageError } from "@psilink/core";

import { csvDelimiterFlag } from "../../../src/util/flags";
import { buildCli } from "../../../src/cliParser";

function argv(extra: Record<string, unknown>): Arguments {
  return { _: [], $0: "psilink", ...extra } as unknown as Arguments;
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("csvDelimiterFlag returns the character for each accepted value", () => {
  for (const value of [",", "|", ";", "^", " "])
    expect(csvDelimiterFlag(argv({ "csv-delimiter": value }))).toBe(value);
  expect(csvDelimiterFlag(argv({}))).toBeUndefined();
});

test("csvDelimiterFlag takes the tab spellings a command line can type", () => {
  for (const spelling of ["tab", "TAB", "\\t", "\t"])
    expect(csvDelimiterFlag(argv({ "csv-delimiter": spelling }))).toBe("\t");
});

test("csvDelimiterFlag refuses a value outside the accepted set, naming the flag", () => {
  for (const value of ["::", "", '"', "\n", "§"]) {
    let raised: unknown;
    try {
      csvDelimiterFlag(argv({ "csv-delimiter": value }));
    } catch (err) {
      raised = err;
    }
    expect(raised).toBeInstanceOf(UsageError);
    // The one rule, worded once in core: the flag states it rather than
    // restating it, so the configuration schema and the command line cannot
    // refuse the same value differently.
    expect((raised as Error).message).toBe(
      `--csv-delimiter: ${csvDelimiterRefusal(value)}`,
    );
  }
});

test("csvDelimiterFlag refuses a repeated flag rather than reading an array", () => {
  expect(() => csvDelimiterFlag(argv({ "csv-delimiter": ["|", ";"] }))).toThrow(
    UsageError,
  );
});

/** A command's own `--help` text, which lists the options its builder added.
 * `--help` short-circuits before any handler, so no command runs here. */
async function helpFor(command: string[]): Promise<string> {
  const printed: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...args) => {
    printed.push(args.map(String).join(" "));
  });
  const write = vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: string | Uint8Array,
  ) => {
    printed.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"),
    );
    return true;
  }) as typeof process.stdout.write);
  try {
    await buildCli([...command, "--help"])
      .exitProcess(false)
      .parseAsync();
  } finally {
    log.mockRestore();
    write.mockRestore();
  }
  return printed.join("\n");
}

test("every command that reads a CSV offers --csv-delimiter, and one that reads none does not", async () => {
  for (const command of [
    ["exchange"],
    [],
    ["invite"],
    ["accept"],
    ["init"],
    ["verify-receipt"],
  ])
    expect(await helpFor(command)).toContain("--csv-delimiter");

  for (const command of [["probe-host-key"], ["fingerprint"]])
    expect(await helpFor(command)).not.toContain("--csv-delimiter");
});

test("a command that reads no CSV refuses the flag as an unknown option", async () => {
  // strictOptions, not a check of this flag's own: the refusal a dropped flag
  // gets on those commands is the one every unknown option gets.
  const stderr: string[] = [];
  const error = vi.spyOn(console, "error").mockImplementation((...args) => {
    stderr.push(args.map(String).join(" "));
  });
  const exit = vi.spyOn(process, "exit").mockImplementation(((
    code?: number,
  ) => {
    throw new Error(`exit:${String(code)}`);
  }) as never);
  let raised = "";
  try {
    await buildCli([
      "probe-host-key",
      "sftp://h/p",
      "--csv-delimiter",
      "|",
    ]).parseAsync();
  } catch (err) {
    raised = err instanceof Error ? err.message : String(err);
  } finally {
    error.mockRestore();
    exit.mockRestore();
  }
  expect(raised).toBe("exit:64");
  expect(stderr.join("\n")).toContain("csv-delimiter");
});
