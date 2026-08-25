import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import YAML from "yaml";
import {
  getDefaultLinkageTerms,
  MAX_NAME_LENGTH,
  MAX_NESTING_DEPTH,
  NestingDepthExceededError,
  parseExchangeSpec,
  sanitizeErrorForDisplay,
  snakeizeKeys,
  UsageError,
} from "@psilink/core";
import {
  applyConnectionOverrides,
  assertRetainSweepGuard,
  diffLinkageTerms,
  formatReconcileDiffs,
  loadConfigLinkageSource,
  persistDisclosedPayloadColumns,
  persistExpectedPartnerDeduplicate,
  persistExpectedPayloadColumns,
  persistHostKeyFingerprint,
  persistOutboundPayloadConsent,
  readConfigLinkageSource,
  saveConfig,
} from "../../src/config";
import type {
  ConnectionConfig,
  ExchangeSpec,
  FileDropConnectionConfig,
  LinkageTerms,
  SFTPConnectionConfig,
} from "@psilink/core";

const baseSFTP: ConnectionConfig = {
  channel: "sftp",
  server: { host: "sftp.example.org" },
};

const baseWebRTC: ConnectionConfig = {
  channel: "webrtc",
  server: { host: "peer.example.org" },
};

// A fresh scratch directory per test, removed afterward; the file-writing tests
// below build their config paths under it.
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- timeout / reconnect overrides -------------------------------------------

test("multiple timeout overrides are merged into options", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    options: {
      peerTimeout: 60,
      connectionTimeout: 15,
      maxReconnectAttempts: 2,
    },
  });
  expect(result.options?.peerTimeoutMs).toBe(60_000);
  expect(result.options?.serverConnectTimeoutMs).toBe(15_000);
  expect(result.options?.maxReconnectAttempts).toBe(2);
});

test("existing options are preserved when adding timeout overrides", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { pollIntervalMs: 5000 },
  };
  const result = applyConnectionOverrides(base, {
    options: { peerTimeout: 20 },
  }) as SFTPConnectionConfig;
  expect(result.options?.pollIntervalMs).toBe(5000);
  expect(result.options?.peerTimeoutMs).toBe(20_000);
});

// --- pollIntervalMs override (--polling-frequency) ---------------------------

test("pollIntervalMs override is applied verbatim (already milliseconds, no scaling)", () => {
  // Unlike peerTimeout (seconds -> ms), the poll interval override is already in
  // milliseconds, so a 100 override lands as pollIntervalMs 100 unchanged.
  const result = applyConnectionOverrides(baseSFTP, {
    options: { pollIntervalMs: 100 },
  }) as SFTPConnectionConfig;
  expect(result.options?.pollIntervalMs).toBe(100);
});

test("pollIntervalMs override applies on the filedrop channel too", () => {
  const base: ConnectionConfig = { channel: "filedrop", path: "/mnt/drop" };
  const result = applyConnectionOverrides(base, {
    options: { pollIntervalMs: 250 },
  }) as FileDropConnectionConfig;
  expect(result.options?.pollIntervalMs).toBe(250);
});

test("pollIntervalMs override is dropped on webrtc (a FileSyncOptions-only field)", () => {
  // pollIntervalMs is a FileSyncOptions field, so the file-sync-gated block skips
  // it on webrtc rather than writing an option the webrtc schema does not carry.
  // webrtc's options type is SharedOptions (no pollIntervalMs), so read it through
  // a record cast to assert the field is absent.
  const result = applyConnectionOverrides(baseWebRTC, {
    options: { pollIntervalMs: 100 },
  });
  expect(
    (result.options as Record<string, unknown> | undefined)?.["pollIntervalMs"],
  ).toBeUndefined();
});

test("an existing pollIntervalMs in the config is overridden by --polling-frequency", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { pollIntervalMs: 5000 },
  };
  const result = applyConnectionOverrides(base, {
    options: { pollIntervalMs: 100 },
  }) as SFTPConnectionConfig;
  expect(result.options?.pollIntervalMs).toBe(100);
});

// --- connectionPerPoll override (--connection-per-poll) ----------------------

test("connectionPerPoll override is applied on the sftp channel", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    options: { connectionPerPoll: true },
  }) as SFTPConnectionConfig;
  expect(result.options?.connectionPerPoll).toBe(true);
});

test("connectionPerPoll override is dropped on filedrop (SFTP-only)", () => {
  // Unlike pollIntervalMs (valid on both file-sync channels), connectionPerPoll is
  // SFTP-only: filedrop holds no session, so the override is not written there and
  // the CLI warns it is ignored instead.
  const base: ConnectionConfig = { channel: "filedrop", path: "/mnt/drop" };
  const result = applyConnectionOverrides(base, {
    options: { connectionPerPoll: true },
  }) as FileDropConnectionConfig;
  expect(
    (result.options as Record<string, unknown> | undefined)?.[
      "connectionPerPoll"
    ],
  ).toBeUndefined();
});

test("connectionPerPoll override is dropped on webrtc", () => {
  const result = applyConnectionOverrides(baseWebRTC, {
    options: { connectionPerPoll: true },
  });
  expect(
    (result.options as Record<string, unknown> | undefined)?.[
      "connectionPerPoll"
    ],
  ).toBeUndefined();
});

test("connectionPerPoll override preserves other existing options on sftp", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { pollIntervalMs: 300_000 },
  };
  const result = applyConnectionOverrides(base, {
    options: { connectionPerPoll: true },
  }) as SFTPConnectionConfig;
  expect(result.options?.connectionPerPoll).toBe(true);
  expect(result.options?.pollIntervalMs).toBe(300_000);
});

// --- timeout override re-validation ------------------------------------------
// The timeout-override block re-validates its merged options through the same
// schema the FileSync-field block uses, so the peerTimeoutMs/serverConnectTimeoutMs
// positivity floors are enforced regardless of which override path reached them.

test("a non-positive peerTimeout override is rejected with a UsageError", () => {
  // peerTimeout 0 -> peerTimeoutMs 0, which violates the schema's positivity
  // floor. The CLI duration parser already rejects this upstream; the schema
  // re-parse closes the same hole for any non-CLI override path.
  expect(() =>
    applyConnectionOverrides(baseSFTP, { options: { peerTimeout: 0 } }),
  ).toThrow(UsageError);
  expect(() =>
    applyConnectionOverrides(baseSFTP, { options: { peerTimeout: -1 } }),
  ).toThrow(UsageError);
});

test("a non-positive connectionTimeout override is rejected with a UsageError", () => {
  expect(() =>
    applyConnectionOverrides(baseSFTP, { options: { connectionTimeout: 0 } }),
  ).toThrow(UsageError);
  expect(() =>
    applyConnectionOverrides(baseSFTP, { options: { connectionTimeout: -1 } }),
  ).toThrow(UsageError);
});

test("maxReconnectAttempts 0 passes re-validation (nonnegative, not positive)", () => {
  // 0 is a valid maxReconnectAttempts ("connect once, do not reconnect") -- the
  // schema floor is nonnegative, not positive -- so the new re-validation path
  // must accept it rather than reject it alongside the non-positive timeouts.
  const result = applyConnectionOverrides(baseSFTP, {
    options: { maxReconnectAttempts: 0 },
  });
  expect(result.options?.maxReconnectAttempts).toBe(0);
});

test("a valid timeout override still passes through unchanged on webrtc", () => {
  const result = applyConnectionOverrides(baseWebRTC, {
    options: { peerTimeout: 30, connectionTimeout: 15 },
  });
  expect(result.options?.peerTimeoutMs).toBe(30_000);
  expect(result.options?.serverConnectTimeoutMs).toBe(15_000);
});

test("a non-positive timeout override is rejected on webrtc too", () => {
  // webrtc never reaches the FileSync-field block, so this exercises the
  // timeout block's own re-validation. FileSyncOptionsSchema is a safe superset
  // for a webrtc SharedOptions object (its FileSync-only refines cannot fire).
  expect(() =>
    applyConnectionOverrides(baseWebRTC, { options: { peerTimeout: 0 } }),
  ).toThrow(UsageError);
});

test("the two override blocks agree on a non-positive peerTimeoutMs floor", () => {
  // A pre-existing options block carrying an invalid (non-positive) peerTimeoutMs
  // is rejected whether re-validation is reached via a FileSync-field override
  // or via the timeout block -- both routes parse through the same schema.
  const withBadPeerTimeout: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { peerTimeoutMs: 0, timestampInFilename: true },
  };
  // Reached via the FileSync-field block (overriding peerId triggers its re-parse).
  expect(() =>
    applyConnectionOverrides(withBadPeerTimeout, {
      options: { peerId: "agency-a" },
    }),
  ).toThrow(UsageError);
  // Reached via the timeout block (overriding connectionTimeout leaves the
  // invalid peerTimeoutMs in the merged options).
  expect(() =>
    applyConnectionOverrides(withBadPeerTimeout, {
      options: { connectionTimeout: 10 },
    }),
  ).toThrow(UsageError);
});

// --- server credential overrides ---------------------------------------------

test("serverUsername overrides the connection username", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    server: { username: "alice" },
  });
  if (result.channel !== "sftp") return;
  expect(result.server.username).toBe("alice");
});

test("serverPort overrides the connection port", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    server: { port: 2222 },
  });
  if (result.channel !== "sftp") return;
  expect(result.server.port).toBe(2222);
});

test("an out-of-range serverPort is rejected on the ordinary path (no outboundPath)", () => {
  expect(() =>
    applyConnectionOverrides(baseSFTP, { server: { port: 99_999 } }),
  ).toThrow(UsageError);
  expect(() =>
    applyConnectionOverrides(baseSFTP, { server: { port: 99_999 } }),
  ).toThrow("65535");
});

test("a negative serverPort is rejected on the ordinary path", () => {
  expect(() =>
    applyConnectionOverrides(baseSFTP, { server: { port: -5 } }),
  ).toThrow(UsageError);
});

// --- host-key fingerprint pre-pinning (--server-host-key-fingerprint) --------

const FP = "SHA256:" + "A".repeat(43);

test("hostKeyFingerprint overrides an unpinned connection", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    server: { hostKeyFingerprint: FP },
  });
  if (result.channel !== "sftp") return;
  expect(result.server.hostKeyFingerprint).toBe(FP);
});

test("hostKeyFingerprint overwrites a fingerprint already pinned in the base config", () => {
  // An explicit CLI pin is the operator's current word on the server's
  // identity, so it supersedes whatever the loaded config already carried
  // rather than being ignored or merged alongside it.
  const other = "SHA256:" + "B".repeat(42) + "A";
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org", hostKeyFingerprint: other },
  };
  const result = applyConnectionOverrides(base, {
    server: { hostKeyFingerprint: FP },
  });
  if (result.channel !== "sftp") return;
  expect(result.server.hostKeyFingerprint).toBe(FP);
});

