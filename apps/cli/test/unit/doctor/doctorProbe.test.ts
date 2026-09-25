import fs from "node:fs";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

import { MAX_DIRECTORY_ENTRIES } from "../../../src/connection/listingGuard";
import { OutputCapture } from "../../../src/doctor/runner";
import type { CommandResult, CommandRunner } from "../../../src/doctor/runner";
import {
  PROBE_CHECK_IDS,
  countEntries,
  dialectArgs,
  freeMegabytes,
  runProbe,
  statusOf,
  transportFailed,
  withoutListingEntries,
} from "../../../src/doctor/probe";
import type { ProbeDeps } from "../../../src/doctor/probe";
import type { SmbProbeInput } from "../../../src/doctor/smbEnvironment";
import {
  overallOf,
  verdictJson,
  verdictLines,
  verdictOf,
} from "../../../src/doctor/verdict";
import type { DoctorReport } from "../../../src/doctor/verdict";
import { currentWindowsUser, isOwnerOnly } from "../../windowsAcl";

const PASSWORD = "correct horse battery";

const INPUT: SmbProbeInput = {
  server: "files.example.org",
  share: "exchange",
  subdirectory: "dropbox",
  username: "svc-alcove",
  domain: "AGENCY",
  password: PASSWORD,
  dialect: "",
  marker: "alcove-check.txt",
  token: "abc123",
};

const SHARE_LIST = [
  "\tSharename       Type      Comment",
  "\t---------       ----      -------",
  "\texchange        Disk",
  "\tIPC$            IPC       IPC Service",
  "",
].join("\n");

const DIRECTORY_LISTING = [
  "  .                                   D        0  Mon Jan  1 00:00:00 2024",
  "  ..                                  D        0  Mon Jan  1 00:00:00 2024",
  "  january.csv                         A      100  Mon Jan  1 00:00:00 2024",
  "",
  "\t\t10485760 blocks of size 1024. 5242880 blocks available",
  "",
].join("\n");

/** A listing holding a file named like an smbclient error status. */
const STATUS_NAMED_LISTING = [
  "  .                                   D        0  Mon Jan  1 00:00:00 2024",
  "  ..                                  D        0  Mon Jan  1 00:00:00 2024",
  "  NT_STATUS_ACCESS_DENIED.csv         A      100  Mon Jan  1 00:00:00 2024",
  "  secret-client-list.csv              A      100  Mon Jan  1 00:00:00 2024",
  "",
  "\t\t10485760 blocks of size 1024. 5242880 blocks available",
  "",
].join("\n");

/**
 * A listing on a full share holding a file named like the free-space line,
 * ahead of the real one.
 */
const SPACE_NAMED_LISTING = [
  "  .                                   D        0  Mon Jan  1 00:00:00 2024",
  "  ..                                  D        0  Mon Jan  1 00:00:00 2024",
  "  blocks of size 1048576. 999999 blocks available      A      100  Mon Jan  1 00:00:00 2024",
  "",
  "\t\t1024 blocks of size 1024. 0 blocks available",
  "",
].join("\n");

/** A listing one entry past the bound the transport will refuse to read. */
function oversizedListing(): string {
  return [
    "  .                                   D        0  Mon Jan  1 00:00:00 2024",
    "  ..                                  D        0  Mon Jan  1 00:00:00 2024",
    ...Array.from(
      { length: MAX_DIRECTORY_ENTRIES + 1 },
      (_, i) =>
        `  file-${i}.csv                      A      100  Mon Jan  1 00:00:00 2024`,
    ),
    "",
    "\t\t10485760 blocks of size 1024. 5242880 blocks available",
    "",
  ].join("\n");
}

interface Invocation {
  args: string[];
  cwd?: string;
  /**
   * The credentials file as it stood while this invocation ran. Windows holds
   * no POSIX mode -- `fs.statSync` reports a synthetic 0o666 there whatever
   * the access list says -- so the owner-only state is read off the access
   * list itself on that platform and left undefined elsewhere.
   */
  authFile?: {
    path: string;
    contents: string;
    mode: number;
    ownerOnly?: boolean;
  };
}

/** The `-c` command an invocation contains, if any. */
function commandOf(args: string[]): string | undefined {
  const index = args.indexOf("-c");
  return index === -1 ? undefined : args[index + 1];
}

function authPathOf(args: string[]): string | undefined {
  const index = args.indexOf("-A");
  return index === -1 ? undefined : args[index + 1];
}

/**
 * A runner that answers from `reply` and records every invocation, including a
 * snapshot of the credentials file as it stood at the time -- the file is
 * removed when the run ends, so it can only be inspected from inside a call.
 * The reply's output passes through the real runner's output cap.
 */
