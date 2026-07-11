import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";
import { UsageError } from "@psilink/core";
import type { ConnectionConfig, PresentedHostKey } from "@psilink/core";

import {
  establishHostKeyTrust,
  type HostKeyTrustDeps,
} from "../../src/hostKeyTrust";
import { applyConnectionOverrides } from "../../src/config";
import { connectionOverridesFrom } from "../../src/optionDefinitions";

// establishHostKeyTrust gates the interactive prompt on stdin being a TTY. The
// tests drive that flag deterministically and restore it afterward; the
// non-interactive default (isTTY undefined) is what an automated run sees.
const originalIsTTY = process.stdin.isTTY;
afterEach(() => {
  process.stdin.isTTY = originalIsTTY;
});

const FP = "SHA256:" + "A".repeat(43);

function sftpConn(pin?: string | string[]): ConnectionConfig {
  return {
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      ...(pin !== undefined ? { hostKeyFingerprint: pin } : {}),
    },
  };
}

// Injectable probe/confirm so the prompt glue is exercised without a live server
// or a real TTY read. Records whether each was called.
function makeDeps(opts: {
  confirm: boolean;
  keyType?: string;
}): HostKeyTrustDeps & { probeCalls: number; confirmCalls: number } {
  const state = { probeCalls: 0, confirmCalls: 0 };
  return {
    probe: (): Promise<PresentedHostKey> => {
      state.probeCalls++;
      return Promise.resolve({
        fingerprint: FP,
        keyType: opts.keyType ?? "ssh-ed25519",
      });
    },
    confirm: (): Promise<boolean> => {
      state.confirmCalls++;
      return Promise.resolve(opts.confirm);
    },
    get probeCalls() {
      return state.probeCalls;
    },
    get confirmCalls() {
      return state.confirmCalls;
    },
  };
}

test("is a no-op for a non-sftp channel (no host key to establish)", async () => {
  const conn: ConnectionConfig = { channel: "filedrop", path: "/mnt/share" };
  const deps = makeDeps({ confirm: true });
  process.stdin.isTTY = false; // even non-interactively, a no-op resolves
  await expect(
    establishHostKeyTrust(
      conn,
      {
        verbosity: 0,
        loggerName: "exchange",
        persistence: { mode: "ephemeral" },
      },
      deps,
    ),
  ).resolves.toBeUndefined();
  expect(deps.probeCalls).toBe(0);
});

test("is a no-op when a host_key_fingerprint is already pinned", async () => {
  const conn = sftpConn(FP);
  const deps = makeDeps({ confirm: true });
  process.stdin.isTTY = false;
  await establishHostKeyTrust(
    conn,
    {
      verbosity: 0,
      loggerName: "accept",
      persistence: { mode: "save-with-config", configPath: "psilink.yaml" },
    },
    deps,
  );
  expect(deps.probeCalls).toBe(0); // pinned -> never probes or prompts
});

test("is a no-op when a list of host_key_fingerprints is already pinned", async () => {
  // First-use trust gates on the pin being unset (=== undefined), which is
  // value-agnostic: a config already carrying multiple pins (a staged rotation)
  // is just as "pinned" as one carrying a single string and must not re-prompt.
  const conn = sftpConn([FP, "SHA256:" + "B".repeat(42) + "A"]);
  const deps = makeDeps({ confirm: true });
  process.stdin.isTTY = false;
  await establishHostKeyTrust(
    conn,
    {
      verbosity: 0,
      loggerName: "accept",
      persistence: { mode: "save-with-config", configPath: "psilink.yaml" },
    },
    deps,
  );
  expect(deps.probeCalls).toBe(0); // already pinned -> never probes or prompts
  // The pre-existing list is left untouched (not flattened or replaced).
  if (conn.channel === "sftp")
    expect(conn.server.hostKeyFingerprint).toEqual([
      FP,
      "SHA256:" + "B".repeat(42) + "A",
    ]);
});

// --- pre-pinning via --server-host-key-fingerprint ---------------------------
// Drives the same pipeline the exchange/zero-setup/online invite-accept handlers
// use: connectionOverridesFrom fans the parsed flag into the server override
// block, applyConnectionOverrides merges (and schema-validates) it into the
// connection BEFORE establishHostKeyTrust runs -- so these tests exercise the
// real flag-to-trust path, not just the no-op check in isolation.

