import { randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { MAX_DIRECTORY_ENTRIES } from "../connection/listingGuard";
import { stripExtendedAcls, writeFileOwnerOnly } from "../fileUtils";
import type { CommandResult, CommandRunner } from "./runner";
import { nodeCommandRunner } from "./runner";
import type { SmbProbeInput } from "./smbEnvironment";
import type { DoctorCheckRecord, DoctorReport } from "./verdict";
import { fail, ok, skipped, warn } from "./verdict";

// The userspace half of the file-drop checks: what the exchange needs, asked of
// the server over TCP with smbclient, with nothing mounted. It answers the
// questions a failed exchange leaves open in the wrong order -- is the name
// resolvable from in here, is 445 reachable, are the credentials accepted, does
// the share open, does the folder open, can a file be created, renamed, and
// deleted -- so an operator is told which one failed instead of "the exchange
// did not work". `doctor mount` is the other half: the same folder as the kernel
// sees it once mounted.

/** Ceiling on one smbclient invocation. */
const SMBCLIENT_TIMEOUT_MS = 30_000;

/** Ceiling on the port-445 reachability probe. */
const TCP_PROBE_TIMEOUT_MS = 8_000;

/** The SMB port an exchange over a file drop is carried on. */
const SMB_PORT = 445;

/** Free space below which the share is worth a note, in MB. */
const LOW_FREE_SPACE_MB = 100;

/**
 * The checks `doctor probe` reports, in order. The list is fixed: a check that
 * did not run is reported as `skipped` rather than omitted, so a consumer can
 * index the verdict by id without discovering which checks a given run happened
 * to reach.
 */
export const PROBE_CHECK_IDS = [
  "name_resolution",
  "tcp_445",
  "smbclient_available",
  "authentication",
  "share_open",
  "subdirectory",
  "free_space",
  "write",
  "rename",
  "delete",
  "marker",
] as const;

/** The external effects the probe performs, injectable for unit tests. */
export interface ProbeDeps {
  runner: CommandRunner;
  /** Resolve `host` to an address, or `undefined` when it does not resolve. */
  lookupHost: (host: string) => Promise<string | undefined>;
  /** Whether a TCP connection to `host:port` completes within `timeoutMs`. */
  connectTcp: (
    host: string,
    port: number,
    timeoutMs: number,
  ) => Promise<boolean>;
}

/** The real effects. */
export const REAL_PROBE_DEPS: ProbeDeps = {
  runner: nodeCommandRunner,
  lookupHost: async (host) => {
    try {
      return (await dns.lookup(host)).address;
    } catch {
      return undefined;
    }
  },
  connectTcp: (host, port, timeoutMs) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const settle = (reachable: boolean): void => {
        socket.destroy();
        resolve(reachable);
      };
      socket.setTimeout(timeoutMs);
      socket.once("connect", () => settle(true));
      socket.once("timeout", () => settle(false));
      socket.once("error", () => settle(false));
    }),
};

const IPV4_LITERAL = /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/;

/**
 * The NT_STATUS token smbclient reported, if any. `NT_STATUS_OK` appears in
 * ordinary successful output and is not one.
 * @internal exported for testing
 */
export function statusOf(output: string): string | undefined {
  const matches = output.match(/NT_STATUS_[A-Z_]+/g) ?? [];
  return matches.find((status) => status !== "NT_STATUS_OK");
}

/**
 * Whether a command died without the server having supplied a verdict. An empty
 * status means "the server said nothing", never "the command succeeded": a
 * transport that dies before the server answers -- a firewall that completes the
 * TCP handshake and then swallows the session, a server wedged mid-negotiation
 * -- carries no NT_STATUS token at all, so scraping alone reads it as success
 * and every later check reports an OK it never established. The exit status is
 * the only evidence the command ran, so both are consulted.
 * @internal exported for testing
 */
export function transportFailed(result: CommandResult): boolean {
  if (result.code === 0) return false;
  return statusOf(result.output) === undefined;
}

/**
 * Free megabytes as reported in an smbclient listing, or `undefined` when the
 * server reported none.
 * @internal exported for testing
 */
export function freeMegabytes(listing: string): number | undefined {
  const match = listing.match(/blocks of size (\d+)\. (\d+) blocks available/);
  if (match === null) return undefined;
  return Math.floor((Number(match[1]) * Number(match[2])) / 1_048_576);
}