function fakeRunner(reply: (args: string[]) => Partial<CommandResult>): {
  runner: CommandRunner;
  calls: Invocation[];
} {
  const calls: Invocation[] = [];
  return {
    calls,
    runner: {
      run(_file, args, options): Promise<CommandResult> {
        const authPath = authPathOf(args);
        const call: Invocation = { args, cwd: options.cwd };
        if (authPath !== undefined && fs.existsSync(authPath))
          call.authFile = {
            path: authPath,
            contents: fs.readFileSync(authPath, "utf8"),
            mode: fs.statSync(authPath).mode & 0o777,
            ...(process.platform === "win32"
              ? { ownerOnly: isOwnerOnly(authPath, currentWindowsUser()) }
              : {}),
          };
        calls.push(call);
        const result: CommandResult = {
          code: 0,
          output: "",
          timedOut: false,
          ...reply(args),
        };
        const capture = new OutputCapture();
        capture.append(result.output);
        return Promise.resolve({
          ...result,
          output: capture.text,
          truncated: capture.truncated || result.truncated === true,
        });
      },
    },
  };
}

function deps(
  reply: (args: string[]) => Partial<CommandResult>,
  overrides: Partial<ProbeDeps> = {},
): ProbeDeps & { calls: Invocation[] } {
  const { runner, calls } = fakeRunner(reply);
  return {
    runner,
    lookupHost: () => Promise.resolve("10.10.0.5"),
    connectTcp: () => Promise.resolve(true),
    ...overrides,
    calls,
  };
}

/** The reply of a share that answers every step the way a healthy one does. */
function healthyReply(args: string[]): Partial<CommandResult> {
  if (args.includes("--version")) return { output: "Version 4.19.5" };
  if (args.includes("-L")) return { output: SHARE_LIST };
  if (commandOf(args) === "ls") return { output: DIRECTORY_LISTING };
  return { output: "" };
}

function checkById(report: DoctorReport, id: string) {
  const check = report.checks.find((entry) => entry.id === id);
  if (check === undefined) throw new Error(`no check ${id} in the report`);
  return check;
}

describe("a healthy file drop", () => {
  test("reports every check ok, in the fixed order", async () => {
    const probeDeps = deps(healthyReply);
    const report = await runProbe(INPUT, probeDeps);
    expect(report.checks.map((check) => check.id)).toEqual([
      ...PROBE_CHECK_IDS,
    ]);
    expect(overallOf(report)).toBe("ok");
    for (const check of report.checks) expect(check.status).toBe("ok");
  });

  test("names the share it found in the account's share list", async () => {
    const report = await runProbe(INPUT, deps(healthyReply));
    expect(checkById(report, "authentication").summary).toContain("exchange");
  });

  test("counts the folder's entries instead of listing them", async () => {
    const report = await runProbe(INPUT, deps(healthyReply));
    const summary = checkById(report, "subdirectory").summary;
    expect(summary).toContain("1 file(s)");
    expect(summary).not.toContain("january.csv");
    expect(JSON.stringify(verdictOf(report))).not.toContain("january.csv");
  });

  test("reads free space off the listing", async () => {
    const report = await runProbe(INPUT, deps(healthyReply));
    expect(checkById(report, "free_space").summary).toContain("5120 MB");
  });

  test("leaves the marker behind for the mount check", async () => {
    const probeDeps = deps(healthyReply);
    await runProbe(INPUT, probeDeps);
    const commands = probeDeps.calls.map((call) => commandOf(call.args));
    expect(commands).toContain("put alcove-check.txt alcove-check.txt");
    // The probe file it created is removed; the marker is not.
    expect(commands).toContain("del alcove-probe-abc123.tmp.renamed");
  });
});

describe("the credential never becomes an argv value", () => {
  test("no argument on any invocation contains the password", async () => {
    const probeDeps = deps(healthyReply);
    await runProbe(INPUT, probeDeps);
    expect(probeDeps.calls.length).toBeGreaterThan(3);
    for (const call of probeDeps.calls)
      for (const arg of call.args) expect(arg).not.toContain(PASSWORD);
  });

  test("it travels in an owner-only credentials file that is removed after", async () => {
    const probeDeps = deps(healthyReply);
    await runProbe(INPUT, probeDeps);
    const withAuth = probeDeps.calls.filter(
      (call) => call.authFile !== undefined,
    );
    expect(withAuth.length).toBeGreaterThan(0);
    for (const call of withAuth) {
      if (process.platform === "win32")
        expect(call.authFile?.ownerOnly).toBe(true);
      else expect(call.authFile?.mode).toBe(0o600);
      expect(call.authFile?.contents).toBe(
        `username=svc-alcove\npassword=${PASSWORD}\ndomain=AGENCY\n`,
      );
    }
    expect(fs.existsSync(withAuth[0].authFile?.path ?? "")).toBe(false);
  });
});