test("hostKeyFingerprint override participates in the same schema re-validation as other server overrides", () => {
  // applyConnectionOverrides itself does not format-check the string -- CLI
  // format validation happens earlier, at parse time (hostKeyFingerprintFlag) --
  // but a malformed value that reaches here (e.g. from a non-CLI caller) must
  // still be caught by the connection-wide re-validation the hostKeyFingerprint
  // override triggers (serverModified -> safeParseConnectionConfig), exactly as
  // an out-of-range serverPort is.
  expect(() =>
    applyConnectionOverrides(baseSFTP, {
      server: { hostKeyFingerprint: "not-a-valid-fingerprint" },
    }),
  ).toThrow(UsageError);
});

test("an absent hostKeyFingerprint override leaves an existing pin untouched", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org", hostKeyFingerprint: FP },
  };
  const result = applyConnectionOverrides(base, { server: { port: 2222 } });
  if (result.channel !== "sftp") return;
  expect(result.server.hostKeyFingerprint).toBe(FP);
});

test("hostKeyFingerprint override is dropped (not an error) off the sftp channel", () => {
  // Like the sibling credential overrides, a fingerprint override is meaningless
  // on webrtc (no SFTP host key to pin) and is silently ignored rather than
  // rejected -- webrtc carries its own connection-security surface (TURN/ICE),
  // not an SSH host key.
  const result = applyConnectionOverrides(baseWebRTC, {
    server: { hostKeyFingerprint: FP },
  });
  if (result.channel !== "webrtc") return;
  expect(
    (result.server as unknown as Record<string, unknown>)["hostKeyFingerprint"],
  ).toBeUndefined();
});

test("a serverPassword conflicting with a base config's privateKey is rejected on the ordinary path", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org", privateKey: "@key.pem" },
  };
  expect(() =>
    applyConnectionOverrides(base, { server: { password: "hunter2" } }),
  ).toThrow(UsageError);
  expect(() =>
    applyConnectionOverrides(base, { server: { password: "hunter2" } }),
  ).toThrow("at most one primary authentication method");
});

test("serverPrivateKeyPassphrase applies alongside a private-key override", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    server: { privateKey: "@key.pem", privateKeyPassphrase: "@pass.txt" },
  });
  if (result.channel !== "sftp") return;
  expect(result.server.privateKey).toBe("@key.pem");
  // The literal @path is carried through verbatim (resolved later, at live use),
  // just like the sibling credential overrides.
  expect(result.server.privateKeyPassphrase).toBe("@pass.txt");
});

test("serverPrivateKeyPassphrase applies when the private key is already in the base config", () => {
  // The exchange path: the passphrase unlocks a private_key the loaded config
  // already carries, so --server-private-key need not be re-passed to satisfy
  // the requires-private-key precondition.
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org", privateKey: "@/keys/id_ed25519" },
  };
  const result = applyConnectionOverrides(base, {
    server: { privateKeyPassphrase: "@pass.txt" },
  });
  if (result.channel !== "sftp") return;
  expect(result.server.privateKeyPassphrase).toBe("@pass.txt");
});

test("a passphrase override with no private key is rejected with a UsageError", () => {
  // Mirrors the core schema's "privateKeyPassphrase is only valid with
  // privateKey" refine at the CLI override layer, with a flag-named message so
  // the operator sees which flag to pair it with.
  expect(() =>
    applyConnectionOverrides(baseSFTP, {
      server: { privateKeyPassphrase: "@pass.txt" },
    }),
  ).toThrow(UsageError);
  // Assert on the requirement phrase, not a bare "--server-private-key": that
  // bare substring also matches inside "--server-private-key-passphrase", so it
  // would pass even if the message dropped the requirement clause.
  expect(() =>
    applyConnectionOverrides(baseSFTP, {
      server: { privateKeyPassphrase: "@pass.txt" },
    }),
  ).toThrow("requires --server-private-key");
});

test("a passphrase override is ignored (not an error) off the sftp channel", () => {
  // The requires-private-key check is sftp-scoped; like the sibling credential
  // overrides, a passphrase is silently dropped on a channel that carries no
  // server credentials (filedrop) rather than triggering the check.
  const base: ConnectionConfig = { channel: "filedrop", path: "/mnt/share" };
  const result = applyConnectionOverrides(base, {
    server: { privateKeyPassphrase: "@pass.txt" },
  });
  expect(result).toEqual(base);
});

// --- keyboard-interactive override -------------------------------------------

test("serverKeyboardInteractive applies alongside a password override", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    server: { password: "@pass.txt", keyboardInteractive: true },
  });
  if (result.channel !== "sftp") return;
  expect(result.server.keyboardInteractive).toBe(true);
  expect(result.server.password).toBe("@pass.txt");
});

test("serverKeyboardInteractive applies when the password is already in the base config", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org", password: "@/secrets/pw" },
  };
  const result = applyConnectionOverrides(base, {
    server: { keyboardInteractive: true },
  });
  if (result.channel !== "sftp") return;
  expect(result.server.keyboardInteractive).toBe(true);
});

test("a keyboard-interactive override with no password is rejected with a UsageError", () => {
  // Mirrors the core schema's "keyboard_interactive requires password" refine at
  // the CLI override layer, with a flag-named message.
  expect(() =>
    applyConnectionOverrides(baseSFTP, {
      server: { keyboardInteractive: true },
    }),
  ).toThrow(UsageError);
  expect(() =>
    applyConnectionOverrides(baseSFTP, {
      server: { keyboardInteractive: true },
    }),
  ).toThrow("requires --server-password");
});

test("a keyboard-interactive override is ignored (not an error) off the sftp channel", () => {
  // sftp-scoped like the credential overrides: silently dropped on filedrop.
  const base: ConnectionConfig = { channel: "filedrop", path: "/mnt/share" };
  const result = applyConnectionOverrides(base, {
    server: { keyboardInteractive: true },
  });
  expect(result).toEqual(base);
});

test("a keyboard-interactive: false override turns it off over a config that had it on", () => {
  // The negated CLI form (--no-server-keyboard-interactive) arrives as `false`;
  // it must override a config's `true`, and (being false, not true) it does not
  // trip the requires-password guard even though this config carries no password.
  const base: ConnectionConfig = {
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      password: "@pw.txt",
      keyboardInteractive: true,
    },
  };
  const result = applyConnectionOverrides(base, {
    server: { keyboardInteractive: false },
  });
  if (result.channel !== "sftp") return;
  expect(result.server.keyboardInteractive).toBe(false);
});

// --- immutability ------------------------------------------------------------

test("empty overrides object does not change the connection", () => {
  const result = applyConnectionOverrides(baseSFTP, {});
  expect(result).toEqual(baseSFTP);
});

test("the input connection object is not mutated", () => {
  const input: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
  };
  applyConnectionOverrides(input, {
    options: { peerTimeout: 10 },
    server: { username: "bob" },
  });
  expect(input.options).toBeUndefined();
  if (input.channel !== "sftp") return;
  expect(input.server.username).toBeUndefined();
});

// --- peerId validation -------------------------------------------------------

test("peerId override accepted when timestampInFilename is already set in config", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { timestampInFilename: true },
  };
  const result = applyConnectionOverrides(base, {
    options: { peerId: "agency-a" },
  });
  if (result.channel !== "sftp") return;
  expect(result.options?.peerId).toBe("agency-a");
});

test("peerId 'temp' is rejected by applyConnectionOverrides", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { timestampInFilename: true },
  };
  // Invalid option combinations are usage errors (CLI exit 64), not exit 69.
  expect(() =>
    applyConnectionOverrides(base, { options: { peerId: "temp" } }),
  ).toThrow(UsageError);
  expect(() =>
    applyConnectionOverrides(base, { options: { peerId: "temp" } }),
  ).toThrow("reserved");
});

test("peerId without timestampInFilename is rejected by applyConnectionOverrides", () => {
  expect(() =>
    applyConnectionOverrides(baseSFTP, { options: { peerId: "agency-a" } }),
  ).toThrow("timestamp_in_filename");
});

test("peerId without timestampInFilename is rejected on filedrop too", () => {
  const base: ConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/share",
  };
  expect(() =>
    applyConnectionOverrides(base, { options: { peerId: "agency-a" } }),
  ).toThrow("timestamp_in_filename");
});

test("empty peerId is rejected by applyConnectionOverrides", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { timestampInFilename: true },
  };
  expect(() =>
    applyConnectionOverrides(base, { options: { peerId: "" } }),
  ).toThrow();
});

// --- retainFiles implication --------------------------------------------------

test("retainFiles: true with unset lockless and timestamp implies both true", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    options: { retainFiles: true },
  });
  if (result.channel !== "sftp") return;
  expect(result.options?.retainFiles).toBe(true);
  expect(result.options?.locklessRendezvous).toBe(true);
  expect(result.options?.timestampInFilename).toBe(true);
});

test("retainFiles: true preserves an already-set locklessRendezvous: true", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { locklessRendezvous: true, timestampInFilename: true },
  };
  const result = applyConnectionOverrides(base, {
    options: { retainFiles: true },
  });
  if (result.channel !== "sftp") return;
  expect(result.options?.locklessRendezvous).toBe(true);
});

test("retainFiles: true with explicit locklessRendezvous: false throws", () => {
  expect(() =>
    applyConnectionOverrides(baseSFTP, {
      options: { retainFiles: true, locklessRendezvous: false },
    }),
  ).toThrow(UsageError);
  expect(() =>
    applyConnectionOverrides(baseSFTP, {
      options: { retainFiles: true, locklessRendezvous: false },
    }),
  ).toThrow("lockless_rendezvous");
});

// --- outbound-path (split inbound/outbound directory) ------------------------

const baseSFTPWithPath: ConnectionConfig = {
  channel: "sftp",
  server: { host: "sftp.example.org", path: "/drop/in" },
};

const baseFiledrop: ConnectionConfig = {
  channel: "filedrop",
  path: "/mnt/share/in",
};

test("outboundPath splits an sftp shared path into inbound/outbound", () => {
  const result = applyConnectionOverrides(baseSFTPWithPath, {
    options: { retainFiles: true },
    server: { outboundPath: "/drop/out" },
  });
  if (result.channel !== "sftp") return;
  expect(result.server.inboundPath).toBe("/drop/in");
  expect(result.server.outboundPath).toBe("/drop/out");
  expect(result.server.path).toBeUndefined();
  // --retain-files alone suffices; it implies lockless + timestamp.
  expect(result.options?.retainFiles).toBe(true);
});

test("outboundPath splits a filedrop shared path into inbound/outbound", () => {
  const result = applyConnectionOverrides(baseFiledrop, {
    options: { retainFiles: true },
    server: { outboundPath: "/mnt/share/out" },
  });
  if (result.channel !== "filedrop") return;
  expect(result.inboundPath).toBe("/mnt/share/in");
  expect(result.outboundPath).toBe("/mnt/share/out");
  expect(result.path).toBeUndefined();
});