/**
 * Entries in a listing, excluding `.` and `..`. A count, deliberately, and not
 * the listing: these are the operator's own filenames on their own share, and
 * the runbook asks them to send this output on to whoever is helping them, who
 * is not a party to their exchange.
 * @internal exported for testing
 */
export function countEntries(listing: string): number {
  return listing
    .split("\n")
    .filter((line) => /^ {2}\S/.test(line))
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((name) => name !== "." && name !== "..").length;
}

/**
 * The subdirectory check over the folder the exchange will run in, carrying the
 * advisory a folder earns when it already holds more entries than the transport
 * will list.
 */
function entryCountCheck(summary: string, entries: number): DoctorCheckRecord {
  if (entries <= MAX_DIRECTORY_ENTRIES) return ok("subdirectory", summary);
  return warn(
    "subdirectory",
    summary,
    `psilink will not read a rendezvous folder holding more than ` +
      `${MAX_DIRECTORY_ENTRIES} entries, so an exchange here will ` +
      "fail however the permissions come out.",
    "use a folder dedicated to the exchange.",
  );
}

/**
 * The dialect arguments for one smbclient invocation. `-m` sets the MAXIMUM
 * protocol only; the client minimum stays where it is, so asking for NT1 with
 * `-m` alone is a contradiction the client rejects out of hand against every
 * server including one that speaks nothing else. The minimum has to move too,
 * and that option name takes spaces, not underscores.
 * @internal exported for testing
 */
export function dialectArgs(dialect: string): string[] {
  if (dialect === "") return [];
  return ["-m", dialect, `--option=client min protocol=${dialect}`];
}

/**
 * Arguments for one smbclient run against the share.
 *
 * The subdirectory is reached with `-D` rather than a `cd` command for the
 * reason the setup script gives: smbclient splits `-c` on semicolons even inside
 * a quoted argument, so a folder legitimately named "q3;final" would be reported
 * missing and a crafted one could append commands of its own.
 */
function shareArgs(
  input: SmbProbeInput,
  authFile: string,
  target: string,
  command: string,
): string[] {
  return [
    `//${input.server}/${input.share}`,
    "-A",
    authFile,
    ...dialectArgs(input.dialect),
    ...(target === "" ? [] : ["-D", target]),
    "-c",
    command,
  ];
}

/** Arguments for the share-list run that answers the authentication question. */
function listArgs(input: SmbProbeInput, authFile: string): string[] {
  return [
    "-L",
    `//${input.server}`,
    "-A",
    authFile,
    ...dialectArgs(input.dialect),
  ];
}

/**
 * Append a `skipped` record for every id the run never reached, so the reported
 * check list is the full ordered set whatever stopped it.
 */
function padSkipped(
  checks: DoctorCheckRecord[],
  ids: readonly string[],
): DoctorCheckRecord[] {
  const seen = new Set(checks.map((check) => check.id));
  return [
    ...checks,
    ...ids
      .filter((id) => !seen.has(id))
      .map((id) =>
        skipped(id, "not run: an earlier check did not pass.", {
          meaning:
            "an earlier check failed and the remaining checks did not run, " +
            "so nothing was established about this one.",
        }),
      ),
  ];
}

/** The transport-failure record shared by every step that can hit one. */
function transportFailureCheck(
  id: string,
  server: string,
  result: CommandResult,
): DoctorCheckRecord {
  return fail(
    id,
    `the connection to ${server} stopped responding.`,
    result.timedOut
      ? "the server accepted the connection and then sent nothing back within " +
          "the time allowed. Nothing about your credentials or your folder has " +
          "been established either way."
      : "smbclient could not finish the request and the server gave no reason " +
          `for it (exit ${String(result.code)}). Nothing about your credentials ` +
          "or your folder has been established either way.",
    "see the troubleshooting page, 'The container cannot reach the server'. A " +
      "firewall or VPN that allows the connection and then drops the traffic " +
      "behaves exactly like this.",
    { detail: result.output },
  );
}