describe("the subdirectory is entered with -D, never a -c command", () => {
  test("every command after the subdirectory check includes -D", async () => {
    const probeDeps = deps(healthyReply);
    await runProbe(INPUT, probeDeps);
    const staged = probeDeps.calls.filter((call) =>
      commandOf(call.args)?.startsWith("put alcove-probe"),
    );
    expect(staged.length).toBe(1);
    expect(staged[0].args).toContain("-D");
    expect(staged[0].args[staged[0].args.indexOf("-D") + 1]).toBe("dropbox");
    for (const call of probeDeps.calls)
      expect(commandOf(call.args) ?? "").not.toContain("cd ");
  });

  test("the local side of a put is a bare name run from the work directory", async () => {
    const probeDeps = deps(healthyReply);
    await runProbe(INPUT, probeDeps);
    const put = probeDeps.calls.find((call) =>
      commandOf(call.args)?.startsWith("put alcove-probe"),
    );
    expect(commandOf(put?.args ?? [])).toBe(
      "put alcove-probe-abc123.tmp alcove-probe-abc123.tmp",
    );
    expect(put?.cwd).toBeTypeOf("string");
  });
});

describe("a pinned dialect moves the client minimum as well as the maximum", () => {
  test("both options appear on every invocation", async () => {
    const probeDeps = deps(healthyReply);
    await runProbe({ ...INPUT, dialect: "SMB3" }, probeDeps);
    for (const call of probeDeps.calls.slice(1)) {
      expect(call.args).toContain("-m");
      expect(call.args).toContain("--option=client min protocol=SMB3");
    }
  });

  test("no dialect arguments when none is pinned", () => {
    expect(dialectArgs("")).toEqual([]);
  });
});

describe("staged failures", () => {
  test("a wrong password fails authentication and skips the rest", async () => {
    const report = await runProbe(
      INPUT,
      deps((args) =>
        args.includes("-L")
          ? { code: 1, output: "session setup failed: NT_STATUS_LOGON_FAILURE" }
          : healthyReply(args),
      ),
    );
    expect(overallOf(report)).toBe("fix_and_retry");
    const check = checkById(report, "authentication");
    expect(check.status).toBe("fail");
    expect(check.summary).toBe("NT_STATUS_LOGON_FAILURE");
    expect(check.action).toContain("SMB_DOMAIN");
    expect(checkById(report, "write").status).toBe("skipped");
    expect(report.checks.map((entry) => entry.id)).toEqual([
      ...PROBE_CHECK_IDS,
    ]);
  });

  test("a nonexistent share fails at share_open, not at the credentials", async () => {
    const report = await runProbe(
      INPUT,
      deps((args) =>
        commandOf(args) === "ls" && !args.includes("-D")
          ? {
              code: 1,
              output: "tree connect failed: NT_STATUS_BAD_NETWORK_NAME",
            }
          : healthyReply(args),
      ),
    );
    expect(checkById(report, "authentication").status).toBe("ok");
    const check = checkById(report, "share_open");
    expect(check.status).toBe("fail");
    expect(check.meaning).toContain("no share called 'exchange'");
  });

  test("a read-only share passes every earlier check and fails at write", async () => {
    const probeDeps = deps((args) =>
      commandOf(args)?.startsWith("put ") === true
        ? { code: 1, output: "NT_STATUS_ACCESS_DENIED opening remote file" }
        : healthyReply(args),
    );
    const report = await runProbe(INPUT, probeDeps);
    expect(checkById(report, "subdirectory").status).toBe("ok");
    const check = checkById(report, "write");
    expect(check.status).toBe("fail");
    expect(check.meaning).toContain("not write");
    expect(checkById(report, "rename").status).toBe("skipped");
    expect(overallOf(report)).toBe("fix_and_retry");
    // What it wrote (or tried to) is swept before it returns, even on the
    // failure path: the share belongs to someone else.
    expect(probeDeps.calls.map((call) => commandOf(call.args))).toContain(
      "del alcove-probe-abc123.tmp",
    );
  });

  test("a create-but-not-rename share fails at rename with its own action", async () => {
    const report = await runProbe(
      INPUT,
      deps((args) =>
        commandOf(args)?.startsWith("rename ") === true
          ? { code: 1, output: "NT_STATUS_ACCESS_DENIED renaming files" }
          : healthyReply(args),
      ),
    );
    expect(checkById(report, "write").status).toBe("ok");
    expect(checkById(report, "rename").status).toBe("fail");
    expect(checkById(report, "rename").action).toContain("DELETE right");
  });

  test("a share with no free space warns and asks for quota", async () => {
    const report = await runProbe(
      INPUT,
      deps((args) =>
        commandOf(args) === "ls"
          ? {
              output:
                "  .   D  0  Mon Jan  1 00:00:00 2024\n\n" +
                "\t\t1024 blocks of size 1024. 0 blocks available\n",
            }
          : healthyReply(args),
      ),
    );
    const check = checkById(report, "free_space");
    expect(check.status).toBe("warn");
    expect(check.action).toContain("quota");
    expect(overallOf(report)).toBe("ok");
  });
});