test("outboundPath overrides only the outbound on an already-split config", () => {
  const base: ConnectionConfig = {
    channel: "filedrop",
    inboundPath: "/mnt/share/in",
    outboundPath: "/mnt/share/old-out",
    options: {
      retainFiles: true,
      locklessRendezvous: true,
      timestampInFilename: true,
    },
  };
  const result = applyConnectionOverrides(base, {
    server: { outboundPath: "/mnt/share/new-out" },
  });
  if (result.channel !== "filedrop") return;
  expect(result.inboundPath).toBe("/mnt/share/in");
  expect(result.outboundPath).toBe("/mnt/share/new-out");
  expect(result.path).toBeUndefined();
});

test("outboundPath without retain mode is rejected naming --retain-files", () => {
  expect(() =>
    applyConnectionOverrides(baseSFTPWithPath, {
      server: { outboundPath: "/drop/out" },
    }),
  ).toThrow(UsageError);
  expect(() =>
    applyConnectionOverrides(baseSFTPWithPath, {
      server: { outboundPath: "/drop/out" },
    }),
  ).toThrow("--retain-files");
});

test("outboundPath equal to the inbound path is rejected", () => {
  const overrides = {
    options: { retainFiles: true },
    server: { outboundPath: "/mnt/share/in" },
  };
  expect(() => applyConnectionOverrides(baseFiledrop, overrides)).toThrow(
    UsageError,
  );
  expect(() => applyConnectionOverrides(baseFiledrop, overrides)).toThrow(
    "differ",
  );
});

test("a relative filedrop outbound path is rejected (filedrop requires absolute)", () => {
  const overrides = {
    options: { retainFiles: true },
    server: { outboundPath: "relative/out" },
  };
  expect(() => applyConnectionOverrides(baseFiledrop, overrides)).toThrow(
    UsageError,
  );
  expect(() => applyConnectionOverrides(baseFiledrop, overrides)).toThrow(
    "absolute",
  );
});

test("a relative sftp outbound path is allowed (sftp permits relative paths)", () => {
  const result = applyConnectionOverrides(baseSFTPWithPath, {
    options: { retainFiles: true },
    server: { outboundPath: "outgoing" },
  });
  if (result.channel !== "sftp") return;
  expect(result.server.inboundPath).toBe("/drop/in");
  expect(result.server.outboundPath).toBe("outgoing");
});

test("outboundPath on an sftp login-home (no inbound path) is rejected as set-together", () => {
  // baseSFTP has no server.path, so the inbound half is unset; a split needs both.
  expect(() =>
    applyConnectionOverrides(baseSFTP, {
      options: { retainFiles: true },
      server: { outboundPath: "/drop/out" },
    }),
  ).toThrow("set together");
});

test("outboundPath on a webrtc connection is rejected", () => {
  const webrtc: ConnectionConfig = {
    channel: "webrtc",
    server: { host: "peer.example.org" },
  };
  expect(() =>
    applyConnectionOverrides(webrtc, { server: { outboundPath: "/out" } }),
  ).toThrow("sftp and filedrop");
});

// --- saveConfig --------------------------------------------------------------

test("saveConfig emits snake_case keys and round-trips through parseExchangeSpec", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const spec: ExchangeSpec = {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: getDefaultLinkageTerms("Agency A"),
  };
  saveConfig(configPath, spec);
  const raw = fs.readFileSync(configPath, "utf8");
  // camelCase TS keys are written in their snake_case YAML form ...
  expect(raw).toContain("linkage_fields:");
  expect(raw).toContain("linkage_keys:");
  expect(raw).toContain("expects_output:");
  expect(raw).toContain("share_with_partner:");
  // The rule-set citation the default terms carry, so the saved config names the
  // set the exchange it configures will run.
  expect(raw).toContain("linkage_rule_set:");
  expect(raw).toContain("field_set:");
  expect(raw).toContain("key_set:");
  // ... never camelCase.
  expect(raw).not.toContain("linkageFields");
  expect(raw).not.toContain("expectsOutput");
  // Semantic-type VALUES are snake_case too, and stay snake_case across the
  // round-trip: camelizeKeys/snakeizeKeys transform keys only, so the value is
  // byte-stable iff it is already snake_case in memory (approach (b)). A
  // camelCase value (e.g. firstName) here would mean an enum value leaked onto
  // disk off-convention.
  expect(raw).toContain("type: first_name");
  expect(raw).toContain("type: date_of_birth");
  expect(raw).not.toContain("firstName");
  expect(raw).not.toContain("dateOfBirth");
  // The writer is the inverse of the reader's camelizeKeys: parsing the
  // written file reproduces the original spec exactly.
  expect(parseExchangeSpec(YAML.parse(raw))).toEqual(spec);
});

test("saveConfig writes the config owner-read-only (0600)", () => {
  // Windows uses a restricted ACL, not POSIX mode bits; fs.statSync reports a
  // synthetic mode there, so this assertion is Unix-only.
  if (process.platform === "win32") return;
  const configPath = path.join(dir, "psilink.yaml");
  // A spec carrying an inline SFTP credential is exactly why the config must
  // be owner-only: the 0600 mode is what keeps the password from other users.
  const spec: ExchangeSpec = {
    connection: {
      channel: "sftp",
      server: { host: "h", username: "u", password: "s3cret-inline" },
    },
    linkageTerms: getDefaultLinkageTerms("Agency A"),
  };
  saveConfig(configPath, spec);
  expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(configPath, "utf8")).toContain("s3cret-inline");
});

test("saveConfig strips sharedSecret/expires and does not mutate the caller's spec", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const spec = {
    connection: {
      channel: "sftp",
      server: { host: "h" },
    },
    authentication: {
      sharedSecret: token,
      expires: "2028-01-01T00:00:00.000Z",
    },
    linkageTerms: getDefaultLinkageTerms("Agency A"),
  } as unknown as ExchangeSpec;
  saveConfig(configPath, spec);
  const raw = fs.readFileSync(configPath, "utf8");
  // Key material never lands in the config, even when the caller leaves it set.
  expect(raw).not.toContain("shared_secret");
  expect(raw).not.toContain(token);
  expect(raw).not.toContain("expires");
  // The now-empty authentication container is pruned, not left as `{}`.
  expect(raw).not.toContain("authentication");
  // The strip runs on a clone; the caller's spec is untouched.
  expect(spec.authentication?.sharedSecret).toBe(token);
  expect(spec.authentication?.expires).toBe("2028-01-01T00:00:00.000Z");
});

// --- persistHostKeyFingerprint -----------------------------------------------

const FP_A = "SHA256:" + "A".repeat(43);
const FP_B = "SHA256:" + "B".repeat(42) + "E";

test("persistHostKeyFingerprint adds the pin and preserves comments and other fields", () => {
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    [
      "# hand-authored config",
      "connection:",
      "  channel: sftp",
      "  server:",
      "    host: sftp.example.org # the drop",
      "    username: alice",
      "",
    ].join("\n"),
  );
  persistHostKeyFingerprint(configPath, FP_A);
  const raw = fs.readFileSync(configPath, "utf8");
  expect(raw).toContain("host_key_fingerprint");
  expect(raw).toContain(FP_A);
  // The in-place document edit keeps the operator's comments and other fields.
  expect(raw).toContain("# hand-authored config");
  expect(raw).toContain("host: sftp.example.org # the drop");
  expect(raw).toContain("username: alice");
  const parsed = YAML.parse(raw) as {
    connection: { server: { host_key_fingerprint: string } };
  };
  expect(parsed.connection.server.host_key_fingerprint).toBe(FP_A);
});

test("persistHostKeyFingerprint replaces an existing stored pin (the one-shot re-pin)", () => {
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    [
      "connection:",
      "  channel: sftp",
      "  server:",
      "    host: sftp.example.org",
      `    host_key_fingerprint: ${FP_A}`,
      "",
    ].join("\n"),
  );
  persistHostKeyFingerprint(configPath, FP_B);
  const raw = fs.readFileSync(configPath, "utf8");
  expect(raw).toContain(FP_B);
  expect(raw).not.toContain(FP_A);
  const parsed = YAML.parse(raw) as {
    connection: { server: { host_key_fingerprint: string } };
  };
  expect(parsed.connection.server.host_key_fingerprint).toBe(FP_B);
});

test("persistHostKeyFingerprint writes the config owner-read-only (0600)", () => {
  if (process.platform === "win32") return;
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    "connection:\n  channel: sftp\n  server:\n    host: h\n",
  );
  persistHostKeyFingerprint(configPath, FP_A);
  expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
});

test("persistHostKeyFingerprint throws (not silently) on a malformed config", () => {
  const configPath = path.join(dir, "psilink.yaml");
  // A clearly invalid mapping (a value with a bare ':' block-mapping conflict).
  fs.writeFileSync(configPath, "connection:\n  - a\n  b: c\n");
  expect(() => persistHostKeyFingerprint(configPath, FP_A)).toThrow(UsageError);
});

// The two source-bearing leak channels an in-place config edit can hit, each with
// an inline credential on the offending line. A syntax error is collected in
// doc.errors before the edit, its message embedding a snippet of the source; an
// unresolved alias leaves doc.errors empty and setIn succeeds, so the failure
// surfaces only when doc.toString() materializes the document, echoing the alias
// token. Both are guarded inside the one sensitive-file chokepoint that every
// persist* routes its parse/edit/serialize through, so the battery runs once over
// its inputs here rather than once per caller; each other caller's own
// malformed-config test pins that it still routes through that chokepoint, whose
// path-only UsageError a raw parseDocument would never produce.
const CREDENTIAL_LEAK_CHANNELS = [
  {
    channel: "a syntax error collected before the edit",
    source: (secret: string) =>
      `connection:\n  server:\n\t  password: ${secret}\n`,
    expected: "could not be parsed as YAML",
  },
  {
    channel: "an unresolved alias surfacing at serialization",
    source: (secret: string) =>
      `connection:\n  channel: sftp\n  server:\n    password: *${secret}\n`,
    expected: "could not be serialized as YAML",
  },
] as const;

test.each(CREDENTIAL_LEAK_CHANNELS)(
  "persistHostKeyFingerprint reports the path only, never the source: $channel",
  ({ source, expected }) => {
    const SECRET = "S3cr3tSFTPPassw0rd";
    const configPath = path.join(dir, "psilink.yaml");
    const original = source(SECRET);
    fs.writeFileSync(configPath, original);
    let caught: unknown;
    try {
      persistHostKeyFingerprint(configPath, FP_A);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as Error).message).toContain(expected);
    // The credential must not appear anywhere in the surfaced (and logged) error.
    expect((caught as Error).message).not.toContain(SECRET);
    // The operator's file is left byte-for-byte intact (the throw precedes the
    // write), so a failed persist neither leaks the credential nor mangles it.
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
  },
);