/** Classify an authentication refusal the server named. */
function authenticationCheck(
  status: string,
  result: CommandResult,
): DoctorCheckRecord {
  const detail = { detail: result.output };
  switch (status) {
    case "NT_STATUS_LOGON_FAILURE":
      return fail(
        "authentication",
        status,
        "the username, password, or domain is wrong. This is the one status " +
          "that really does mean bad credentials.",
        "if this is a domain account, set SMB_DOMAIN. If the folder opens in " +
          "File Explorer WITHOUT ever asking for a password, Windows is signing " +
          "you in with Kerberos and there may be no password that works here; " +
          "see the troubleshooting page, 'The share never asks for a password'. " +
          "Do not work through passwords one at a time -- each run is one failed " +
          "sign-in against the account, and a handful of those locks it out.",
        detail,
      );
    case "NT_STATUS_ACCOUNT_LOCKED_OUT":
      return fail(
        "authentication",
        status,
        "the account is locked out, most likely from earlier failed attempts, " +
          "which may now be masking the original cause.",
        "stop retrying. Wait for the lockout to expire or ask IT to unlock, " +
          "then run this once.",
      );
    case "NT_STATUS_PASSWORD_EXPIRED":
    case "NT_STATUS_PASSWORD_MUST_CHANGE":
      return fail(
        "authentication",
        status,
        "the password is expired.",
        "change it in Windows, then run this again.",
      );
    case "NT_STATUS_ACCOUNT_DISABLED":
    case "NT_STATUS_ACCOUNT_EXPIRED":
    case "NT_STATUS_ACCOUNT_RESTRICTION":
    case "NT_STATUS_INVALID_LOGON_HOURS":
    case "NT_STATUS_INVALID_WORKSTATION":
    case "NT_STATUS_PASSWORD_RESTRICTION":
      return fail(
        "authentication",
        status,
        "the account itself is not permitted to sign in -- disabled, expired, " +
          "restricted to certain hours, or restricted to certain machines. The " +
          "password is not the problem and neither are the rights on your folder.",
        "ask whoever issued the account to lift that restriction, or ask for a " +
          "service account instead -- it is item 1 of the IT request on the " +
          "troubleshooting page. Without this, every later check would report " +
          "the same status and blame your folder for it.",
        detail,
      );
    case "NT_STATUS_NOT_SUPPORTED":
    case "NT_STATUS_LOGON_TYPE_NOT_GRANTED":
      return fail(
        "authentication",
        status,
        "the server rejected the authentication METHOD, not the credentials. " +
          "NTLM is probably disabled server-side, or this account is not " +
          "allowed to sign in over the network.",
        "see the troubleshooting page, 'The share never asks for a password'.",
        detail,
      );
    default:
      // Anything else is not decided here. A server that authenticates fine can
      // still refuse the share list -- refusing IPC$ to ordinary accounts is
      // common and reports as ACCESS_DENIED -- and aborting on that sends the
      // operator to ask for rights they already have. Opening the share the
      // exchange will use is the question worth answering.
      return ok("authentication", "the credentials were accepted.", {
        meaning:
          `the server would not list its shares (${status}). That is common ` +
          "and is not a problem by itself -- many servers refuse the list to " +
          "ordinary accounts. Opening your share is the test that counts.",
      });
  }
}

/** Classify a refusal to open the share. */
function shareOpenCheck(
  input: SmbProbeInput,
  status: string,
  result: CommandResult,
): DoctorCheckRecord {
  const detail = { detail: result.output };
  switch (status) {
    case "NT_STATUS_BAD_NETWORK_NAME":
    case "NT_STATUS_OBJECT_NAME_NOT_FOUND":
      return fail(
        "share_open",
        status,
        `there is no share called '${input.share}' on this server.`,
        "the share is the FIRST path component only, not the whole folder " +
          "path: in \\\\server\\exchange\\dropbox the share is 'exchange' and " +
          "'dropbox' is the subfolder, which belongs in SMB_PATH.",
        detail,
      );
    case "NT_STATUS_PATH_NOT_COVERED":
      return fail(
        "share_open",
        status,
        "the server is telling us outright that this path is a DFS link -- it " +
          "does not hold the data itself and expects the client to follow a " +
          "referral to whichever server does. This container cannot follow " +
          "one; it has no DFS client.",
        "find the real server by hand and pass it directly: open the folder in " +
          "File Explorer, right-click, Properties, DFS tab, and read the " +
          "referral. See the troubleshooting page, 'Reading the real path from " +
          "Windows'.",
      );
    case "NT_STATUS_NOT_A_DIRECTORY":
      return fail(
        "share_open",
        status,
        `'${input.share}' names a file rather than a share or folder.`,
        "give the folder the exchange runs in, not a file inside it.",
      );
    default:
      if (input.subdirectory !== "")
        // The ordinary shape of an agency grant is rights to your own folder
        // and nothing above it. Listing the share root is not something psilink
        // needs, so a refusal here decides nothing.
        return ok("share_open", "the share root would not list.", {
          meaning:
            `the share root would not list (${status}). That is usual when you ` +
            "have been granted rights to your own folder rather than to the " +
            "whole share, and it does not stop anything.",
        });
      return fail(
        "share_open",
        status,
        "the credentials were accepted and access to the share was then " +
          "refused. This is not a wrong password.",
        "the account probably lacks rights when connecting from a machine that " +
          "is not domain-joined, or the server requires Kerberos. See the " +
          "troubleshooting page, 'The password works but access is refused'.",
        detail,
      );
  }
}