describe("a transport that dies without a verdict is not a server refusal", () => {
  test("a timed-out list is reported as a stopped connection", async () => {
    const report = await runProbe(
      INPUT,
      deps((args) =>
        args.includes("-L")
          ? { code: 124, output: "", timedOut: true }
          : healthyReply(args),
      ),
    );
    const check = checkById(report, "authentication");
    expect(check.status).toBe("fail");
    expect(check.summary).toContain("stopped responding");
    expect(check.meaning).toContain("sent nothing back");
  });

  test("a wedged server mentioning negotiation is not read as a dialect refusal", async () => {
    // Only a refusal has an NT_STATUS token, so classifying on the token
    // rather than the word keeps a server that died mid-negotiation from being
    // reported as a dialect disagreement the operator would chase.
    const report = await runProbe(
      INPUT,
      deps((args) =>
        args.includes("-L")
          ? { code: 1, output: "protocol negotiation failed: connection reset" }
          : healthyReply(args),
      ),
    );
    expect(checkById(report, "authentication").summary).toContain(
      "stopped responding",
    );
  });

  test("a genuine dialect refusal is reported as one", async () => {
    const report = await runProbe(
      INPUT,
      deps((args) =>
        args.includes("-L")
          ? {
              code: 0,
              output: "protocol negotiation failed: NT_STATUS_CONNECTION_RESET",
            }
          : healthyReply(args),
      ),
    );
    const check = checkById(report, "authentication");
    expect(check.status).toBe("fail");
    expect(check.summary).toContain("SMB dialect");
    expect(check.action).toContain("SMB_DIALECT");
  });
});

describe("checks that could not run are fatal, not a verdict", () => {
  test("smbclient missing from the image stops the run before any connection", async () => {
    const probeDeps = deps((args) =>
      args.includes("--version")
        ? { code: null, output: "", spawnErrorCode: "ENOENT" }
        : healthyReply(args),
    );
    const report = await runProbe(INPUT, probeDeps);
    expect(overallOf(report)).toBe("fatal");
    expect(checkById(report, "smbclient_available").status).toBe("fail");
    expect(checkById(report, "authentication").status).toBe("skipped");
    expect(probeDeps.calls).toHaveLength(1);
  });

  test("an unresolvable name stops before smbclient is invoked at all", async () => {
    const probeDeps = deps(healthyReply, {
      lookupHost: () => Promise.resolve(undefined),
    });
    const report = await runProbe(INPUT, probeDeps);
    expect(overallOf(report)).toBe("fix_and_retry");
    expect(checkById(report, "name_resolution").status).toBe("fail");
    expect(probeDeps.calls).toHaveLength(0);
  });

  test("a literal address needs no resolution", async () => {
    const report = await runProbe(
      { ...INPUT, server: "10.10.0.5" },
      deps(healthyReply, {
        lookupHost: () => Promise.reject(new Error("must not be called")),
      }),
    );
    expect(checkById(report, "name_resolution").status).toBe("ok");
  });

  test("an unreachable port 445 stops before smbclient is invoked", async () => {
    const probeDeps = deps(healthyReply, {
      connectTcp: () => Promise.resolve(false),
    });
    const report = await runProbe(INPUT, probeDeps);
    expect(checkById(report, "tcp_445").status).toBe("fail");
    expect(probeDeps.calls).toHaveLength(0);
  });
});