test("persistHostKeyFingerprint raises a UsageError when connection.server is not a mapping", () => {
  // A sftp config that PARSES (so it clears the channel guard) but whose
  // connection.server is a scalar (not a mapping) makes YAML's setIn throw a raw
  // library error; the function must surface it as the actionable UsageError its
  // contract promises, not an opaque stack trace, and must leave the original
  // file untouched (the throw precedes the write).
  const configPath = path.join(dir, "psilink.yaml");
  const original = "connection:\n  channel: sftp\n  server: nope\n";
  fs.writeFileSync(configPath, original);
  expect(() => persistHostKeyFingerprint(configPath, FP_A)).toThrow(UsageError);
  expect(fs.readFileSync(configPath, "utf8")).toBe(original);
});

test("persistHostKeyFingerprint rejects a non-sftp config and leaves the file untouched", () => {
  // The host-key pin is an sftp-only concept: connection.server is the sftp
  // shape, so persisting a fingerprint onto a filedrop (no server) or webrtc
  // (a different server shape) config would synthesize a bogus pin and a mapping
  // that channel's schema does not expect. The guard fails closed before any
  // write, echoing the offending channel, so the operator's file is left
  // byte-for-byte intact.
  const fixtures = [
    {
      // A string channel is echoed verbatim so the operator sees which channel
      // was rejected.
      source: "connection:\n  channel: filedrop\n  path: /mnt/share\n",
      expectInMessage: '"filedrop"',
    },
    {
      source:
        "connection:\n  channel: webrtc\n  server:\n    signaling: wss://signal.example.org\n",
      expectInMessage: '"webrtc"',
    },
    {
      // No channel key at all: the guard reports it generically, never echoing
      // `undefined`.
      source: "connection:\n  server:\n    host: h\n",
      expectInMessage: "absent or non-scalar",
    },
    {
      // A channel that parses to a collection (here a sequence) is not a string,
      // so it takes the same generic branch rather than being echoed.
      source: "connection:\n  channel:\n    - sftp\n  server:\n    host: h\n",
      expectInMessage: "absent or non-scalar",
    },
  ];
  for (const { source, expectInMessage } of fixtures) {
    const configPath = path.join(dir, "psilink.yaml");
    fs.writeFileSync(configPath, source);
    let caught: unknown;
    try {
      persistHostKeyFingerprint(configPath, FP_A);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as Error).message).toContain(expectInMessage);
    expect((caught as Error).message).toContain("sftp");
    // Not mutated: the bytes are exactly what the operator wrote -- no pin
    // synthesized, no server mapping fabricated on the filedrop config.
    const after = fs.readFileSync(configPath, "utf8");
    expect(after).toBe(source);
    expect(after).not.toContain("host_key_fingerprint");
  }
});

test("persistHostKeyFingerprint sanitizes the echoed channel for display", () => {
  // The rejected channel is echoed so the operator sees what was wrong, but it
  // is operator-authored config text that can carry control bytes -- an ESC that
  // drives an ANSI sequence, or a newline usable for log-line spoofing. The
  // error is display-bound (it reaches a terminal/log), so the channel reaches
  // the operator escaped, never raw -- asserted at the rendered boundary, the
  // altitude that escape happens at.
  const configPath = path.join(dir, "psilink.yaml");
  // A double-quoted YAML scalar whose value decodes to x<ESC><LF>y.
  const source = 'connection:\n  channel: "x\\x1b\\ny"\n';
  fs.writeFileSync(configPath, source);
  let caught: unknown;
  try {
    persistHostKeyFingerprint(configPath, FP_A);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  const rendered = sanitizeErrorForDisplay(caught);
  // The raw control bytes never reach the operator ...
  expect(rendered).not.toContain("\u001b");
  expect(rendered).not.toContain("\n");
  // ... they are shown as visible escapes instead.
  expect(rendered).toContain("\\x1b");
  expect(rendered).toContain("\\x0a");
  // The file is left untouched (the throw precedes the write).
  expect(fs.readFileSync(configPath, "utf8")).toBe(source);
});

test("persistHostKeyFingerprint round-trips a fingerprint containing + and /", () => {
  // The SHA256 fingerprint alphabet includes '+' and '/'; the serializer must
  // quote as needed so the value re-parses byte-for-byte -- a mis-quoted pin
  // would later fail to match and refuse every connection.
  const FP_SPECIAL = "SHA256:" + "a/b+c" + "D".repeat(38);
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    "connection:\n  channel: sftp\n  server:\n    host: h\n",
  );
  persistHostKeyFingerprint(configPath, FP_SPECIAL);
  const parsed = YAML.parse(fs.readFileSync(configPath, "utf8")) as {
    connection: { server: { host_key_fingerprint: string } };
  };
  expect(parsed.connection.server.host_key_fingerprint).toBe(FP_SPECIAL);
});

test("saveConfig round-trips provider_options verbatim in both directions", () => {
  const configPath = path.join(dir, "psilink.yaml");
  // provider_options is opaque: a literal camelCase key (ssh2's readyTimeout)
  // and a snake_case key must both survive the writer + reader unchanged. The
  // writer must not snakeize readyTimeout, and the reader must not camelize
  // keepalive_interval, because core's shared walker treats the providerOptions
  // subtree as opaque in both directions.
  const spec: ExchangeSpec = {
    connection: {
      channel: "sftp",
      server: { host: "h" },
      providerOptions: { readyTimeout: 5000, keepalive_interval: 1000 },
    },
    linkageTerms: getDefaultLinkageTerms("Agency A"),
  };

  // write: keys land on disk byte-for-byte (camelCase stays camelCase, snake
  // stays snake) -- not transformed by snakeizeKeys.
  saveConfig(configPath, spec);
  const raw1 = fs.readFileSync(configPath, "utf8");
  expect(raw1).toContain("readyTimeout:");
  expect(raw1).toContain("keepalive_interval:");
  expect(raw1).not.toContain("ready_timeout:");
  expect(raw1).not.toContain("keepaliveInterval:");

  // read: parsing reproduces the spec exactly, opaque map included.
  const parsed = parseExchangeSpec(YAML.parse(raw1));
  expect(parsed).toEqual(spec);
  if (parsed.connection.channel !== "sftp")
    throw new Error("expected sftp channel");
  expect(parsed.connection.providerOptions).toEqual({
    readyTimeout: 5000,
    keepalive_interval: 1000,
  });

  // read -> write: writing the re-read spec produces an identical opaque map,
  // confirming the round-trip is stable in both directions.
  saveConfig(configPath, parsed);
  const raw2 = fs.readFileSync(configPath, "utf8");
  expect(YAML.parse(raw2).connection.provider_options).toEqual(
    YAML.parse(raw1).connection.provider_options,
  );
});

test("saveConfig round-trips webrtc provider_options verbatim", () => {
  const configPath = path.join(dir, "psilink.yaml");
  // providerOptions is opaque on webrtc as well as sftp; the writer/reader
  // key-normalization is channel-agnostic, so a literal camelCase key and a
  // snake_case key must both survive the round-trip byte-for-byte.
  const spec: ExchangeSpec = {
    connection: {
      channel: "webrtc",
      server: { host: "api.peerjs.com" },
      providerOptions: { readyTimeout: 5000, keepalive_interval: 1000 },
    },
    linkageTerms: getDefaultLinkageTerms("Agency A"),
  };

  saveConfig(configPath, spec);
  const raw = fs.readFileSync(configPath, "utf8");
  expect(raw).toContain("readyTimeout:");
  expect(raw).toContain("keepalive_interval:");
  expect(raw).not.toContain("ready_timeout:");
  expect(raw).not.toContain("keepaliveInterval:");

  const parsed = parseExchangeSpec(YAML.parse(raw));
  expect(parsed).toEqual(spec);
  if (parsed.connection.channel !== "webrtc")
    throw new Error("expected webrtc channel");
  expect(parsed.connection.providerOptions).toEqual({
    readyTimeout: 5000,
    keepalive_interval: 1000,
  });
});

test("saveConfig preserves WebRTC connection.role and prunes the authentication block", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const spec = {
    connection: {
      channel: "webrtc",
      server: { host: "api.peerjs.com" },
      role: "inviter",
    },
    authentication: {
      sharedSecret: token,
      expires: "2028-01-01T00:00:00.000Z",
    },
    linkageTerms: getDefaultLinkageTerms("Agency A"),
  } as unknown as ExchangeSpec;
  saveConfig(configPath, spec);
  const raw = fs.readFileSync(configPath, "utf8");
  // connection.role survives (a connection field, never stripped) ...
  expect(raw).toContain("role: inviter");
  // ... while the authentication block, holding only key material, is pruned.
  expect(raw).not.toContain("authentication");
  expect(raw).not.toContain("shared_secret");
  expect(raw).not.toContain(token);
  expect(raw).not.toContain("expires");
});

// --- persistDisclosedPayloadColumns ------------------------------------------

test("persistDisclosedPayloadColumns adds the field and preserves comments and other fields", () => {
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    [
      "# hand-authored config",
      "connection:",
      "  channel: sftp",
      "  server:",
      "    host: sftp.example.org # the drop",
      "",
    ].join("\n"),
  );
  persistDisclosedPayloadColumns(configPath, ["notes", "member_id"]);
  const raw = fs.readFileSync(configPath, "utf8");
  // Operator comments and other fields survive the surgical write.
  expect(raw).toContain("# hand-authored config");
  expect(raw).toContain("host: sftp.example.org # the drop");
  const parsed = YAML.parse(raw) as {
    disclosed_payload_columns: string[];
  };
  expect(parsed.disclosed_payload_columns).toEqual(["notes", "member_id"]);
});

test("persistDisclosedPayloadColumns refreshes a stale value (the re-invite fix)", () => {
  // A config carrying an OLD commitment, re-minted over changed metadata: the
  // field must be overwritten to the new set, never left stale (else the next
  // exchange false-fires against a promise the partner no longer holds).
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    [
      "connection:",
      "  channel: sftp",
      "  server:",
      "    host: h",
      "disclosed_payload_columns:",
      "  - old_col",
      "",
    ].join("\n"),
  );
  persistDisclosedPayloadColumns(configPath, ["new_col"]);
  const raw = fs.readFileSync(configPath, "utf8");
  expect(raw).not.toContain("old_col");
  const parsed = YAML.parse(raw) as { disclosed_payload_columns: string[] };
  expect(parsed.disclosed_payload_columns).toEqual(["new_col"]);
});

