import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import YAML from "yaml";
import type { ConnectionConfig } from "@psilink/core";

// The exchange is the only thing standing in here: runProtocol is mocked so the
// handshake "succeeds" -- its post-handshake hook is what writes the config --
// with no connection opened. Everything between the argv and the file on disk is
// real, which is the point: the accept budget reaches that file, if it reaches
// it at all, through the connection the command builds and the bootstrap
// persists, so an assertion on either one alone could pass while the file still
// carried it.
vi.mock("../../src/protocol", () => ({ runProtocol: vi.fn() }));

import { handler as inviteHandler } from "../../src/commands/invite";
import { runProtocol } from "../../src/protocol";
import { DEFAULT_ACCEPT_TIMEOUT_SECONDS } from "../../src/onlineBootstrap";
import { captureStdio } from "../loggingTestSupport";

const tmpDirs: string[] = [];
afterEach(() => {
  vi.mocked(runProtocol).mockReset();
  for (const d of tmpDirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** Locate runProtocol's onAuthenticated hook by type rather than position, so a
 *  later signature change fails loudly instead of invoking the wrong argument. */
function soleFunctionArg(callArgs: unknown[]): () => void | Promise<void> {
  const fnArgs = callArgs.filter((a) => typeof a === "function");
  expect(fnArgs).toHaveLength(1);
  return fnArgs[0] as () => void | Promise<void>;
}

/**
 * Drive one online `psilink invite` to completion against the mocked exchange,
 * returning the configuration it wrote (raw, as YAML.parse yields it -- NOT
 * through the schema, which materializes its own option defaults and would
 * report a field the command never wrote) and the connection the run itself was
 * conducted over.
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
    await soleFunctionArg(callArgs)();
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

  return {
    saved: YAML.parse(fs.readFileSync(configFile, "utf8")) as Record<
      string,
      unknown
    >,
    ran: vi.mocked(runProtocol).mock.lastCall?.[0] as ConnectionConfig,
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
  // Same claim on the channel whose connection block carries nothing but the
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
