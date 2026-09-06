import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stopChild } from "../stopChild";

import type { Readable } from "node:stream";

/**
 * Starts the repository's vendored PeerJS broker as a child process, so the
 * CLI's hand-written signaling client can be driven against the real wire
 * instead of a stand-in. A deployed broker is a service of its own, and
 * this exercises the same wiring a provisioned broker runs -- which is also
 * why .github/workflows/cli_build_and_test.yaml filters on that workspace:
 * a change there must re-run this suite.
 *
 * Runs through `tsx`, not plain `node`: the vendored broker uses TypeScript
 * parameter properties, which Node 26's strip-only type support refuses
 * outright, so it needs a transforming loader.
 */

/** What the runner prints once it is listening, and the whole of what its stdout
 * protocol admits (packages/peerjs-broker/src/standalone.ts). */
const READY_PREFIX = "psilink-broker ";
const READY_LINE = new RegExp(`^${READY_PREFIX}(\\d+)\\n$`);

/** Longest to wait for the child to report its port before giving up. */
const START_TIMEOUT_MS = 30_000;

/** How much of an off-protocol stdout to quote back in the failure. */
const STDOUT_EXCERPT_MAX_LENGTH = 512;

/**
 * Whether everything the child has written to stdout so far is still the
 * ready line -- complete, or a leading part of it that a chunk boundary
 * split.
 *
 * The runner's stdout holds one thing, the port this harness reads off it
 * with a single match; diagnostics belong on stderr, since one that reached
 * the wrong stream would put peer-controlled text on a stream a parent
 * parses. Checked here rather than in the web unit suite because vitest
 * intercepts `console` above the streams, which would leave an assertion
 * there vacuous.
 */
function stdoutIsWithinProtocol(stdout: string): boolean {
  if (READY_LINE.test(stdout)) return true;
  if (stdout.length < READY_PREFIX.length)
    return READY_PREFIX.startsWith(stdout);
  return (
    stdout.startsWith(READY_PREFIX) &&
    /^\d*$/.test(stdout.slice(READY_PREFIX.length))
  );
}

function offProtocolStdoutReason(stdout: string): string {
  // Quoted rather than interpolated raw: stdout is the stream under suspicion,
  // so whatever reached it is exactly the text this harness cannot vouch for.
  return (
    "the signaling broker wrote to stdout outside its ready-line protocol: " +
    JSON.stringify(stdout.slice(0, STDOUT_EXCERPT_MAX_LENGTH))
  );
}

/** Longest to wait for a dead child's stdout pipe to drain before reading the
 * verdict off what arrived. */
const STDOUT_DRAIN_TIMEOUT_MS = 1_000;

/**
 * Resolve once `stream` has delivered everything the child wrote. The child's
 * `exit` can beat its last stdout chunk out of the pipe, so a line written just
 * before the kill would otherwise go unread by the very check that exists to
 * catch it. Bounded, so a pipe that never ends stalls no teardown.
 */
function drained(stream: Readable | null): Promise<void> {
  if (stream === null || stream.readableEnded || stream.destroyed)
    return Promise.resolve();
  return new Promise<void>((resolve) => {
    const settle = (): void => resolve();
    setTimeout(settle, STDOUT_DRAIN_TIMEOUT_MS).unref();
    stream.once("end", settle);
    stream.once("close", settle);
    stream.once("error", settle);
  });
}

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const brokerRoot = path.join(repoRoot, "packages/peerjs-broker");
const runner = path.join(brokerRoot, "src/standalone.ts");

/** A running broker, and the handle to stop it. */
export interface BrokerProcess {
  /** Loopback port the broker is listening on. */
  port: number;
  /** URL path the broker is mounted at. */
  path: string;
  /** API key the broker accepts. */
  key: string;
  /** Everything the child has written to stdout so far, which the ready-line
   * protocol holds to the one line above. */
  stdout: () => string;
  /** Everything the child has written to stderr so far, where its diagnostics
   * go. Peer-controlled text reaches it, escaped and capped by the diagnostics
   * sink. */
  stderr: () => string;
  /**
   * Terminate the child and wait for it to exit. Idempotent.
   *
   * Rejects if the child ever wrote to stdout outside its ready-line protocol,
   * so a diagnostic that reached the wrong stream fails the suite that ran the
   * broker rather than passing unread.
   */
  stop: () => Promise<void>;
}

/** What a caller can vary about the spawn, for a suite driving the runner's
 * operator surface rather than the signaling wire. */
export interface BrokerProcessOptions {
  /** Further runner arguments, appended after the mount and key below. */
  args?: ReadonlyArray<string>;
  /** Environment entries added to the child's inherited environment. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Spawn the broker and resolve once it reports its port. Rejects (after killing
 * the child) if it exits first or does not report within
 * {@link START_TIMEOUT_MS}, so a failed start never leaves an orphan.
 */
export function startBrokerProcess(
  options: BrokerProcessOptions = {},
): Promise<BrokerProcess> {
  // The runner's own mount path and API key.
  const mountPath = "/api";
  const key = "peerjs";
  const child = spawn(
    process.execPath,
    [
      require.resolve("tsx/cli"),
      runner,
      "--path",
      mountPath,
      "--key",
      key,
      ...(options.args ?? []),
    ],
    {
      cwd: brokerRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env:
        options.env === undefined
          ? process.env
          : { ...process.env, ...options.env },
    },
  );

  return new Promise<BrokerProcess>((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    /** The whole of stdout as it first went off protocol, held for `stop()`. */
    let offProtocolStdout: string | undefined;

    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      child.removeListener("error", onError);
      action();
    };

    const fail = (reason: string): void =>
      settle(() => {
        stopChild(child);
        // The child's stderr is the only diagnosis a failed start leaves. It can
        // hold peer-derived text (a parse failure quotes the peer's opening
        // bytes), but the diagnostics sink escapes it at a 256-character cap and
        // rate-limits it before it reaches stderr, so showing it verbatim here
        // is still safe.
        reject(
          new Error(
            `${reason}${stderr.trim() === "" ? "" : `\n${stderr.trim()}`}`,
          ),
        );
      });

    const timer = setTimeout(
      () =>
        fail(`the signaling broker did not start within ${START_TIMEOUT_MS}ms`),
      START_TIMEOUT_MS,
    );

    const onExit = (code: number | null): void =>
      fail(`the signaling broker exited with code ${code} before listening`);
    const onError = (err: Error): void =>
      fail(`the signaling broker could not be spawned: ${err.message}`);

    // Kept on past the start, so the protocol is held for the child's whole life
    // rather than up to the ready line: a diagnostic misrouted to stdout arrives
    // once a peer has given the broker something to report, which is long after
    // this promise settles.
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString();
      if (!stdoutIsWithinProtocol(stdout)) {
        offProtocolStdout ??= stdout;
        // Before the ready line this fails the start, which is the only way to
        // report it; after it, `stop()` delivers the same verdict to the suite.
        fail(offProtocolStdoutReason(stdout));
        return;
      }
      const match = READY_LINE.exec(stdout);
      if (match === null) return;
      settle(() =>
        resolve({
          port: Number(match[1]),
          path: mountPath,
          key,
          stdout: () => stdout,
          stderr: () => stderr,
          stop: async () => {
            await stopChild(child);
            await drained(child.stdout);
            if (offProtocolStdout !== undefined)
              throw new Error(offProtocolStdoutReason(offProtocolStdout));
          },
        }),
      );
    });
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });
    child.once("exit", onExit);
    child.once("error", onError);
  });
}