test("persistDisclosedPayloadColumns removes the field when the commitment is undefined", () => {
  // A re-invite from a config whose metadata is unknown publishes no subset, so a
  // previously-recorded commitment must be cleared, not retained stale.
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    [
      "connection:",
      "  channel: sftp",
      "  server:",
      "    host: h",
      "disclosed_payload_columns:",
      "  - old_col",
      "",
    ].join("\n"),
  );
  persistDisclosedPayloadColumns(configPath, undefined);
  const raw = fs.readFileSync(configPath, "utf8");
  expect(raw).not.toContain("disclosed_payload_columns");
  expect(raw).not.toContain("old_col");
  // The rest of the config is intact.
  const parsed = YAML.parse(raw) as {
    connection: { channel: string };
    disclosed_payload_columns?: string[];
  };
  expect(parsed.connection.channel).toBe("sftp");
  expect(parsed.disclosed_payload_columns).toBeUndefined();
});

test("persistDisclosedPayloadColumns writes an empty array verbatim (strict disclose-nothing)", () => {
  // Empty is a real commitment ("disclose nothing"), distinct from absent; it must
  // be written, not dropped.
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    "connection:\n  channel: sftp\n  server:\n    host: h\n",
  );
  persistDisclosedPayloadColumns(configPath, []);
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = YAML.parse(raw) as { disclosed_payload_columns: string[] };
  expect(parsed.disclosed_payload_columns).toEqual([]);
});

test("persistDisclosedPayloadColumns writes the config owner-read-only (0600)", () => {
  if (process.platform === "win32") return;
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    "connection:\n  channel: sftp\n  server:\n    host: h\n",
  );
  persistDisclosedPayloadColumns(configPath, ["notes"]);
  expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
});

test("persistDisclosedPayloadColumns throws (not silently) on a malformed config", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const original = "connection: [unbalanced\n";
  fs.writeFileSync(configPath, original);
  // Routed through the same sensitive-file chokepoint as persistHostKeyFingerprint,
  // so the parse failure is classified as a local usage error (exit 64) rather than
  // a bare Error that would fall through to the generic exit code -- and, being a
  // path-only failure raised before the write, leaves the file intact.
  expect(() => persistDisclosedPayloadColumns(configPath, ["notes"])).toThrow(
    UsageError,
  );
  expect(fs.readFileSync(configPath, "utf8")).toBe(original);
});

// --- persistExpectedPayloadColumns -------------------------------------------

test("persistExpectedPayloadColumns adds the field and preserves comments and other fields", () => {
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    [
      "# hand-authored config",
      "connection:",
      "  channel: sftp",
      "  server:",
      "    host: sftp.example.org # the drop",
      "",
    ].join("\n"),
  );
  persistExpectedPayloadColumns(configPath, ["diagnosis", "notes"]);
  const raw = fs.readFileSync(configPath, "utf8");
  // Operator comments and other fields survive the surgical write.
  expect(raw).toContain("# hand-authored config");
  expect(raw).toContain("host: sftp.example.org # the drop");
  const parsed = YAML.parse(raw) as {
    expected_payload_columns: string[];
  };
  expect(parsed.expected_payload_columns).toEqual(["diagnosis", "notes"]);
});

test("persistExpectedPayloadColumns refreshes a stale value (the accept-reuse fix)", () => {
  // A config carrying an OLD consented set, re-accepted over a changed disclosed
  // subset: the field must be overwritten to the newly-consented set, never left
  // stale (else the next recurring exchange false-aborts against a set the partner
  // no longer discloses).
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    [
      "connection:",
      "  channel: sftp",
      "  server:",
      "    host: h",
      "expected_payload_columns:",
      "  - old_col",
      "",
    ].join("\n"),
  );
  persistExpectedPayloadColumns(configPath, ["new_col"]);
  const raw = fs.readFileSync(configPath, "utf8");
  expect(raw).not.toContain("old_col");
  const parsed = YAML.parse(raw) as { expected_payload_columns: string[] };
  expect(parsed.expected_payload_columns).toEqual(["new_col"]);
});

test("persistExpectedPayloadColumns removes the field when the consented set is undefined", () => {
  // A re-accept whose invitation carried no disclosed subset records no consented
  // set, so a previously-recorded lock-in must be cleared, not retained stale --
  // the exchange then reconciles lazily.
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    [
      "connection:",
      "  channel: sftp",
      "  server:",
      "    host: h",
      "expected_payload_columns:",
      "  - old_col",
      "",
    ].join("\n"),
  );
  persistExpectedPayloadColumns(configPath, undefined);
  const raw = fs.readFileSync(configPath, "utf8");
  expect(raw).not.toContain("expected_payload_columns");
  expect(raw).not.toContain("old_col");
  // The rest of the config is intact.
  const parsed = YAML.parse(raw) as {
    connection: { channel: string };
    expected_payload_columns?: string[];
  };
  expect(parsed.connection.channel).toBe("sftp");
  expect(parsed.expected_payload_columns).toBeUndefined();
});

test("persistExpectedPayloadColumns writes an empty array verbatim (strict receive-nothing)", () => {
  // Empty is a real consent ("receive nothing"), distinct from absent; it must be
  // written, not dropped.
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    "connection:\n  channel: sftp\n  server:\n    host: h\n",
  );
  persistExpectedPayloadColumns(configPath, []);
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = YAML.parse(raw) as { expected_payload_columns: string[] };
  expect(parsed.expected_payload_columns).toEqual([]);
});

test("persistExpectedPayloadColumns writes the config owner-read-only (0600)", () => {
  if (process.platform === "win32") return;
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    "connection:\n  channel: sftp\n  server:\n    host: h\n",
  );
  persistExpectedPayloadColumns(configPath, ["diagnosis"]);
  expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
});

test("persistExpectedPayloadColumns throws (not silently) on a malformed config", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const original = "connection: [unbalanced\n";
  fs.writeFileSync(configPath, original);
  // Same chokepoint routing as persistDisclosedPayloadColumns: a local usage error
  // (exit 64) rather than a bare Error, raised before the write so the file is
  // left intact.
  expect(() =>
    persistExpectedPayloadColumns(configPath, ["diagnosis"]),
  ).toThrow(UsageError);
  expect(fs.readFileSync(configPath, "utf8")).toBe(original);
});

// --- persistExpectedPartnerDeduplicate ---------------------------------------

test("persistExpectedPartnerDeduplicate writes a boolean the spec schema reads back", () => {
  // The surgical one-field write, driven end to end rather than reasoned about:
  // the value must land as a YAML boolean the exchange-spec parse accepts, and
  // the operator's comments and other fields must survive it.
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    [
      "# hand-authored config",
      "connection:",
      "  channel: sftp",
      "  server:",
      "    host: sftp.example.org # the drop",
      "",
    ].join("\n"),
  );
  persistExpectedPartnerDeduplicate(configPath, false);
  const raw = fs.readFileSync(configPath, "utf8");
  expect(raw).toContain("# hand-authored config");
  expect(raw).toContain("host: sftp.example.org # the drop");
  expect(YAML.parse(raw).expected_partner_deduplicate).toBe(false);
  persistExpectedPartnerDeduplicate(configPath, true);
  expect(
    YAML.parse(fs.readFileSync(configPath, "utf8"))
      .expected_partner_deduplicate,
  ).toBe(true);
});

test("persistExpectedPartnerDeduplicate refreshes a stale declaration", () => {
  // A config carrying a PRIOR acceptance's declaration, re-accepted over an
  // invitation declaring the other value: the field is overwritten to what the
  // operator has just consented to, never left stale (a stale `true` would refuse
  // an honest partner now presenting `false`).
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    [
      "connection:",
      "  channel: sftp",
      "  server:",
      "    host: h",
      "expected_partner_deduplicate: true",
      "",
    ].join("\n"),
  );
  persistExpectedPartnerDeduplicate(configPath, false);
  const raw = fs.readFileSync(configPath, "utf8");
  expect(YAML.parse(raw).expected_partner_deduplicate).toBe(false);
});

test("persistExpectedPartnerDeduplicate writes the config owner-read-only (0600)", () => {
  if (process.platform === "win32") return;
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    "connection:\n  channel: sftp\n  server:\n    host: h\n",
  );
  persistExpectedPartnerDeduplicate(configPath, true);
  expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
});

test("persistExpectedPartnerDeduplicate throws (not silently) on a malformed config", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const original = "connection: [unbalanced\n";
  fs.writeFileSync(configPath, original);
  expect(() => persistExpectedPartnerDeduplicate(configPath, true)).toThrow(
    UsageError,
  );
  expect(fs.readFileSync(configPath, "utf8")).toBe(original);
});

// --- diffLinkageTerms / formatReconcileDiffs ---------------------------------

// A deep clone so a test can mutate one copy without disturbing the other; both
// start byte-identical, the equal-terms baseline these tests perturb from.
function cloneTerms(terms: LinkageTerms): LinkageTerms {
  return structuredClone(terms);
}

test("diffLinkageTerms: identical terms have no conflicts and no warnings", () => {
  const a = getDefaultLinkageTerms("Inviter Org");
  const b = getDefaultLinkageTerms("Inviter Org");
  const { conflicts, warnings } = diffLinkageTerms(a, b);
  expect(conflicts).toEqual([]);
  expect(warnings).toEqual([]);
});

test("diffLinkageTerms: a differing identity is NOT a conflict (party-specific)", () => {
  const existing = getDefaultLinkageTerms("Acceptor Org");
  const incoming = getDefaultLinkageTerms("Inviter Org");
  // identity is the only field that differs; it is excluded from the comparison.
  const { conflicts, warnings } = diffLinkageTerms(existing, incoming);
  expect(conflicts).toEqual([]);
  expect(warnings).toEqual([]);
});

test("diffLinkageTerms: a differing date warns rather than conflicts (soft field)", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  existing.date = "2020-01-01";
  incoming.date = "2024-06-09";
  const { conflicts, warnings } = diffLinkageTerms(existing, incoming);
  expect(conflicts).toEqual([]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("date");
});

test("diffLinkageTerms: an algorithm mismatch is a conflict naming the field", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  existing.algorithm = "psi-c";
  incoming.algorithm = "psi";
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].field).toBe("algorithm");
  expect(conflicts[0].existing).toBe("psi-c");
  expect(conflicts[0].incoming).toBe("psi");
});

test("diffLinkageTerms: a linkage-strategy mismatch is a conflict naming the field", () => {
  // linkageStrategy is mandatory-consistency like algorithm: a reused config whose
  // strategy differs from the invitation must abort the reuse, not silently keep a
  // config whose disclosure tradeoff differs from the one the acceptor was shown.
  // Both directions, since either could persist a strategy the acceptor did not
  // consent to (single-pass kept under a cascade invitation) or run a weaker one
  // than consented (cascade kept under a single-pass invitation).
  for (const [existingStrategy, incomingStrategy] of [
    ["single-pass", "cascade"],
    ["cascade", "single-pass"],
  ] as const) {
    const existing = cloneTerms(getDefaultLinkageTerms("Org"));
    const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
    existing.linkageStrategy = existingStrategy;
    incoming.linkageStrategy = incomingStrategy;
    const { conflicts } = diffLinkageTerms(existing, incoming);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].field).toBe("linkage_strategy");
    expect(conflicts[0].existing).toBe(existingStrategy);
    expect(conflicts[0].incoming).toBe(incomingStrategy);
  }
});