describe("inputs that change the shape of the run", () => {
  test("no subdirectory targets the share root and counts its entries", async () => {
    const probeDeps = deps(healthyReply);
    const report = await runProbe({ ...INPUT, subdirectory: "" }, probeDeps);
    const check = checkById(report, "subdirectory");
    expect(check.status).toBe("ok");
    expect(check.summary).toContain("share root");
    expect(check.summary).toContain("1 file(s)");
    expect(overallOf(report)).toBe("ok");
    for (const call of probeDeps.calls) expect(call.args).not.toContain("-D");
  });

  test("an oversized exchange folder has the entry-count advisory", async () => {
    const report = await runProbe(
      INPUT,
      deps((args) =>
        commandOf(args) === "ls" && args.includes("-D")
          ? { output: oversizedListing() }
          : healthyReply(args),
      ),
    );
    const check = checkById(report, "subdirectory");
    expect(check.status).toBe("warn");
    expect(check.meaning).toContain(
      `holding more than ${MAX_DIRECTORY_ENTRIES} entries, so an exchange here will fail`,
    );
    expect(check.action).toBe("use a folder dedicated to the exchange.");
    expect(overallOf(report)).toBe("ok");
  });

  test("an oversized share root has the same advisory", async () => {
    const report = await runProbe(
      { ...INPUT, subdirectory: "" },
      deps((args) =>
        commandOf(args) === "ls"
          ? { output: oversizedListing() }
          : healthyReply(args),
      ),
    );
    const check = checkById(report, "subdirectory");
    expect(check.status).toBe("warn");
    expect(check.action).toContain("dedicated to the exchange");
    expect(overallOf(report)).toBe("ok");
  });

  test("a listing the output cap cut short of the bound leaves the count open and has no free-space figure", async () => {
    const report = await runProbe(
      INPUT,
      deps((args) =>
        commandOf(args) === "ls" && args.includes("-D")
          ? { output: STATUS_NAMED_LISTING.split("\n\n")[0], truncated: true }
          : healthyReply(args),
      ),
    );
    const subdirectory = checkById(report, "subdirectory");
    expect(subdirectory.status).toBe("warn");
    expect(subdirectory.summary).toContain("at least 2 file(s)");
    expect(subdirectory.meaning).toContain("too long to capture in full");
    expect(subdirectory.meaning).not.toContain("will fail");
    expect(subdirectory.action).toBe(
      `confirm the folder holds no more than ${MAX_DIRECTORY_ENTRIES} ` +
        "entries, or use a folder dedicated to the exchange.",
    );
    const freeSpace = checkById(report, "free_space");
    expect(freeSpace.status).toBe("skipped");
    expect(freeSpace.summary).toContain("too long");
  });

  test("a share root that will not list is not a failure when a subfolder was given", async () => {
    const report = await runProbe(
      INPUT,
      deps((args) =>
        commandOf(args) === "ls" && !args.includes("-D")
          ? { code: 1, output: "NT_STATUS_ACCESS_DENIED listing" }
          : healthyReply(args),
      ),
    );
    const check = checkById(report, "share_open");
    expect(check.status).toBe("ok");
    expect(check.meaning).toContain("granted rights to your own folder");
    expect(overallOf(report)).toBe("ok");
  });

  test("a file named like an error status does not fail the subdirectory", async () => {
    const report = await runProbe(
      INPUT,
      deps((args) =>
        commandOf(args) === "ls" && args.includes("-D")
          ? { output: STATUS_NAMED_LISTING }
          : healthyReply(args),
      ),
    );
    expect(checkById(report, "subdirectory").summary).toContain("2 file(s)");
    expect(overallOf(report)).toBe("ok");
    for (const check of report.checks) expect(check.status).toBe("ok");
  });

  test("a file named like an error status does not fail the share root", async () => {
    const report = await runProbe(
      { ...INPUT, subdirectory: "" },
      deps((args) =>
        commandOf(args) === "ls"
          ? { output: STATUS_NAMED_LISTING }
          : healthyReply(args),
      ),
    );
    expect(checkById(report, "share_open").status).toBe("ok");
    expect(checkById(report, "subdirectory").summary).toContain("2 file(s)");
    expect(overallOf(report)).toBe("ok");
  });

  test("a refused listing keeps its entries out of the human verdict", async () => {
    const report = await runProbe(
      INPUT,
      deps((args) =>
        commandOf(args) === "ls" && args.includes("-D")
          ? {
              code: 1,
              output: `${STATUS_NAMED_LISTING}NT_STATUS_ACCESS_DENIED listing \\dropbox\\*`,
            }
          : healthyReply(args),
      ),
    );
    const check = checkById(report, "subdirectory");
    expect(check.status).toBe("fail");
    expect(check.summary).toBe("NT_STATUS_ACCESS_DENIED");
    const rendered = verdictLines(report).join("\n");
    expect(rendered).toContain("listing \\dropbox\\*");
    expect(rendered).not.toContain("secret-client-list");
    expect(rendered).not.toContain("NT_STATUS_ACCESS_DENIED.csv");
  });

  test("a filename shaped like the free-space line does not set the figure", async () => {
    const report = await runProbe(
      INPUT,
      deps((args) =>
        commandOf(args) === "ls"
          ? { output: SPACE_NAMED_LISTING }
          : healthyReply(args),
      ),
    );
    const check = checkById(report, "free_space");
    expect(check.status).toBe("warn");
    expect(check.summary).toBe("the share reports no free space.");
  });

  test("no marker requested leaves nothing behind and skips the check", async () => {
    const probeDeps = deps(healthyReply);
    const report = await runProbe({ ...INPUT, marker: "" }, probeDeps);
    expect(checkById(report, "marker").status).toBe("skipped");
    for (const call of probeDeps.calls)
      expect(commandOf(call.args) ?? "").not.toContain("alcove-check.txt");
  });

  test("a marker the share refuses is a skip, not a failure", async () => {
    const report = await runProbe(
      INPUT,
      deps((args) =>
        commandOf(args)?.startsWith("put alcove-check") === true
          ? { code: 1, output: "NT_STATUS_ACCESS_DENIED" }
          : healthyReply(args),
      ),
    );
    expect(checkById(report, "marker").status).toBe("skipped");
    expect(overallOf(report)).toBe("ok");
  });
});

