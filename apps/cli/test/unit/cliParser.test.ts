import { afterEach, expect, test, vi } from "vitest";

import { buildCli } from "../../src/cliParser";

afterEach(() => {
  vi.restoreAllMocks();
});

// Drive the real parser against a synthetic argv with process.exit trapped (so
// execution stops at the exit instead of tearing down the test runner) and the
// console captured. Returns the rejection message the trapped exit produced (e.g.
// "exit:64") and the captured stderr text. No command handler runs in any case
// here: a strict-option failure fires before the handler, and --help short-
// circuits, so this drives only the parser, not a real exchange.
async function parse(
  argv: string[],
): Promise<{ exit: string; stderr: string }> {
  const stderr: string[] = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process.stdout, "write").mockImplementation((() => true) as never);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as never);
  let exit = "";
  try {
    await buildCli(argv).parseAsync();
  } catch (err) {
    exit = err instanceof Error ? err.message : String(err);
  }
  return { exit, stderr: stderr.join("\n") };
}

test("a misspelled option on the zero-setup command exits 64, naming the option", async () => {
  // The reported failure: `--server-user` (for `--server-username`) was silently
  // dropped and the run proceeded with the default, so a mistyped credential went
  // unnoticed. It must now fail fast, before any connection.
  const { exit, stderr } = await parse([
    "--server-user",
    "u",
    "sftp://h/p",
    "in.csv",
    "out.csv",
  ]);
  expect(exit).toBe("exit:64");
  expect(stderr).toContain("Unknown arguments");
  expect(stderr).toContain("server-user");
  expect(stderr).toContain("Run with --help");
});

test("a misspelled option on a subcommand exits 64, naming the option", async () => {
  const { exit, stderr } = await parse(["exchange", "in.csv", "--retain-file"]);
  expect(exit).toBe("exit:64");
  expect(stderr).toContain("retain-file");
});

test("the unknown-argument message is routed through the display sanitizer", async () => {
  // A control byte in an option token must never reach the terminal raw (it could
  // drive an ANSI/escape sequence): the message is printed through
  // sanitizeForDisplay, which escapes the ESC (U+001B) to a visible `\x1b`. Build
  // the ESC with fromCharCode so no raw control byte lives in this source file.
  const esc = String.fromCharCode(0x1b);
  const { exit, stderr } = await parse([
    "exchange",
    "in.csv",
    `--foo${esc}bar`,
  ]);
  expect(exit).toBe("exit:64");
  expect(stderr).not.toContain(esc);
  expect(stderr).toContain("\\x1b");
});

test("--help short-circuits without a strict-option failure", async () => {
  // A known path (help) is not swept up by strictOptions: it exits 0 and prints no
  // unknown-argument error, confirming the check does not false-fire.
  const { exit, stderr } = await parse(["exchange", "--help"]);
  expect(exit).toBe("exit:0");
  expect(stderr).not.toContain("Unknown arguments");
});