test("a pre-pinned TTY-less run completes with no prompt (acceptance criterion)", async () => {
  const base = sftpConn(); // no pin in the base config/URL-derived connection
  const overrides = connectionOverridesFrom({
    connectionTimeout: undefined,
    peerTimeout: undefined,
    pollingFrequencyMs: undefined,
    maxReconnectAttempts: undefined,
    serverUsername: undefined,
    serverPassword: undefined,
    serverPrivateKey: undefined,
    serverPrivateKeyPassphrase: undefined,
    serverKeyboardInteractive: undefined,
    serverHostKeyFingerprint: FP, // as if parsed from --server-host-key-fingerprint
    serverPort: undefined,
    locklessRendezvous: undefined,
    peerId: undefined,
    timestampInFilename: undefined,
    retainFiles: undefined,
    outboundPath: undefined,
  });
  const conn = applyConnectionOverrides(base, overrides);
  const deps = makeDeps({ confirm: true });
  process.stdin.isTTY = false; // a supervised, TTY-less run
  await expect(
    establishHostKeyTrust(
      conn,
      {
        verbosity: 0,
        loggerName: "exchange",
        persistence: { mode: "ephemeral" },
      },
      deps,
    ),
  ).resolves.toBeUndefined();
  // No prompt: neither the probe nor the confirm callback ran.
  expect(deps.probeCalls).toBe(0);
  expect(deps.confirmCalls).toBe(0);
  if (conn.channel === "sftp") expect(conn.server.hostKeyFingerprint).toBe(FP);
});

test("a wrong pre-pin is still what reaches the connection for verification (fails closed downstream)", async () => {
  // establishHostKeyTrust's job ends at wiring the pin into the connection and
  // skipping the prompt; the mismatch check itself lives in core's open() (see
  // fileSyncConnection.ts) and is exercised there, not here. This test proves
  // the CLI plumbing hands a WRONG pre-pin through unmodified -- exactly the
  // value a stored (config-file) pin would carry -- so it reaches the identical
  // core verification path rather than being silently accepted or altered.
  const wrong = "SHA256:" + "C".repeat(42) + "A";
  const base = sftpConn();
  const overrides = connectionOverridesFrom({
    connectionTimeout: undefined,
    peerTimeout: undefined,
    pollingFrequencyMs: undefined,
    maxReconnectAttempts: undefined,
    serverUsername: undefined,
    serverPassword: undefined,
    serverPrivateKey: undefined,
    serverPrivateKeyPassphrase: undefined,
    serverKeyboardInteractive: undefined,
    serverHostKeyFingerprint: wrong,
    serverPort: undefined,
    locklessRendezvous: undefined,
    peerId: undefined,
    timestampInFilename: undefined,
    retainFiles: undefined,
    outboundPath: undefined,
  });
  const conn = applyConnectionOverrides(base, overrides);
  const deps = makeDeps({ confirm: true });
  process.stdin.isTTY = false;
  await establishHostKeyTrust(
    conn,
    {
      verbosity: 0,
      loggerName: "exchange",
      persistence: { mode: "ephemeral" },
    },
    deps,
  );
  expect(deps.probeCalls).toBe(0); // pre-pinned -> establishHostKeyTrust still no-ops
  if (conn.channel === "sftp")
    // The wrong value is exactly what a live open() would verify against the
    // server's actual presented key and reject -- establishHostKeyTrust neither
    // detects nor launders it.
    expect(conn.server.hostKeyFingerprint).toBe(wrong);
});

test("a malformed --server-host-key-fingerprint value never reaches the trust path (rejected at parse time)", () => {
  // Constraint #4: a malformed fingerprint is a UsageError at CLI parse
  // (hostKeyFingerprintFlag), before applyConnectionOverrides or
  // establishHostKeyTrust ever run -- so it cannot reach this file's no-op
  // check with a value that would only fail later, confusingly, at verification.
  expect(() =>
    applyConnectionOverrides(sftpConn(), {
      server: { hostKeyFingerprint: "not-a-fingerprint" },
    }),
  ).toThrow(UsageError);
});