describe("smbclient output parsing", () => {
  test("statusOf ignores NT_STATUS_OK and takes the first real status", () => {
    expect(statusOf("NT_STATUS_OK\nNT_STATUS_ACCESS_DENIED")).toBe(
      "NT_STATUS_ACCESS_DENIED",
    );
    expect(statusOf("Domain=[X] OS=[Y]")).toBeUndefined();
  });

  test("transportFailed needs both a nonzero exit and no status", () => {
    const base = { output: "", timedOut: false };
    expect(transportFailed({ ...base, code: 0 })).toBe(false);
    expect(transportFailed({ ...base, code: 1 })).toBe(true);
    expect(
      transportFailed({ ...base, code: 1, output: "NT_STATUS_ACCESS_DENIED" }),
    ).toBe(false);
    expect(
      transportFailed({ ...base, code: 0, output: "NT_STATUS_ACCESS_DENIED" }),
    ).toBe(false);
  });

  test("freeMegabytes reads the block report, or nothing", () => {
    expect(
      freeMegabytes(
        "\t\t10485760 blocks of size 1024. 5242880 blocks available",
      ),
    ).toBe(5120);
    expect(freeMegabytes("no space line here")).toBeUndefined();
  });

  test("statusOf does not read a status out of a listing entry", () => {
    expect(statusOf(STATUS_NAMED_LISTING)).toBeUndefined();
    expect(
      statusOf(`${STATUS_NAMED_LISTING}\nNT_STATUS_IO_TIMEOUT listing \\*`),
    ).toBe("NT_STATUS_IO_TIMEOUT");
  });

  test("freeMegabytes reads the trailer line, not a filename shaped like it", () => {
    expect(freeMegabytes(SPACE_NAMED_LISTING)).toBe(0);
    expect(
      freeMegabytes(
        "  1 blocks of size 1048576. 999999 blocks available   A  0  Mon Jan  1 00:00:00 2024",
      ),
    ).toBeUndefined();
  });

  test("countEntries excludes the dot entries", () => {
    expect(countEntries(DIRECTORY_LISTING)).toBe(1);
    expect(countEntries("")).toBe(0);
  });
});

describe("every skipped record explains itself", () => {
  test("padded, inapplicable, and incomplete skips all have a meaning", async () => {
    const reports = [
      await runProbe(
        INPUT,
        deps((args) =>
          args.includes("--version")
            ? { code: null, output: "", spawnErrorCode: "ENOENT" }
            : healthyReply(args),
        ),
      ),
      await runProbe({ ...INPUT, marker: "" }, deps(healthyReply)),
      await runProbe(
        INPUT,
        deps((args) =>
          commandOf(args) === "put alcove-check.txt alcove-check.txt"
            ? { code: 1, output: "NT_STATUS_ACCESS_DENIED putting file" }
            : healthyReply(args),
        ),
      ),
    ];
    let skips = 0;
    for (const report of reports)
      for (const check of report.checks)
        if (check.status === "skipped") {
          skips += 1;
          expect(check.meaning).toBeDefined();
        }
    expect(skips).toBeGreaterThan(0);
  });

  test("a check a failure stopped the run before names itself", async () => {
    const report = await runProbe(
      INPUT,
      deps((args) =>
        commandOf(args)?.startsWith("rename ") === true
          ? { code: 1, output: "NT_STATUS_ACCESS_DENIED renaming files" }
          : healthyReply(args),
      ),
    );
    const padded = report.checks.filter(
      (check) =>
        check.status === "skipped" && check.summary.endsWith("not run."),
    );
    expect(padded.map((check) => check.id)).toEqual(["delete", "marker"]);
    // A summary of its own per check, so the run reports what the failure
    // cost rather than one sentence repeated.
    expect(new Set(padded.map((check) => check.summary)).size).toBe(
      padded.length,
    );
    expect(checkById(report, "delete").summary).toContain("deleting a file");
    expect(new Set(padded.map((check) => check.meaning)).size).toBe(1);
  });
});