test("diffLinkageTerms: a differing output policy is NOT a conflict (per-party)", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  // output is a per-party preference the protocol checks as a complementary
  // mirror at exchange time, so two valid parties differ here; reconciliation
  // must not equality-compare it.
  existing.output = { expectsOutput: false, shareWithPartner: true };
  incoming.output = { expectsOutput: true, shareWithPartner: false };
  const { conflicts, warnings } = diffLinkageTerms(existing, incoming);
  expect(conflicts).toEqual([]);
  expect(warnings).toEqual([]);
});

test("diffLinkageTerms: a differing deduplicate flag is NOT a conflict (per-party)", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  // deduplicate is per-party with no cross-party check; the acceptor's own value
  // is legitimate. (Keep expectsOutput true to satisfy the intra-party rule that
  // deduplicate requires it.)
  existing.output = { expectsOutput: true, shareWithPartner: true };
  incoming.output = { expectsOutput: true, shareWithPartner: true };
  existing.deduplicate = true;
  incoming.deduplicate = false;
  const { conflicts, warnings } = diffLinkageTerms(existing, incoming);
  expect(conflicts).toEqual([]);
  expect(warnings).toEqual([]);
});

test("diffLinkageTerms: a linkage-keys mismatch is a conflict naming the field", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  // Drop a key from one side so the key sets differ.
  incoming.linkageKeys = incoming.linkageKeys.slice(0, -1);
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts.map((c) => c.field)).toContain("linkage_keys");
});

test("diffLinkageTerms: a sub-field difference under matching key names renders the detail", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  // Same key names on both sides, but one key's element is derived from a
  // different field. A names-only render would print two identical lists; the
  // detail fallback must instead show what actually differs.
  incoming.linkageKeys[0].elements[0].field =
    existing.linkageKeys[0].elements[0].field + "_x";
  const { conflicts } = diffLinkageTerms(existing, incoming);
  const keyConflict = conflicts.find((c) => c.field === "linkage_keys");
  expect(keyConflict).toBeDefined();
  expect(keyConflict?.existing).not.toBe(keyConflict?.incoming);
  expect(keyConflict?.incoming).toContain("_x");
});

test("diffLinkageTerms: an un-encodable value does not throw and identical terms still reconcile", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  // A transform param outside the JSON-safe integer range survives parsing
  // (params is `z.unknown()`) but canonicalString rejects it. Both sides carry
  // the SAME value, so the terms are identical and must reconcile cleanly: the
  // canonical throw must not escape and abort two identical configs.
  existing.linkageKeys[0].elements[0].transform = [
    { function: "noop", params: { big: 1e20 } },
  ];
  incoming.linkageKeys[0].elements[0].transform = [
    { function: "noop", params: { big: 1e20 } },
  ];
  let result!: ReturnType<typeof diffLinkageTerms>;
  expect(() => {
    result = diffLinkageTerms(existing, incoming);
  }).not.toThrow();
  // No hard conflict (so the config is reused), with a warning that the field
  // could not be compared here -- the exchange re-checks compatibility later.
  expect(result.conflicts).toEqual([]);
  expect(result.warnings.some((w) => w.includes("JSON-safe range"))).toBe(true);
});

test("diffLinkageTerms: a pathologically deep transform.params is a clean bounded rejection, not a RangeError", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  // nfcDeep's own depth guard, exercised directly. A real invitation's deep params
  // is rejected earlier, at the decode chokepoint (the camelize fold bounds it --
  // see the decode-side test in core's invitation.test.ts), so the reconcile does
  // not see one in practice. This builds the 3000-deep value straight into the
  // reconcile input (bypassing decode) to pin nfcDeep's backstop: it is an
  // independent recursion that must reject a deep value itself rather than trust its
  // caller to have pre-bounded it. Build it iteratively so the test does not recurse.
  let deep: Record<string, unknown> = { leaf: "x" };
  for (let i = 0; i < 3000; i++) deep = { a: deep };
  incoming.linkageKeys[0].elements[0].transform = [
    { function: "noop", params: deep },
  ];
  // The depth guard fires as a clean NestingDepthExceededError (a UsageError ->
  // CLI exit 64) at depth 256, before nfcDeep overflows the call stack with an
  // unguarded RangeError that would otherwise surface as a generic exit 69.
  expect(() => diffLinkageTerms(existing, incoming)).toThrow(
    NestingDepthExceededError,
  );
});

test("diffLinkageTerms: a realistically nested transform.params reconciles unchanged", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  // A nested params object at a depth a real config could plausibly use -- far
  // above the one or two levels the bundled functions need, yet well within the
  // bound -- present identically on both sides, so the terms stay equal and must
  // reconcile with no conflict and no throw (the bound rejects no real token).
  const nested = { table: { fields: { score: { weight: 3 } } } };
  existing.linkageKeys[0].elements[0].transform = [
    { function: "lookup", params: nested },
  ];
  incoming.linkageKeys[0].elements[0].transform = [
    { function: "lookup", params: structuredClone(nested) },
  ];
  let result!: ReturnType<typeof diffLinkageTerms>;
  expect(() => {
    result = diffLinkageTerms(existing, incoming);
  }).not.toThrow();
  expect(result.conflicts).toEqual([]);
  expect(result.warnings).toEqual([]);
});

test("diffLinkageTerms: a transform.params value difference is a conflict", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  // The reconcile compares already-camelCase terms (the existing config camelized
  // at load, the invitation's adopted terms camelized at the decode chokepoint), so
  // this checks the substance: a different param VALUE under the same key diverges
  // and is flagged as a linkage_keys conflict.
  existing.linkageKeys[0].elements[0].transform = [
    { function: "parse_date", params: { inputFormat: "MMDDYYYY" } },
  ];
  incoming.linkageKeys[0].elements[0].transform = [
    { function: "parse_date", params: { inputFormat: "YYYYMMDD" } },
  ];
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts.map((c) => c.field)).toContain("linkage_keys");
});

test("diffLinkageTerms: NFC-equivalent identifiers are not flagged as differing", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  // Rename the first linkage key on both sides to the same logical string in
  // different Unicode normalization forms: NFC "e-acute" (U+00E9) vs the NFD
  // decomposition "e" + U+0301. They are canonically equivalent and must not
  // register as a conflict.
  existing.linkageKeys[0].name = "cl\u00e9";
  incoming.linkageKeys[0].name = "cle\u0301";
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts).toEqual([]);
});

test("diffLinkageTerms: NFC-vs-NFD field names that reorder the sort are not a false conflict", () => {
  // Two fields whose normalization form changes their sort order: NFC "\u00c5"
  // (U+00C5) sorts after "B", but its NFD form "A\u030a" begins with "A" and
  // sorts before "B". If the comparator sorted on the raw name the two sides
  // would order differently and falsely conflict; the NFC-normalized comparator
  // must keep them equal.
  const base = getDefaultLinkageTerms("Org");
  const field = base.linkageFields[0];
  const existing = cloneTerms(base);
  const incoming = cloneTerms(base);
  existing.linkageFields = [
    { ...structuredClone(field), name: "B" },
    { ...structuredClone(field), name: "\u00c5" },
  ];
  incoming.linkageFields = [
    { ...structuredClone(field), name: "B" },
    { ...structuredClone(field), name: "A\u030a" },
  ];
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts.map((c) => c.field)).not.toContain("linkage_fields");
  expect(conflicts).toEqual([]);
});

test("diffLinkageTerms: an explicitly-undefined optional is treated as absent", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  // An in-process object (unlike a Zod-parsed one) can carry an explicit
  // `undefined` optional. nfcDeep must drop it rather than feed it to
  // canonicalString (which rejects undefined and would throw); it must still
  // compare equal to the side that simply omits `swap`.
  existing.linkageKeys[0].swap = undefined;
  expect(() => diffLinkageTerms(existing, incoming)).not.toThrow();
  expect(diffLinkageTerms(existing, incoming).conflicts).toEqual([]);
});

test("diffLinkageTerms: a payload mismatch is a conflict", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  incoming.payload = { send: [{ name: "extra_col" }] };
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts.map((c) => c.field)).toContain("payload");
});

test("diffLinkageTerms: a payload sub-field difference under matching names renders the detail", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  // Same column name on both sides, differing only in description: a names-only
  // render would print identical send=/receive= summaries, so the detail
  // fallback must show what actually differs.
  existing.payload = { send: [{ name: "note", description: "old" }] };
  incoming.payload = { send: [{ name: "note", description: "new" }] };
  const { conflicts } = diffLinkageTerms(existing, incoming);
  const payloadConflict = conflicts.find((c) => c.field === "payload");
  expect(payloadConflict).toBeDefined();
  expect(payloadConflict?.existing).not.toBe(payloadConflict?.incoming);
  expect(payloadConflict?.incoming).toContain("new");
});

test("formatReconcileDiffs: renders each field with its existing and required values", () => {
  const rendered = formatReconcileDiffs([
    { field: "algorithm", existing: "psi-c", incoming: "psi" },
    { field: "connection.server.host", existing: "old-host", incoming: "host" },
  ]);
  expect(rendered).toContain("algorithm");
  expect(rendered).toContain("psi-c");
  expect(rendered).toContain("connection.server.host");
  expect(rendered).toContain("old-host");
  // One line per diff.
  expect(rendered.split("\n")).toHaveLength(2);
});

test("formatReconcileDiffs: escapes partner-controlled values against terminal injection", () => {
  // The incoming side can be a partner-controlled string (a linkage key name, or
  // an inviter's split inbound_path/outbound_path from the connection endpoint),
  // rendered to the acceptor's terminal before acceptance. A control/ANSI
  // sequence in it must be neutralized, not passed through. The block is composed
  // into a UsageError by its only caller, so this asserts at that error's rendered
  // boundary rather than on the raw block.
  const rendered = sanitizeErrorForDisplay(
    new Error(
      formatReconcileDiffs([
        {
          field: "connection.server.inbound_path",
          existing: "/safe/in",
          incoming: "/drop\x1b[2J\x1b[31m",
        },
      ]),
    ),
  );
  expect(rendered).not.toContain("\x1b");
  expect(rendered).toContain("\\x1b");
});

// --- loadConfigLinkageSource -------------------------------------------------

test("loadConfigLinkageSource returns undefined when no file exists", () => {
  expect(
    loadConfigLinkageSource(path.join(dir, "absent.yaml")),
  ).toBeUndefined();
});

test("loadConfigLinkageSource round-trips an explicit standardization block", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const terms = getDefaultLinkageTerms("Agency A");
  const standardization = [
    {
      output: "ssn",
      input: "tax_id",
      steps: [{ function: "trim_whitespace" }],
    },
  ];
  saveConfig(configPath, {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: terms,
    standardization,
  });
  expect(loadConfigLinkageSource(configPath)?.standardization).toEqual(
    standardization,
  );
});