/** Classify a refusal to open the subdirectory. */
function subdirectoryCheck(
  input: SmbProbeInput,
  status: string,
  result: CommandResult,
): DoctorCheckRecord {
  const [meaning, action] =
    status === "NT_STATUS_OBJECT_NAME_NOT_FOUND" ||
    status === "NT_STATUS_OBJECT_PATH_NOT_FOUND"
      ? [
          "the share is fine but this subfolder does not exist.",
          "check the spelling, or create it in File Explorer first.",
        ]
      : status === "NT_STATUS_NOT_A_DIRECTORY"
        ? [
            `'${input.subdirectory}' names a file, not a folder.`,
            "give the folder the exchange runs in, not a file in it.",
          ]
        : status === "NT_STATUS_PATH_NOT_COVERED"
          ? [
              "this subfolder is a DFS link pointing at another server, and " +
                "this container has no DFS client to follow it.",
              "read the real path from the folder's Properties, DFS tab and " +
                "pass it as SMB_SERVER, SMB_SHARE and SMB_PATH. See the " +
                "troubleshooting page, 'Reading the real path from Windows'.",
            ]
          : [
              "the subfolder exists but this account cannot open it.",
              "access to a share does not imply access to every folder in it. " +
                "Ask for rights on this folder specifically.",
            ];
  return fail("subdirectory", status, meaning, action, {
    detail: result.output,
  });
}

/** Read the free-space verdict off whichever listing the run ended up with. */
function freeSpaceCheck(listing: string): DoctorCheckRecord {
  const freeMb = freeMegabytes(listing);
  if (freeMb === undefined)
    return skipped("free_space", "the server did not report free space.", {
      meaning:
        "the listing had no free-space figure, so nothing was " +
        "established about it.",
    });
  if (freeMb === 0)
    return warn(
      "free_space",
      "the share reports no free space.",
      "a tiny test file still fits in slack, so these checks can pass while " +
        "a real exchange fails partway through.",
      "ask for quota on this share before running an exchange.",
    );
  const summary = `${freeMb} MB free on this share.`;
  if (freeMb < LOW_FREE_SPACE_MB)
    return warn(
      "free_space",
      summary,
      "that is little enough that a large exchange could exhaust it.",
      "ask for more quota if your input files are large.",
    );
  return ok("free_space", summary);
}

/**
 * Run the userspace SMB battery and report a verdict. Performs no mount and
 * changes nothing on the share except the probe files it creates and removes,
 * plus the marker it deliberately leaves behind for a later `doctor mount` to
 * find.
 */