describe("local cleanup does not depend on the remote", () => {
  test("a runner that dies during del still loses the work directory", async () => {
    // The throw is pinned to this run's own litter name, not the wildcard
    // stale-mask sweep that runs before litter has a member: the finally's
    // litter loop must actually iterate for this test to measure its guard.
    let authDir: string | undefined;
    const probeDeps = deps((args) => {
      const authPath = authPathOf(args);
      if (authPath !== undefined) authDir = path.dirname(authPath);
      const command = commandOf(args) ?? "";
      if (command.startsWith("del alcove-probe-") && !command.includes("*"))
        throw new Error("runner died");
      return healthyReply(args);
    });
    await expect(runProbe(INPUT, probeDeps)).rejects.toThrow("runner died");
    expect(authDir).toBeDefined();
    expect(fs.existsSync(authDir as string)).toBe(false);
  });

  test("signal cleanup is registered for the run and removed after", async () => {
    const before = process.listenerCount("SIGINT");
    const beforeTerm = process.listenerCount("SIGTERM");
    let during = -1;
    const probeDeps = deps((args) => {
      during = process.listenerCount("SIGINT");
      return healthyReply(args);
    });
    await runProbe(INPUT, probeDeps);
    expect(during).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBe(before);
    expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
  });
});

describe("a local fault is raised rather than reported as a verdict", () => {
  // The doctor handler maps the raised error to exit 69, pinned in
  // exitBoundaryMapping.test.ts.
  test("a work directory that cannot be created stops the run with no report", async () => {
    const before = process.listenerCount("SIGINT");
    const mkdtemp = vi.spyOn(fs, "mkdtempSync").mockImplementation(() => {
      throw Object.assign(new Error("no temporary directory"), {
        code: "ENOENT",
      });
    });
    try {
      const probeDeps = deps(healthyReply);
      await expect(runProbe(INPUT, probeDeps)).rejects.toThrow(
        "no temporary directory",
      );
      expect(probeDeps.calls.map((call) => call.args)).toEqual([["--version"]]);
      expect(process.listenerCount("SIGINT")).toBe(before);
    } finally {
      mkdtemp.mockRestore();
    }
  });
});