test("loadConfigLinkageSource round-trips an explicit metadata block", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const terms = getDefaultLinkageTerms("Agency A");
  const metadata = [
    {
      name: "tax_id",
      type: "ssn" as const,
      role: "linkage" as const,
      isPayload: false,
    },
  ];
  saveConfig(configPath, {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: terms,
    metadata,
  });
  // saveConfig writes is_payload; loadConfigLinkageSource camelizes it back.
  expect(loadConfigLinkageSource(configPath)?.metadata).toEqual(metadata);
});

test("loadConfigLinkageSource rejects a config with an invalid metadata block", () => {
  const configPath = path.join(dir, "psilink.yaml");
  // Valid linkage_terms (so the metadata branch is reached) plus a metadata
  // entry with an unknown semantic type.
  const yaml = YAML.stringify({
    linkageTerms: getDefaultLinkageTerms("Agency A"),
    metadata: [
      { name: "X", type: "not_a_type", role: "linkage", isPayload: false },
    ],
  });
  fs.writeFileSync(configPath, yaml);
  expect(() => loadConfigLinkageSource(configPath)).toThrow(UsageError);
  expect(() => loadConfigLinkageSource(configPath)).toThrow("invalid metadata");
});

test("loadConfigLinkageSource rejects a config with no linkage_terms", () => {
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    "connection:\n  channel: filedrop\n  path: /x\n",
  );
  expect(() => loadConfigLinkageSource(configPath)).toThrow(UsageError);
  expect(() => loadConfigLinkageSource(configPath)).toThrow("no linkage_terms");
});

// The two absences loadConfigLinkageSource folds into one `undefined` and one
// invitation-specific refusal stay apart here, so a caller reading the same file
// for another purpose (verify-receipt reads it for signing.partner_fingerprint)
// attributes each in its own terms rather than reporting a broken invitation
// source.
test("readConfigLinkageSource tells a missing file from a config with no terms", () => {
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(configPath, "signing:\n  mode: certificate\n");
  expect(readConfigLinkageSource(path.join(dir, "absent.yaml"))).toEqual({
    status: "no-config-file",
  });
  expect(readConfigLinkageSource(configPath)).toEqual({
    status: "no-linkage-terms",
  });
});

test("readConfigLinkageSource returns the source a config defines", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const terms = getDefaultLinkageTerms("Agency A");
  saveConfig(configPath, {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: terms,
  });
  const result = readConfigLinkageSource(configPath);
  expect(result).toEqual({
    status: "loaded",
    source: {
      linkageTerms: terms,
      standardization: undefined,
      metadata: undefined,
      retainsFiles: false,
    },
  });
});

// The one connection fact the reader lifts out, for the invitation's retain
// declaration. A `true` at the fixed path is read; nothing else about the block
// is parsed, which is what keeps a still-placeholder connection from blocking an
// invitation.
test("readConfigLinkageSource reads retain mode off the connection block", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const terms = getDefaultLinkageTerms("Agency A");
  saveConfig(configPath, {
    connection: {
      channel: "filedrop",
      path: "/mnt/share",
      options: {
        retainFiles: true,
        locklessRendezvous: true,
        timestampInFilename: true,
      },
    },
    linkageTerms: terms,
  });
  const result = readConfigLinkageSource(configPath);
  expect(result).toMatchObject({
    status: "loaded",
    source: { retainsFiles: true },
  });
});

// Only a literal `true` is a declaration. A connection block the operator has
// not finished -- no options at all, a non-object where one is expected, a
// non-boolean value -- reads as no declaration rather than as a claim that the
// exchange deletes its files, and none of those shapes is an error here: the
// block stays unvalidated so an unfinished config can still mint an invitation.
//
// The webrtc case is the one that turns on the CHANNEL rather than the value:
// retain mode is a file-sync setting that channel does not have. Without this
// function's own channel check, a config carrying `channel: webrtc` and
// `options: {retain_files: true}` would mint a token stating a mode no run of
// it could be in -- ConnectionConfigSchema does not catch it either way: a
// webrtc connection's options parse through SharedOptionsSchema, which has no
// retainFiles field, so the value is silently dropped rather than refused, and
// this same pairing loads and runs (in delete mode) through the full config
// loader too.
test.each([
  ["no options block", "connection:\n  channel: sftp\n"],
  [
    "retain_files absent",
    "connection:\n  options:\n    poll_interval_ms: 500\n",
  ],
  ["retain_files false", "connection:\n  options:\n    retain_files: false\n"],
  [
    "retain_files a string",
    "connection:\n  options:\n    retain_files: 'true'\n",
  ],
  ["options a scalar", "connection:\n  options: yes\n"],
  ["connection a scalar", "connection: sftp\n"],
  ["no connection block", ""],
  [
    "retain_files on a webrtc connection",
    "connection:\n  channel: webrtc\n  options:\n    retain_files: true\n",
  ],
])("readConfigLinkageSource declares no retain mode: %s", (_label, block) => {
  const configPath = path.join(dir, "psilink.yaml");
  const terms = getDefaultLinkageTerms("Agency A");
  // The nested keys stay camelCase: safeParseLinkageTerms camelizes on the way
  // in, so either spelling parses and the block under test is the connection.
  fs.writeFileSync(
    configPath,
    `${block}${YAML.stringify({ linkage_terms: terms })}`,
  );
  const result = readConfigLinkageSource(configPath);
  expect(result).toMatchObject({
    status: "loaded",
    source: { retainsFiles: false },
  });
});

// A defect in one of the blocks it does parse is still a refusal, not a status:
// only the two absences are outcomes the caller decides.
test("readConfigLinkageSource still refuses invalid linkage_terms", () => {
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(configPath, "linkage_terms:\n  identity: Agency A\n");
  expect(() => readConfigLinkageSource(configPath)).toThrow(UsageError);
  expect(() => readConfigLinkageSource(configPath)).toThrow(
    "invalid linkage_terms",
  );
});

// A local config whose linkage_terms trips a camelizeKeys structural bound (here
// the depth bound, the cheapest to reach) must still surface the file-named
// "config file X has invalid linkage_terms: ..." wrap, not the raw bound-error
// text -- safeParseLinkageTerms is genuinely non-throwing for the bound, so the
// if(!result.success) branch produces the helpful message rather than the throw
// skipping straight past it. Still a UsageError (CLI exit 64).
test("loadConfigLinkageSource file-names a linkage_terms camelize-bound trip", () => {
  const configPath = path.join(dir, "psilink.yaml");
  // Nest one level past the depth bound so camelizeKeys rejects before Zod.
  let deepTerms: unknown = { identity: "Agency A" };
  for (let i = 0; i < MAX_NESTING_DEPTH; i++) deepTerms = { nested: deepTerms };
  fs.writeFileSync(configPath, YAML.stringify({ linkage_terms: deepTerms }));
  expect(() => loadConfigLinkageSource(configPath)).toThrow(UsageError);
  // The file-named wrap, carrying the bound's fixed message (no input bytes),
  // not the raw NestingDepthExceededError text that the pre-fix throw produced.
  expect(() => loadConfigLinkageSource(configPath)).toThrow(
    `config file ${configPath} has invalid linkage_terms: input nesting ` +
      `exceeds the maximum depth of ${MAX_NESTING_DEPTH}`,
  );
});

// The same for the metadata branch: a valid linkage_terms reaches it, then a
// camelize-bound-tripping metadata block surfaces the file-named "invalid
// metadata" wrap rather than throwing the raw bound error.
test("loadConfigLinkageSource file-names a metadata camelize-bound trip", () => {
  const configPath = path.join(dir, "psilink.yaml");
  let deepMetadata: unknown = { name: "X" };
  for (let i = 0; i < MAX_NESTING_DEPTH; i++)
    deepMetadata = { nested: deepMetadata };
  fs.writeFileSync(
    configPath,
    YAML.stringify({
      linkage_terms: getDefaultLinkageTerms("Agency A"),
      metadata: deepMetadata,
    }),
  );
  expect(() => loadConfigLinkageSource(configPath)).toThrow(UsageError);
  expect(() => loadConfigLinkageSource(configPath)).toThrow(
    `config file ${configPath} has invalid metadata: input nesting ` +
      `exceeds the maximum depth of ${MAX_NESTING_DEPTH}`,
  );
});

// A camelized issue path names every segment in the spelling the file writes,
// and it can do that only for a key the camelize pass itself built. The one
// schema position holding a key it did not -- a transform `params` record key,
// the schema's only free-form record and the only position whose key schema
// bounds length, so the only one that can surface a key in a path at all -- is
// where the path stops instead: `_evil_key` and `EvilKey` on disk both arrive as
// the camelized `EvilKey`, so naming either spelling names a key one of those
// files does not contain. The three tests below pin the stop, what survives it,
// and the absence of over-escaping on the segments that do get named.
test("loadConfigLinkageSource stops a linkage_terms issue path at the params block", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const terms = cloneTerms(getDefaultLinkageTerms("Agency A"));
  // An ESC-driven ANSI sequence and a right-to-left override (U+202E). The key
  // must exceed MAX_NAME_LENGTH so the record-key schema rejects it and Zod
  // surfaces the offending key in the issue path.
  const badKey = "\x1b[31m\u202eevil" + "x".repeat(MAX_NAME_LENGTH + 10);
  terms.linkageKeys[0].elements[0].transform = [
    { function: "noop", params: { [badKey]: 1 } },
  ];
  fs.writeFileSync(configPath, YAML.stringify({ linkage_terms: terms }));
  let caught: unknown;
  try {
    loadConfigLinkageSource(configPath);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  const rendered = sanitizeErrorForDisplay(caught);
  expect(rendered).toContain("invalid linkage_terms");
  // Every segment before the block still locates the problem, and it is fixed
  // schema structure the whole way.
  expect(rendered).toContain("linkage_keys.0.elements.0.transform.0.params: ");
  // The key itself reaches the operator in no form: not raw, which the display
  // boundary would have had to escape, and not as the escape either.
  expect(rendered).not.toContain("\x1b");
  expect(rendered).not.toContain("\u202e");
  expect(rendered).not.toContain("\\x1b");
  expect(rendered).not.toContain("\\u202e");
});