export async function runProbe(
  input: SmbProbeInput,
  deps: ProbeDeps = REAL_PROBE_DEPS,
): Promise<DoctorReport> {
  const checks: DoctorCheckRecord[] = [];
  const finish = (): DoctorReport => ({
    mode: "probe",
    checks: padSkipped(checks, PROBE_CHECK_IDS),
  });

  if (IPV4_LITERAL.test(input.server)) {
    checks.push(
      ok("name_resolution", `${input.server} is a literal IP address.`),
    );
  } else {
    const address = await deps.lookupHost(input.server);
    if (address === undefined) {
      checks.push(
        fail(
          "name_resolution",
          `cannot resolve '${input.server}'.`,
          "this container runs its own resolver. It does not inherit Windows' " +
            "DNS suffix search list and has no NetBIOS name resolution, so a " +
            "short server name that works in File Explorer often fails here.",
          `on Windows, run Resolve-DnsName ${input.server} and use the full ` +
            "name or the address it prints. See the troubleshooting page, " +
            "'The container cannot find the server'.",
        ),
      );
      return finish();
    }
    checks.push(ok("name_resolution", `resolved to ${address}.`));
  }

  if (!(await deps.connectTcp(input.server, SMB_PORT, TCP_PROBE_TIMEOUT_MS))) {
    checks.push(
      fail(
        "tcp_445",
        `cannot reach ${input.server}:${SMB_PORT}.`,
        "this container reaches the network through its runtime's address " +
          "translation, so to the file server it looks like a different " +
          "machine than Windows does. A VPN that routes only the Windows side, " +
          "a host firewall rule, or a server-side address restriction blocks it " +
          "while File Explorer keeps working.",
        "if you are on a VPN, that is the likely cause. See the troubleshooting " +
          "page, 'The container cannot reach the server'.",
      ),
    );
    return finish();
  }
  checks.push(ok("tcp_445", `port ${SMB_PORT} is open.`));

  const version = await deps.runner.run("smbclient", ["--version"], {
    timeoutMs: SMBCLIENT_TIMEOUT_MS,
  });
  if (version.spawnErrorCode === "ENOENT") {
    // Distinguished from the verdict failures because it is not one: the checks
    // below could not run at all, so nothing has been established about the
    // credentials, the share, the folder, or write access.
    checks.push(
      fail(
        "smbclient_available",
        "smbclient is not in the image these checks are running in.",
        "this copy of the psilink image predates the checks. Nothing has been " +
          "established about the credentials, the share, the folder, or write " +
          "access; the name and reachability checks above stand.",
        "pull a current psilink image and run this again.",
        { blocksRun: true },
      ),
    );
    return finish();
  }
  checks.push(ok("smbclient_available", "smbclient is present."));

  // The credentials file is the delivery channel for the password: an argv value
  // is readable by every process on the machine, and an environment variable by
  // anything that can read /proc. It is created inside an owner-only directory
  // and removed on every exit path below. The password lands under the same
  // write construction every other psilink credential takes: the 0600 mode set
  // on the descriptor before any content, and on macOS the extended ACL cleared
  // first. The directory is the other half of that on macOS: a mkdtemp directory
  // under the operator's TMPDIR inherits an ACE of its own and hands it down to
  // everything created inside, so it is stripped before the credentials file
  // exists -- clearing the ACE on the directory an smbclient run reads through,
  // and leaving none for the file, the write probe, or the marker to inherit. A
  // refused strip or write takes the whole run with it, rather than delivering
  // the password through a directory or a file that could not be secured.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-doctor-"));
  const authFile = path.join(workDir, "auth");
  const lines = [
    `username=${input.username}`,
    `password=${input.password}`,
    ...(input.domain === "" ? [] : [`domain=${input.domain}`]),
  ];
  try {
    stripExtendedAcls(workDir, {
      symlinks: "do-not-follow",
      reportedPath: os.tmpdir(),
    });
    writeFileOwnerOnly(authFile, `${lines.join("\n")}\n`);
  } catch (err) {
    fs.rmSync(workDir, { recursive: true, force: true });
    throw err;
  }

  // Ctrl-C is the likely operator response to the very hang this command
  // exists to diagnose, and it must not leave the credentials file behind.
  // The signal is re-raised after cleanup so the exit still reports it.
  const onSignal = (signal: NodeJS.Signals): void => {
    fs.rmSync(workDir, { recursive: true, force: true });
    process.kill(process.pid, signal);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  // Names this run can leave on the share. The share belongs to someone else and
  // their partner can see it, so anything still there when the run ends -- on a
  // failure, a timeout, or an interrupt -- is swept before returning.
  const litter = new Set<string>();
  let target = "";

  // Every smbclient invocation runs from the work directory so the local side of
  // a `put` is a bare filename: the local path would otherwise be interpolated
  // into the `-c` command string, where a space or a semicolon anywhere in the
  // temporary directory's path would split the command.
  const smb = (command: string): Promise<CommandResult> =>
    deps.runner.run("smbclient", shareArgs(input, authFile, target, command), {
      cwd: workDir,
      timeoutMs: SMBCLIENT_TIMEOUT_MS,
    });

  try {
    const list = await deps.runner.run("smbclient", listArgs(input, authFile), {
      cwd: workDir,
      timeoutMs: SMBCLIENT_TIMEOUT_MS,
    });
    if (transportFailed(list)) {
      checks.push(transportFailureCheck("authentication", input.server, list));
      return finish();
    }
    // Ahead of the status classification on purpose: a server that dies
    // mid-negotiation and one that refuses the dialect both mention
    // negotiation, and only the second carries an NT_STATUS token, so
    // classifying on the token rather than the word keeps a wedged server from
    // being reported as a dialect disagreement.
    if (/protocol negotiation/i.test(list.output)) {
      checks.push(
        fail(
          "authentication",
          "the client and the server could not agree on an SMB dialect.",
          "this is not an authentication problem. The dialect asked for is one " +
            "the server will not speak.",
          "run again with SMB_DIALECT unset to let them negotiate, or with " +
            "SMB_DIALECT=SMB3 if you were told to pin one.",
          { detail: list.output },
        ),
      );
      return finish();
    }
    const listStatus = statusOf(list.output);
    if (listStatus !== undefined) {
      const check = authenticationCheck(listStatus, list);
      checks.push(check);
      if (check.status === "fail") return finish();
    } else if (/Sharename/.test(list.output)) {
      // A derived fact rather than the list itself: this runs against an agency
      // file server, the share names can identify programs and departments, and
      // the operator is asked to send this output to whoever is helping them.
      const listed = list.output
        .split("\n")
        .map((line) => /^\t(\S+)/.exec(line)?.[1])
        .filter((name): name is string => name !== undefined)
        .includes(input.share);
      checks.push(
        listed
          ? ok(
              "authentication",
              `authenticated, and '${input.share}' is one of the shares this ` +
                "account can see.",
            )
          : ok("authentication", "authenticated.", {
              meaning:
                `'${input.share}' is not among the shares this account can ` +
                "see. That does not decide anything -- a share can be reachable " +
                "without being listed. Opening it is the test that counts.",
            }),
      );
    } else {
      checks.push(
        ok("authentication", "the credentials were accepted.", {
          meaning:
            "no share list came back. Opening your share is the test that counts.",
        }),
      );
    }

    let listing = "";
    const shareList = await smb("ls");
    if (transportFailed(shareList)) {
      checks.push(transportFailureCheck("share_open", input.server, shareList));
      return finish();
    }
    const shareStatus = statusOf(shareList.output);
    if (shareStatus === undefined) {
      checks.push(ok("share_open", "share opened."));
      listing = shareList.output;
    } else {
      const check = shareOpenCheck(input, shareStatus, shareList);
      checks.push(check);
      if (check.status === "fail") return finish();
    }

    if (input.subdirectory === "") {
      const entries = countEntries(listing);
      checks.push(
        entryCountCheck(
          `using the share root; ${entries} file(s) in it.`,
          entries,
        ),
      );
    } else {
      const subdirectoryList = await deps.runner.run(
        "smbclient",
        shareArgs(input, authFile, input.subdirectory, "ls"),
        { cwd: workDir, timeoutMs: SMBCLIENT_TIMEOUT_MS },
      );
      if (transportFailed(subdirectoryList)) {
        checks.push(
          transportFailureCheck("subdirectory", input.server, subdirectoryList),
        );
        return finish();
      }
      const subdirectoryStatus = statusOf(subdirectoryList.output);
      if (subdirectoryStatus !== undefined) {
        checks.push(
          subdirectoryCheck(input, subdirectoryStatus, subdirectoryList),
        );
        return finish();
      }
      const entries = countEntries(subdirectoryList.output);
      checks.push(
        entryCountCheck(`directory listed, ${entries} file(s) in it.`, entries),
      );
      target = input.subdirectory;
      listing = subdirectoryList.output;
    }

    checks.push(freeSpaceCheck(listing));

    // Fixed names an earlier run of this setup can have left on the share, swept
    // before the staged test rather than after it. Left in place, one of them
    // makes the rename stage fail and the probe report a read-only share that is
    // nothing of the kind -- a trap that sustains itself once sprung, since the
    // failed run litters again. The sweep is by mask because it has to match what
    // a PREVIOUS run named, which a fixed list cannot do.
    //
    // The marker file is deliberately not swept. It is the one file another
    // operator may be relying on right now, and deleting it turns their mount
    // check into a "wrong folder" verdict that blames their server.
    const stale = await smb("del psilink-probe-*.tmp*");
    const sweptStale = stale.code === 0 && statusOf(stale.output) === undefined;

    // Named from the caller's per-run token, or a random value when it supplied
    // none. Never from the pid, which is not a source of uniqueness here: this
    // runs in a container where it is the same small number on every run on every
    // machine, so two operators setting up the same share would collide and the
    // one who lost the race would be told the share is create-only.
    const suffix =
      input.token === "" ? randomBytes(6).toString("hex") : input.token;
    const probeName = `psilink-probe-${suffix}.tmp`;
    const renamedName = `${probeName}.renamed`;
    fs.writeFileSync(path.join(workDir, probeName), "psilink write probe\n");

    litter.add(probeName);
    const put = await smb(`put ${probeName} ${probeName}`);
    if (transportFailed(put)) {
      checks.push(transportFailureCheck("write", input.server, put));
      return finish();
    }
    const putStatus = statusOf(put.output);
    if (putStatus !== undefined) {
      checks.push(
        fail(
          "write",
          `${putStatus} -- could not create a file.`,
          "this account can read the folder but not write to it.",
          "ask whoever administers the share for write permission on this " +
            "folder. Mount options such as file_mode cannot grant it -- they " +
            "only change how permissions look inside the container, not what " +
            "the server allows.",
          { detail: put.output },
        ),
      );
      return finish();
    }
    checks.push(
      ok(
        "write",
        sweptStale
          ? "created a file (and removed probe files left by an earlier run)."
          : "created a file.",
      ),
    );

    litter.add(renamedName);
    const rename = await smb(`rename ${probeName} ${renamedName}`);
    if (transportFailed(rename)) {
      checks.push(transportFailureCheck("rename", input.server, rename));
      return finish();
    }
    const renameStatus = statusOf(rename.output);
    if (renameStatus !== undefined) {
      checks.push(
        fail(
          "rename",
          `${renameStatus} -- created a file but could not rename it.`,
          "creating files is allowed here and renaming them is not. psilink " +
            "renames every message into place, so this stops an exchange even " +
            "though the folder looks writable.",
          "ask for full change rights on this folder rather than create-only. " +
            "On a Windows share this is usually the DELETE right being " +
            "withheld, which a rename needs.",
          { detail: rename.output },
        ),
      );
      return finish();
    }
    litter.delete(probeName);
    checks.push(ok("rename", "renamed it."));

    const del = await smb(`del ${renamedName}`);
    if (transportFailed(del)) {
      checks.push(transportFailureCheck("delete", input.server, del));
      return finish();
    }
    const deleteStatus = statusOf(del.output);
    if (deleteStatus !== undefined) {
      checks.push(
        fail(
          "delete",
          `${deleteStatus} -- created and renamed a file but could not delete it.`,
          "psilink removes each message once the other side has read it. " +
            "Without delete rights the folder fills up and a second exchange in " +
            "it will not start.",
          "ask for delete rights on this folder. If they cannot be granted, the " +
            "exchange can still be run with --retain-files, but the folder has " +
            "to be emptied by hand between exchanges.",
          { detail: del.output },
        ),
      );
      return finish();
    }
    litter.delete(renamedName);
    checks.push(ok("delete", "deleted it."));

    // Left in place on purpose: these checks reached //server/share with a
    // subpath, while a mount reaches //server/share/subpath, and nothing so far
    // proves those are the same directory. `doctor mount` looks for this file,
    // and its absence means the two halves point at different places -- which is
    // the one way a wrong server or share is caught before an exchange does it.
    if (input.marker === "" || input.token === "") {
      checks.push(
        skipped(
          "marker",
          "no marker was requested, so no cross-check file was left behind.",
          {
            meaning:
              "does not apply to the inputs given: no marker was requested.",
          },
        ),
      );
      return finish();
    }
    fs.writeFileSync(path.join(workDir, input.marker), `${input.token}\n`);
    const marker = await smb(`put ${input.marker} ${input.marker}`);
    checks.push(
      statusOf(marker.output) === undefined && marker.code === 0
        ? ok("marker", `left ${input.marker} for the mount check to find.`)
        : skipped("marker", "could not leave the marker file.", {
            meaning:
              "the check was attempted and could not be completed: a later " +
              "`psilink doctor mount` cannot confirm the mounted folder is " +
              "this one.",
          }),
    );
    return finish();
  } finally {
    try {
      for (const leftover of litter) await smb(`del ${leftover}`);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
    }
  }
}