describe("an interrupt sweeps the share before it re-raises", () => {
  const RESULT: CommandResult = { code: 0, output: "", timedOut: false };

  /**
   * The listeners registered since `before` was taken. The probe registers
   * each of its listeners for both signals, so reading one list finds them.
   */
  function addedListeners(
    before: Set<unknown>,
  ): ((signal: NodeJS.Signals) => void)[] {
    return (
      process.listeners("SIGINT") as ((signal: NodeJS.Signals) => void)[]
    ).filter((l) => !before.has(l));
  }

  /**
   * A runner answering like a healthy share whose share list, subdirectory
   * listing, and put of the probe file each settle on the next turn after
   * `during` runs, so a signal delivered there arrives while that command is
   * still in flight; the delete of the probe file settles a turn late as well.
   * Each landing records whether the credentials file was still there when the
   * command finished.
   */
  function interruptingRunner(
    events: string[],
    during: {
      list?: () => void;
      subdirectory?: () => void;
      put?: () => void;
    },
  ): { runner: CommandRunner; authDir: () => string | undefined } {
    let authDir: string | undefined;
    const settleAfter = (
      hook: (() => void) | undefined,
      landed: string,
      args: string[],
    ): Promise<CommandResult> =>
      new Promise((resolve) =>
        setImmediate(() => {
          hook?.();
          setImmediate(() => {
            events.push(landed);
            const authPath = authPathOf(args);
            if (authPath !== undefined && fs.existsSync(authPath))
              events.push(`${landed} with credentials`);
            resolve({ ...RESULT, ...healthyReply(args) });
          });
        }),
      );
    return {
      authDir: () => authDir,
      runner: {
        run(_file, args): Promise<CommandResult> {
          const authPath = authPathOf(args);
          if (authPath !== undefined) authDir = path.dirname(authPath);
          if (args.includes("-L")) {
            events.push("list");
            return settleAfter(during.list, "list landed", args);
          }
          const command = commandOf(args) ?? "";
          events.push(command);
          if (command === "ls" && args.includes("-D"))
            return settleAfter(
              during.subdirectory,
              "subdirectory landed",
              args,
            );
          if (command === "put alcove-probe-abc123.tmp alcove-probe-abc123.tmp")
            return settleAfter(during.put, "put landed", args);
          if (command === "del alcove-probe-abc123.tmp")
            return settleAfter(undefined, "del landed", args);
          return Promise.resolve({ ...RESULT, ...healthyReply(args) });
        },
      },
    };
  }

  test.each([
    ["the share list", "list", "list landed"],
    ["the subdirectory listing", "subdirectory", "subdirectory landed"],
  ] as const)(
    "an interrupt during %s removes the credentials file only once it finishes",
    async (_name, stage, landed) => {
      const before = new Set<unknown>(process.listeners("SIGINT"));
      const events: string[] = [];
      const kill = vi
        .spyOn(process, "kill")
        .mockImplementation((_pid, signal) => {
          events.push(`kill ${String(signal)}`);
          return true;
        });
      try {
        const { runner, authDir } = interruptingRunner(events, {
          [stage]: () => {
            for (const listener of addedListeners(before)) listener("SIGINT");
          },
        });
        await expect(
          runProbe(INPUT, deps(healthyReply, { runner })),
        ).rejects.toThrow("interrupted");
        await vi.waitFor(() => expect(events).toContain("kill SIGINT"));

        expect(events).toContain(`${landed} with credentials`);
        expect(events.indexOf("kill SIGINT")).toBeGreaterThan(
          events.indexOf(landed),
        );
        expect(events.some((event) => event.startsWith("put "))).toBe(false);
        expect(fs.existsSync(authDir() as string)).toBe(false);
        expect(addedListeners(before)).toEqual([]);
      } finally {
        kill.mockRestore();
      }
    },
  );

  test("an interrupt during the put deletes the probe file once the put lands", async () => {
    const before = new Set<unknown>(process.listeners("SIGINT"));
    const beforeTerm = process.listenerCount("SIGTERM");
    const events: string[] = [];
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid, signal) => {
        events.push(`kill ${String(signal)}`);
        return true;
      });
    try {
      const { runner, authDir } = interruptingRunner(events, {
        put: () => {
          for (const listener of addedListeners(before)) listener("SIGINT");
        },
      });
      await expect(
        runProbe(INPUT, deps(healthyReply, { runner })),
      ).rejects.toThrow("interrupted");
      await vi.waitFor(() => expect(events).toContain("kill SIGINT"));

      const del = events.indexOf("del alcove-probe-abc123.tmp");
      expect(del).toBeGreaterThan(events.indexOf("put landed"));
      expect(events.indexOf("kill SIGINT")).toBeGreaterThan(
        events.indexOf("del landed"),
      );
      expect(events.some((event) => event.startsWith("rename "))).toBe(false);
      expect(fs.existsSync(authDir() as string)).toBe(false);
      expect(addedListeners(before)).toEqual([]);
      expect(process.listenerCount("SIGTERM")).toBe(beforeTerm);
    } finally {
      kill.mockRestore();
    }
  });
});

describe("a failing listing keeps the operator's filenames out of the output", () => {
  // A listing the wait cut short: entries streamed before the kill, the last
  // one partial, and no free-space trailer.
  const TRUNCATED_LISTING = [
    "  .                                   D        0  Mon Jan  1 00:00:00 2024",
    "  ..                                  D        0  Mon Jan  1 00:00:00 2024",
    "  secret-client-list.csv              A      100  Mon Jan  1 00:00:00 2024",
    "  q3-payroll-na",
  ].join("\n");

  function timedOutListing(output: string) {
    return deps((args) =>
      commandOf(args) === "ls" && args.includes("-D")
        ? { code: null, output, timedOut: true }
        : healthyReply(args),
    );
  }

  test("a timed-out subdirectory listing prints no entry in the human verdict", async () => {
    const report = await runProbe(INPUT, timedOutListing(TRUNCATED_LISTING));
    const check = checkById(report, "subdirectory");
    expect(check.status).toBe("fail");
    expect(check.summary).toContain("stopped responding");
    const rendered = verdictLines(report).join("\n");
    expect(rendered).not.toContain("secret-client-list");
    expect(rendered).not.toContain("q3-payroll");
  });

  test("the JSON verdict is the same as for a listing that printed nothing", async () => {
    const withEntries = await runProbe(
      INPUT,
      timedOutListing(TRUNCATED_LISTING),
    );
    const empty = await runProbe(INPUT, timedOutListing(""));
    expect(verdictJson(withEntries)).toBe(verdictJson(empty));
  });

  test("smbclient's own lines stay in the excerpt", () => {
    expect(
      withoutListingEntries(
        `${TRUNCATED_LISTING}\nNT_STATUS_IO_TIMEOUT listing \\dropbox\\*`,
      ),
    ).toBe("NT_STATUS_IO_TIMEOUT listing \\dropbox\\*");
  });
});