test("loadConfigLinkageSource names no spelling of a params key it cannot invert", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const terms = cloneTerms(getDefaultLinkageTerms("Agency A"));
  // Capitals the camelize pass leaves untouched, so the segment reaching the
  // formatter is the file's own spelling -- and is equally the spelling a file
  // writing `_evil_key` would have arrived as. Over MAX_NAME_LENGTH so the key
  // reaches the issue path at all.
  const authorKey = "EvilKey" + "x".repeat(MAX_NAME_LENGTH);
  terms.linkageKeys[0].elements[0].transform = [
    { function: "noop", params: { [authorKey]: 1 } },
  ];
  fs.writeFileSync(configPath, YAML.stringify({ linkage_terms: terms }));
  let caught: unknown;
  try {
    loadConfigLinkageSource(configPath);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  const message = (caught as Error).message;
  expect(message).toContain("linkage_keys.0.elements.0.transform.0.params: ");
  // Neither the rewrite the schema-fixed segments take, which would name
  // `_evil_key...` -- a key this file does not contain -- nor the raw segment,
  // which would name it for this file while mis-naming the other one.
  expect(message).not.toContain("_evil_key");
  expect(message).not.toContain(authorKey);
});

test("loadConfigLinkageSource leaves a schema-fixed linkage_terms issue path unescaped", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const terms = cloneTerms(getDefaultLinkageTerms("Agency A"));
  // An empty name fails the linkage-key `name` min-length, locating the issue
  // at the schema-fixed path linkage_keys.0.name (field names + a numeric index).
  terms.linkageKeys[0].name = "";
  fs.writeFileSync(configPath, YAML.stringify({ linkage_terms: terms }));
  let caught: unknown;
  try {
    loadConfigLinkageSource(configPath);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  // Ordinary path components survive untouched: the `.` separators and the
  // numeric index are not over-escaped.
  expect((caught as Error).message).toContain("linkage_keys.0.name");
});

// Validation runs on the camelized shape, so a Zod issue names its field in
// camelCase while the operator is reading a file that writes those keys in
// snake_case. These pin the render seam that reconciles the two: a NESTED path
// (not just a top-level key) is named as the file writes it, and the file the
// error names is one the CLI's own writer produced, so the key it points at is
// literally in the bytes on disk.
test("a nested linkage_terms schema error names its key as the file writes it", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const terms = cloneTerms(getDefaultLinkageTerms("Agency A"));
  // A path with two segments whose spellings differ between the file and the
  // parsed shape, one of them under an array index: `linkage_fields.2.
  // constraints.affixes_allowed` on disk against `linkageFields.2.constraints.
  // affixesAllowed` once camelized.
  const constraints = terms.linkageFields[2].constraints as {
    affixesAllowed?: unknown;
  };
  constraints.affixesAllowed = "no";
  // Written in the on-disk form the CLI's own writer produces, so the file the
  // error names its key against is the snake_case one an operator reads.
  fs.writeFileSync(
    configPath,
    YAML.stringify({ linkage_terms: snakeizeKeys(terms) }),
  );

  let caught: unknown;
  try {
    loadConfigLinkageSource(configPath);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  const message = (caught as Error).message;
  expect(message).toContain("linkage_fields.2.constraints.affixes_allowed");
  expect(message).not.toContain("linkageFields");
  expect(message).not.toContain("affixesAllowed");
  // The key the message names is one the operator can find in the file.
  expect(fs.readFileSync(configPath, "utf8")).toContain("affixes_allowed");
});

test("a nested metadata schema error names its key as the file writes it", () => {
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    YAML.stringify({
      linkage_terms: getDefaultLinkageTerms("Agency A"),
      metadata: [{ name: "ssn", type: "ssn", role: "linkage", is_payload: 7 }],
    }),
  );

  let caught: unknown;
  try {
    loadConfigLinkageSource(configPath);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  const message = (caught as Error).message;
  expect(message).toContain("0.is_payload");
  expect(message).not.toContain("isPayload");
  expect(fs.readFileSync(configPath, "utf8")).toContain("is_payload");
});

test("loadConfigLinkageSource rejects an invalid standardization block", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const terms = getDefaultLinkageTerms("Agency A");
  // Valid linkage_terms but a standardization entry missing its required input.
  saveConfig(configPath, {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: terms,
  });
  fs.appendFileSync(
    configPath,
    "standardization:\n  - output: ssn\n    steps: []\n",
  );
  expect(() => loadConfigLinkageSource(configPath)).toThrow(UsageError);
  expect(() => loadConfigLinkageSource(configPath)).toThrow(
    "invalid standardization",
  );
});

test("loadConfigLinkageSource rejects malformed YAML", () => {
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(configPath, "linkage_terms: [unclosed\n");
  // The path-only message only the sensitive-parse chokepoint produces, so this is
  // also what pins that this reader routes through it rather than a raw parser --
  // and so inherits the source-bearing channels it closes (both of them exercised
  // with a credential in place against the same chokepoint's other CLI caller, in
  // exchange.test.ts).
  expect(() => loadConfigLinkageSource(configPath)).toThrow(UsageError);
  expect(() => loadConfigLinkageSource(configPath)).toThrow(
    "could not be parsed as YAML",
  );
});

// The schema-validation error branches (linkage_terms / standardization /
// metadata) interpolate the Zod issue message, which under Zod v4 names only the
// expected literals, never the rejected input value. That is what keeps a secret
// mistakenly placed in one of these blocks out of the error; Zod v3's enum error
// echoed the received value ("...received '<value>'") and would have leaked it.
// The sensitive-parse chokepoint sits upstream of this branch and so does not
// cover it, hence pinning it directly here: embed a secret as an invalid enum
// value and assert it never reaches the message.
// A future Zod that re-embeds the rejected value turns this red instead of
// silently leaking. Both blocks share the one path-only interpolation; the two
// cases cover the enum fields that would carry an attacker/operator string. The
// standardization block has no enum/literal field, so it offers no rejected
// VALUE a message could echo -- a case there would be vacuous, not coverage.
// Each case also asserts the rejected FIELD path is named, so the test fails
// loudly (rather than passing while testing nothing) if the secret ever stops
// being the value the targeted enum rejects.
test.each([
  [
    "metadata type enum",
    (s: string) =>
      YAML.stringify({
        linkageTerms: getDefaultLinkageTerms("Agency A"),
        metadata: [{ name: "X", type: s, role: "linkage", isPayload: false }],
      }),
    "invalid metadata",
    "0.type",
  ],
  [
    "linkage_terms algorithm enum",
    (s: string) =>
      YAML.stringify({
        linkageTerms: { ...getDefaultLinkageTerms("Agency A"), algorithm: s },
      }),
    "invalid linkage_terms",
    "algorithm",
  ],
])(
  "loadConfigLinkageSource does not echo a secret in a schema error: %s",
  (_, mk, expectedFragment, expectedPath) => {
    const SECRET = "S3cr3tSFTPPassw0rd";
    const configPath = path.join(dir, "psilink.yaml");
    fs.writeFileSync(configPath, mk(SECRET));
    let caught: unknown;
    try {
      loadConfigLinkageSource(configPath);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as Error).message).toContain(expectedFragment);
    // The targeted enum field is the one that rejected -- proves the secret was
    // the rejected value, so not.toContain below is non-vacuous.
    expect((caught as Error).message).toContain(expectedPath);
    expect((caught as Error).message).not.toContain(SECRET);
  },
);

test("loadConfigLinkageSource rejects a non-mapping top-level value", () => {
  const configPath = path.join(dir, "psilink.yaml");
  // A top-level YAML array parses as an object in JS; it must be reported as a
  // malformed config, not misattributed to a missing linkage_terms block.
  fs.writeFileSync(configPath, "- a\n- b\n");
  expect(() => loadConfigLinkageSource(configPath)).toThrow(UsageError);
  expect(() => loadConfigLinkageSource(configPath)).toThrow(
    "not a valid configuration object",
  );
});

// --- CLI-only entry-sweep flags ----------------------------------------------

test("connection.options.sweep_exchange_files is not a persistable config field (CLI-only)", () => {
  // The entry sweep is invocation-scoped: FileSyncOptionsSchema has no such
  // field, so the snake_case key is stripped at parse rather than flowing into
  // the connection options (where open() would otherwise read it).
  const configPath = path.join(dir, "psilink.yaml");
  const spec: ExchangeSpec = {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: getDefaultLinkageTerms("Agency A"),
  };
  saveConfig(configPath, spec);
  const raw = YAML.parse(fs.readFileSync(configPath, "utf8")) as {
    connection: { options?: Record<string, unknown> };
  };
  raw.connection.options = {
    ...(raw.connection.options ?? {}),
    sweep_exchange_files: true,
    force_retain_sweep: true,
  };
  const parsed = parseExchangeSpec(raw);
  const options = parsed.connection.options as
    Record<string, unknown> | undefined;
  expect(options?.["sweepExchangeFiles"]).toBeUndefined();
  expect(options?.["forceRetainSweep"]).toBeUndefined();
});

test("assertRetainSweepGuard: --force-retain-sweep alone is a UsageError; other combinations pass", () => {
  expect(() => assertRetainSweepGuard(false, true)).toThrow(UsageError);
  expect(() => assertRetainSweepGuard(false, true)).toThrow(
    "--force-retain-sweep requires --sweep-exchange-files",
  );
  expect(() => assertRetainSweepGuard(true, true)).not.toThrow();
  expect(() => assertRetainSweepGuard(true, false)).not.toThrow();
  expect(() => assertRetainSweepGuard(false, false)).not.toThrow();
});

// --- persistOutboundPayloadConsent: removal and empty-set shapes -------------

test("persistOutboundPayloadConsent removes the record on undefined, and no-ops when absent", () => {
  // The removal branch is what the accept-reuse and mint paths lean on: a record
  // that should not stand is deleted, never left stale -- and removing from a
  // config that carries none must not rewrite the operator's file.
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    [
      "connection:",
      "  channel: sftp",
      "  server:",
      "    host: h",
      "outbound_payload_consent:",
      "  status: confirmed",
      "  columns:",
      "    - old_col",
      "",
    ].join("\n"),
  );
  persistOutboundPayloadConsent(configPath, undefined);
  const raw = fs.readFileSync(configPath, "utf8");
  expect(raw).not.toContain("outbound_payload_consent");
  expect(raw).not.toContain("old_col");
  const parsed = YAML.parse(raw) as { connection: { channel: string } };
  expect(parsed.connection.channel).toBe("sftp");
  persistOutboundPayloadConsent(configPath, undefined);
  expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
});

test("persistOutboundPayloadConsent writes a confirmed-empty set verbatim", () => {
  // An empty confirmed set is a real confirmation that nothing is disclosed, not
  // an absence: it must survive to disk as `columns: []` and parse back as an
  // empty array, so a later run enforcing it refuses any disclosure at all.
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    ["connection:", "  channel: sftp", "  server:", "    host: h", ""].join(
      "\n",
    ),
  );
  persistOutboundPayloadConsent(configPath, {
    status: "confirmed",
    columns: [],
  });
  const parsed = YAML.parse(fs.readFileSync(configPath, "utf8")) as {
    outbound_payload_consent?: { status: string; columns?: string[] };
  };
  expect(parsed.outbound_payload_consent).toEqual({
    status: "confirmed",
    columns: [],
  });
});