test("fails closed on a non-interactive unpinned run (save-with-config), naming the recovery", async () => {
  const conn = sftpConn();
  const deps = makeDeps({ confirm: true });
  process.stdin.isTTY = false;
  const run = establishHostKeyTrust(
    conn,
    {
      verbosity: 0,
      loggerName: "accept",
      persistence: {
        mode: "save-with-config",
        configPath: "/etc/psilink.yaml",
      },
    },
    deps,
  );
  await expect(run).rejects.toBeInstanceOf(UsageError);
  await expect(run).rejects.toThrow(/interactive/i);
  await expect(run).rejects.toThrow(/host_key_fingerprint/);
  await expect(run).rejects.toThrow(/\/etc\/psilink\.yaml/);
  expect(deps.probeCalls).toBe(0); // never probes or auto-accepts
  if (conn.channel === "sftp")
    expect(conn.server.hostKeyFingerprint).toBeUndefined();
});

test("fails closed on a non-interactive unpinned ephemeral run, with the out-of-band recovery", async () => {
  const conn = sftpConn();
  const deps = makeDeps({ confirm: true });
  process.stdin.isTTY = false;
  const run = establishHostKeyTrust(
    conn,
    { verbosity: 0, loggerName: "psilink", persistence: { mode: "ephemeral" } },
    deps,
  );
  await expect(run).rejects.toBeInstanceOf(UsageError);
  await expect(run).rejects.toThrow(/interactive/i);
  // No config path to name; it points at pinning out-of-band in a saved config.
  await expect(run).rejects.toThrow(/out-of-band|saved configuration/i);
  expect(deps.probeCalls).toBe(0);
});

test("interactive confirm (save-with-config) pins in memory and writes no file", async () => {
  const conn = sftpConn();
  const deps = makeDeps({ confirm: true });
  process.stdin.isTTY = true;
  await establishHostKeyTrust(
    conn,
    {
      verbosity: -1,
      loggerName: "accept",
      // configPath points at a path that does NOT exist: save-with-config must
      // not write it (the caller's saveConfig persists the mutation later).
      persistence: {
        mode: "save-with-config",
        configPath: "/nonexistent/psilink.yaml",
      },
    },
    deps,
  );
  expect(deps.probeCalls).toBe(1);
  expect(deps.confirmCalls).toBe(1);
  // The in-memory connection now carries the confirmed pin (so open() enforces).
  if (conn.channel === "sftp") expect(conn.server.hostKeyFingerprint).toBe(FP);
});

test("interactive confirm (write-now) pins in memory and writes the config in place", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-hkt-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    fs.writeFileSync(
      configPath,
      "connection:\n  channel: sftp\n  server:\n    host: sftp.example.org\n",
    );
    const conn = sftpConn();
    const deps = makeDeps({ confirm: true });
    process.stdin.isTTY = true;
    await establishHostKeyTrust(
      conn,
      {
        verbosity: -1,
        loggerName: "exchange",
        persistence: { mode: "write-now", configPath },
      },
      deps,
    );
    if (conn.channel === "sftp")
      expect(conn.server.hostKeyFingerprint).toBe(FP);
    expect(fs.readFileSync(configPath, "utf8")).toContain(FP);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("declining the prompt aborts and leaves the connection unpinned", async () => {
  const conn = sftpConn();
  const deps = makeDeps({ confirm: false });
  process.stdin.isTTY = true;
  await expect(
    establishHostKeyTrust(
      conn,
      {
        verbosity: -1,
        loggerName: "exchange",
        persistence: { mode: "ephemeral" },
      },
      deps,
    ),
  ).rejects.toThrow(/not trusted/);
  if (conn.channel === "sftp")
    expect(conn.server.hostKeyFingerprint).toBeUndefined();
});

test("escapes a control-laden key type in the prompt path (no throw)", async () => {
  // A hostile keyType must not break the flow; sanitizeForDisplay handles it in
  // the warn message. Confirming still pins the (safe, base64) fingerprint.
  const conn = sftpConn();
  const deps = makeDeps({ confirm: true, keyType: "ssh-\x1b[31mevil" });
  process.stdin.isTTY = true;
  await establishHostKeyTrust(
    conn,
    {
      verbosity: -1,
      loggerName: "psilink",
      persistence: { mode: "ephemeral" },
    },
    deps,
  );
  if (conn.channel === "sftp") expect(conn.server.hostKeyFingerprint).toBe(FP);
});
