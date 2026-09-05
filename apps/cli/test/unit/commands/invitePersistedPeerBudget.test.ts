import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import YAML from "yaml";
import type { ConnectionConfig } from "@psilink/core";

// Only runProtocol is mocked: the handshake "succeeds" through its
// post-handshake and post-exchange hooks, with no connection opened.
// Everything from argv to the file on disk is real, so the accept budget
// reaches the file only through the connection the command builds and the
// bootstrap writes twice -- asserting on just one write could miss a stale
// value left by the other.
vi.mock("../../../src/protocol", () => ({ runProtocol: vi.fn() }));

import { handler as inviteHandler } from "../../../src/commands/invite";
import { runProtocol } from "../../../src/protocol";
import type { RunProtocolOptions } from "../../../src/protocol";
import { DEFAULT_ACCEPT_TIMEOUT_SECONDS } from "../../../src/onlineBootstrap";
import { captureStdio } from "../../loggingTestSupport";

const tmpDirs: string[] = [];
afterEach(() => {
  vi.mocked(runProtocol).mockReset();
  for (const d of tmpDirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** The options object a mocked runProtocol call received. */
function optionsArg(callArgs: unknown[]): RunProtocolOptions {
  return callArgs[0] as RunProtocolOptions;
}

/** runProtocol's onAuthenticated hook, which the bootstrap always supplies. */
function onAuthenticatedArg(callArgs: unknown[]): () => void | Promise<void> {
  const hook = optionsArg(callArgs).onAuthenticated;
  expect(hook).toBeTypeOf("function");
  return hook as () => void | Promise<void>;
}

/** The runtime object's onOutputComplete hook. It drives the bootstrap's SECOND
 *  config write -- the post-exchange rewrite that re-serializes the whole
 *  connection block -- which is where a mutation of the persisted connection
 *  would show. */
function outputCompleteHook(
  callArgs: unknown[],
): (result: {
  observedReceivedPayloadColumns: string[];
}) => void | Promise<void> {
  const hook = optionsArg(callArgs).fileSyncRuntime?.onOutputComplete;
  expect(hook).toBeTypeOf("function");
  return hook as (result: {
    observedReceivedPayloadColumns: string[];
  }) => void | Promise<void>;
}

/** A received-payload set for the mocked exchange to have observed, so the
 *  post-exchange rewrite is reached: it is skipped on an empty observation. */
const OBSERVED_RECEIVED_COLUMNS = ["notes"];

/**
 * Drive one online `psilink invite` to completion against the mocked exchange,
 * returning the FINAL configuration on disk (raw, as YAML.parse yields it --
 * not through the schema, which would fill in defaults the command never
 * wrote) and the connection the run itself was conducted over. Both of the
 * bootstrap's writes are driven, since only the second reflects a later
 * mutation of the persisted connection.
 */
async function inviteOnline(
  url: string,
  extraArgv: Record<string, unknown> = {},
): Promise<{ saved: Record<string, unknown>; ran: ConnectionConfig }> {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-budget-"));
  tmpDirs.push(dir);
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  const configFile = path.join(dir, "psilink.yaml");
  vi.mocked(runProtocol).mockImplementation((async (...callArgs: unknown[]) => {
    await onAuthenticatedArg(callArgs)();
    await outputCompleteHook(callArgs)({
      observedReceivedPayloadColumns: OBSERVED_RECEIVED_COLUMNS,
    });
    return {};
  }) as never);

  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  const stdio = captureStdio();
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      identity: "Agency A",
      args: [url, input],
      "config-file": configFile,
      "key-file": path.join(dir, ".psilink.key"),
      "log-level": "silent",
      record: false,
      ...extraArgv,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalled();
  } finally {
    stdio.restore();
    exit.mockRestore();
  }

  const saved = YAML.parse(fs.readFileSync(configFile, "utf8")) as Record<
    string,
    unknown
  >;
  // The observed set the rewrite exists to record, which only the second write
  // could have put there: what every assertion below reads is therefore the
  // re-serialized configuration, not the acceptance hook's first draft.
  expect(saved["expected_payload_columns"]).toEqual(OBSERVED_RECEIVED_COLUMNS);
  return {
    saved,
    ran: vi.mocked(runProtocol).mock.lastCall?.[0]
      .connection as ConnectionConfig,
  };
}

/** The `connection.options` block of a written configuration, as written. */
function savedConnectionOptions(
  saved: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const connection = saved["connection"] as Record<string, unknown>;
  return connection["options"] as Record<string, unknown> | undefined;
}

test("an online file-sync invite writes no peer_timeout_ms from its accept wait", async () => {
  // The accept timeout is a window for one operator waiting at a terminal; the
  // configuration this invite leaves behind is what every later unattended
  // `psilink exchange` runs on. Written as that config's peer budget, the
  // 15-minute default would silently become the peer budget of runs nobody
  // chose it for, so the field is absent and those runs take the documented
  // default instead.
  const { saved, ran } = await inviteOnline(
    `file://${path.join(tmpdir(), "psilink-invite-budget-drop")}`,
  );
  expect(savedConnectionOptions(saved)?.["peer_timeout_ms"]).toBeUndefined();
  // The run's own budget is unchanged: the same default accept timeout still
  // bounds the wait this invitation was printed for.
  expect(ran.options?.peerTimeoutMs).toBe(
    DEFAULT_ACCEPT_TIMEOUT_SECONDS * 1000,
  );
});

test("an online webrtc invite writes no peer_timeout_ms from its accept wait", async () => {
  // Same claim on the channel whose connection block holds nothing but the
  // shared timeouts: the accept budget was the whole of its options block, so
  // stripping it must leave no block at all rather than an empty one.
  const { saved, ran } = await inviteOnline("wss://peers.example.org/psi");
  expect(savedConnectionOptions(saved)?.["peer_timeout_ms"]).toBeUndefined();
  expect(ran.options?.peerTimeoutMs).toBe(
    DEFAULT_ACCEPT_TIMEOUT_SECONDS * 1000,
  );
});

test("an online invite writes the operator's own --peer-timeout as the later budget", async () => {
  // The flag the operator DID choose for the recurring runs is written, and is
  // not what this run waited on -- the two timeouts bound different lifetimes,
  // and each reaches exactly one of them.
  const { saved, ran } = await inviteOnline("wss://peers.example.org/psi", {
    "peer-timeout": "60s",
  });
  expect(savedConnectionOptions(saved)?.["peer_timeout_ms"]).toBe(60_000);
  expect(ran.options?.peerTimeoutMs).toBe(
    DEFAULT_ACCEPT_TIMEOUT_SECONDS * 1000,
  );
});
