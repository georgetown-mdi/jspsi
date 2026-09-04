import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import YAML from "yaml";
import {
  bareTermsValue,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  controlCharacterMarker,
  DEFAULT_LINKAGE_RULE_SET,
  DISPLAY_TRUNCATION_MARKER,
  getDefaultLinkageTerms,
  MAX_NAME_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_NESTING_DEPTH,
  NestingDepthExceededError,
  parseExchangeSpec,
  quoteTermsValue,
  renderedDisplayCost,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
  snakeizeKeys,
  UsageError,
  validateCompatibility,
} from "@psilink/core";
import {
  applyConnectionOverrides,
  assertRetainSweepGuard,
  diffLinkageTerms,
  formatReconcileDiffs,
  linkageTermsStandingOf,
  reconcileConflictMessage,
  reconcileDiffValue,
  loadConfigLinkageSource,
  persistDisclosedPayloadColumns,
  persistExpectedPartnerDeduplicate,
  persistExpectedPayloadColumns,
  persistHostKeyFingerprint,
  persistOutboundPayloadConsent,
  readConfigLinkageSource,
  saveConfig,
  warnOnLinkageRuleSetCitationDrift,
} from "../../src/config";
import { diffConnectionAgainstTarget } from "../../src/reconcile";
import type { RunnableConnectionConfig } from "../../src/connectionFromUrl";
import type {
  CitationDriftAlternative,
  ConfigLinkageSource,
  LinkageTermsStanding,
  ReconcileDiff,
} from "../../src/config";
import type {
  ConnectionConfig,
  ExchangeSpec,
  FileDropConnectionConfig,
  LinkageRuleSetReference,
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

test.skipIf(process.platform === "win32")(
  "saveConfig writes the config owner-read-only (0600)",
  () => {
    // Windows uses a restricted ACL, not POSIX mode bits; fs.statSync reports a
    // synthetic mode there, so this assertion is Unix-only.
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
  },
);

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

test.skipIf(process.platform === "win32")(
  "persistHostKeyFingerprint writes the config owner-read-only (0600)",
  () => {
    const configPath = path.join(dir, "psilink.yaml");
    fs.writeFileSync(
      configPath,
      "connection:\n  channel: sftp\n  server:\n    host: h\n",
    );
    persistHostKeyFingerprint(configPath, FP_A);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  },
);

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

test.skipIf(process.platform === "win32")(
  "persistDisclosedPayloadColumns writes the config owner-read-only (0600)",
  () => {
    const configPath = path.join(dir, "psilink.yaml");
    fs.writeFileSync(
      configPath,
      "connection:\n  channel: sftp\n  server:\n    host: h\n",
    );
    persistDisclosedPayloadColumns(configPath, ["notes"]);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  },
);

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

test.skipIf(process.platform === "win32")(
  "persistExpectedPayloadColumns writes the config owner-read-only (0600)",
  () => {
    const configPath = path.join(dir, "psilink.yaml");
    fs.writeFileSync(
      configPath,
      "connection:\n  channel: sftp\n  server:\n    host: h\n",
    );
    persistExpectedPayloadColumns(configPath, ["diagnosis"]);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  },
);

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

test.skipIf(process.platform === "win32")(
  "persistExpectedPartnerDeduplicate writes the config owner-read-only (0600)",
  () => {
    const configPath = path.join(dir, "psilink.yaml");
    fs.writeFileSync(
      configPath,
      "connection:\n  channel: sftp\n  server:\n    host: h\n",
    );
    persistExpectedPartnerDeduplicate(configPath, true);
    expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
  },
);

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

// The message `psilink accept` composes when a kept config disagrees with the
// invitation, rendered the way the CLI's top-level handler renders a thrown
// UsageError. Driven through the composer the command itself calls, with the
// command's own first-party copy, so the tests that measure what survives that
// boundary measure the shape an operator actually meets.
const ACCEPT_RECONCILE_SOURCES = {
  configPath: "./psilink.yaml",
  against: "the invitation",
  retryWith: "the same invitation",
};

// The online shape, whose first-party copy is the longer of the two and so
// leaves the diff block the smaller share.
const ONLINE_RECONCILE_SOURCES = {
  configPath: "./psilink.yaml",
  against: "the invitation and the connection URL",
  retryWith: "the same URL and invitation",
};

function renderedAcceptReconcileError(
  conflicts: ReconcileDiff[],
  sources: {
    configPath: string;
    against: string;
    retryWith: string;
  } = ACCEPT_RECONCILE_SOURCES,
): string {
  return sanitizeErrorForDisplay(
    new UsageError(reconcileConflictMessage({ ...sources, diffs: conflicts })),
  );
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
  // Delimited, like every other value a conflict line names: the enum has no
  // digit, so the seam's checked bare form declines it and it takes the quoted
  // one, which costs the reading nothing.
  expect(conflicts[0].existing).toBe('"psi-c"');
  expect(conflicts[0].incoming).toBe('"psi"');
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
    expect(conflicts[0].existing).toBe(`"${existingStrategy}"`);
    expect(conflicts[0].incoming).toBe(`"${incomingStrategy}"`);
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

test("diffLinkageTerms: the rule-set citation follows core's both-sides-only rule", () => {
  // All four citation shapes against one reconcile, held to the rule
  // validateCompatibility applies: compared only where BOTH sides declare a
  // citation, so a one-sided one reconciles cleanly and only a two-sided
  // difference conflicts -- the case that would otherwise abort mid-run.
  const foreign: LinkageRuleSetReference = {
    fieldSet: { name: "county-pii", version: "3.1.0" },
    keySet: { name: "county-keys", version: "3.1.0" },
  };
  const withCitation = (
    citation: LinkageRuleSetReference | undefined,
  ): LinkageTerms => {
    const terms = cloneTerms(getDefaultLinkageTerms("Org"));
    if (citation === undefined) delete terms.linkageRuleSet;
    else terms.linkageRuleSet = citation;
    return terms;
  };
  const shipped = DEFAULT_LINKAGE_RULE_SET.reference;

  const neither = diffLinkageTerms(
    withCitation(undefined),
    withCitation(undefined),
  );
  expect(neither.conflicts).toEqual([]);
  expect(neither.warnings).toEqual([]);

  const configOnly = diffLinkageTerms(
    withCitation(shipped),
    withCitation(undefined),
  );
  expect(configOnly.conflicts).toEqual([]);
  expect(configOnly.warnings).toEqual([]);

  const invitationOnly = diffLinkageTerms(
    withCitation(undefined),
    withCitation(foreign),
  );
  expect(invitationOnly.conflicts).toEqual([]);
  expect(invitationOnly.warnings).toEqual([]);

  const agreeing = diffLinkageTerms(
    withCitation(shipped),
    withCitation({ fieldSet: shipped.fieldSet, keySet: shipped.keySet }),
  );
  expect(agreeing.conflicts).toEqual([]);
  expect(agreeing.warnings).toEqual([]);

  const differing = diffLinkageTerms(
    withCitation(shipped),
    withCitation(foreign),
  );
  expect(differing.conflicts).toHaveLength(1);
  expect(differing.conflicts[0].field).toBe("linkage_rule_set");
  // Keys first, the order core's mismatch message renders the pair in, and raw:
  // the caller composes this into a UsageError escaped once where it is shown.
  expect(differing.conflicts[0].existing).toBe(
    `"${shipped.keySet.name}" ${shipped.keySet.version} over ` +
      `"${shipped.fieldSet.name}" ${shipped.fieldSet.version}`,
  );
  expect(differing.conflicts[0].incoming).toBe(
    '"county-keys" 3.1.0 over "county-pii" 3.1.0',
  );
});

test("diffLinkageTerms: two citations differing only under NFC are a conflict", () => {
  // The citation is compared by RAW canonical form, matching the predicate
  // validateCompatibility applies to it: core holds two citations to byte-exact
  // equality, so this pair aborts the exchange mid-run. Folding the two names
  // together here would report the reuse clean and let the run reach that abort;
  // the conflict at accept is the honest pre-emption of it.
  const composed = "acc\u00e9s";
  const decomposed = "acce\u0301s";
  expect(composed).not.toBe(decomposed);
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  existing.linkageRuleSet = {
    fieldSet: { name: `${composed}-pii`, version: "1.0.0" },
    keySet: { name: `${composed}-keys`, version: "1.0.0" },
  };
  incoming.linkageRuleSet = {
    fieldSet: { name: `${decomposed}-pii`, version: "1.0.0" },
    keySet: { name: `${decomposed}-keys`, version: "1.0.0" },
  };
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].field).toBe("linkage_rule_set");
  // The same pair through core's own comparison, so the parity this compare
  // exists for is asserted against core rather than restated here.
  expect(
    validateCompatibility(existing, incoming).errors.some((e) =>
      e.includes("linkage rule set mismatch"),
    ),
  ).toBe(true);
  // The two clauses hold the same characters and would print alike on a
  // terminal, which would leave the operator a conflict they cannot see. They
  // are distinguishable because the display boundary escapes each non-ASCII code
  // point, so the composed and decomposed spellings render differently.
  const rendered = renderedAcceptReconcileError(conflicts);
  expect(rendered).toContain("acc\\xe9s-keys");
  expect(rendered).toContain("acce\\u0301s-keys");
});

test("diffLinkageTerms: a set name cannot forge the citation clause's own structure", () => {
  // Both names are built to spell the clause the conflict line composes around
  // them -- name, version, " over ", name, version -- which is printable ASCII
  // throughout, so nothing at the display boundary rewrites it. The two
  // citations are genuinely different and a plain quote would render them
  // identically; the seam's doubling grammar is what keeps each name inside one
  // run, so the pair stays distinguishable and neither name reads as structure.
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  existing.linkageRuleSet = {
    fieldSet: { name: 'a" 1.0.0 over "b', version: "1.0.0" },
    keySet: { name: "k", version: "1.0.0" },
  };
  incoming.linkageRuleSet = {
    fieldSet: { name: "b", version: "1.0.0" },
    keySet: { name: 'k" 1.0.0 over "a', version: "1.0.0" },
  };
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts).toHaveLength(1);
  expect(conflicts[0].existing).not.toBe(conflicts[0].incoming);
  // Each embedded delimiter is doubled, so the run it sits in cannot close on
  // it, and the clause still carries exactly one " over " per side.
  expect(conflicts[0].existing).toBe(
    '"k" 1.0.0 over "a"" 1.0.0 over ""b" 1.0.0',
  );
  expect(conflicts[0].incoming).toBe(
    '"k"" 1.0.0 over ""a" 1.0.0 over "b" 1.0.0',
  );
  const rendered = renderedAcceptReconcileError(conflicts);
  expect(rendered).toContain("then retry with the same invitation.");
  // The clause's fit is a second account of the same composition, so a slot that
  // can hold the clause whole must show exactly the clause: a fitted form that
  // had drifted from the composed one fails here.
  expect(conflictValues(rendered, "linkage_rule_set")).toEqual([
    conflicts[0].existing,
    conflicts[0].incoming,
  ]);
});

test("diffLinkageTerms: the structural-list fallback treats the JSON it falls back to", () => {
  // A sub-field difference under matching key names falls to the full JSON, and
  // that JSON carries the same chosen bytes the name-only rendering withheld --
  // a key element's transform params here -- so it takes the same treatment: a
  // marker planted inside the structure is replaced, and the whole is one
  // delimited run rather than loose text spelling the line's own clause.
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  incoming.linkageKeys[0].elements[0].transform = [
    {
      function: "noop",
      params: {
        note: "-----BEGIN OPENSSH PRIVATE KEY-----",
        forged: 'x vs required "y',
      },
    },
  ];
  const { conflicts } = diffLinkageTerms(existing, incoming);
  const keyConflict = conflicts.find((c) => c.field === "linkage_keys");
  expect(keyConflict).toBeDefined();
  expect(keyConflict?.incoming).toContain("elements");
  expect(keyConflict?.incoming).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  expect(keyConflict?.incoming).toContain("[redacted private key]");
  // The whole JSON is one run, so every delimiter inside it is doubled and none
  // of it can close the run or spell the conflict line's own clause.
  expect(keyConflict?.incoming.startsWith('"')).toBe(true);
  expect(keyConflict?.incoming.endsWith('"')).toBe(true);
  expect(keyConflict?.incoming).not.toContain('x vs required "y');
});

test("diffLinkageTerms: a private-key marker in a citation cannot truncate the accept error", () => {
  // The display boundary's private-key rule is fail-closed past a BEGIN marker
  // carrying no END: it replaces to the end of the link it appears in. The
  // partner picks the invitation's set names, so a citation interpolated raw
  // would let one of them consume every conflict line and the recovery step
  // composed behind it -- the operator would see an abort with no diff and no
  // way forward. Redacting the halves where they are interpolated bounds the
  // rule to the fragment that carried the marker.
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  existing.linkageRuleSet = {
    fieldSet: { name: "baseline-pii", version: "1.0.0" },
    keySet: { name: "hmis-keys", version: "1.0.0" },
  };
  incoming.linkageRuleSet = {
    fieldSet: { name: "-----BEGIN OPENSSH PRIVATE KEY-----", version: "1.0.0" },
    keySet: { name: "hmis-keys", version: "1.0.0" },
  };
  // A second conflict, so the message carries a diff line AFTER the citation's.
  incoming.legalAgreement = {
    reference: "MOU-2025-0042",
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2030-01-01",
  };
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts.map((c) => c.field)).toEqual([
    "linkage_rule_set",
    "legal_agreement",
  ]);

  const rendered = renderedAcceptReconcileError(conflicts);
  expect(rendered).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  expect(rendered).toContain("[redacted private key]");
  expect(rendered).toContain("legal_agreement");
  expect(rendered).toContain("MOU-2025-0042");
  expect(rendered).toContain("then retry with the same invitation.");
});

// The two sides one field's conflict line renders, read out of the composed
// refusal: what the operator is shown for that field once the fit has run. The
// message is read AFTER the display boundary, which rewrites the line breaks the
// block is built from to their visible escape, so its lines are separated by that
// escape rather than by a control character.
function conflictValues(rendered: string, field: string): string[] {
  const prefix = `  - ${field}: existing `;
  const line = rendered.split("\\x0a").find((l) => l.startsWith(prefix));
  expect(line, field).toBeDefined();
  const sides = line!.slice(prefix.length).split(" vs required ");
  expect(sides, field).toHaveLength(2);
  return sides;
}

test("diffLinkageTerms: citation values at the schema's length cannot truncate the accept error", () => {
  // Every value in a citation is text the partner chose, bounded by the schema
  // in CODE POINTS, which is not a display bound: one code point escapes to as
  // many as ten characters at the display boundary, so a name at the schema's
  // maximum can render past the whole budget the renderer gives this one link --
  // eating the conflict lines behind the citation's and the retry step the
  // operator has to act on, with no marker or delimiter involved at all.
  //
  // Driven at that maximum on BOTH sides, over the widest-rendering shapes the
  // schema admits, and in the two forms fitting the values can produce: a pair
  // the fitted clauses still tell apart, and a pair differing only inside what
  // the fit dropped.
  const longSemver = `1.0.${"9".repeat(MAX_NAME_LENGTH - 4)}`;
  expect(longSemver).toHaveLength(MAX_NAME_LENGTH);
  const vectors = schemaMaximalNames();
  const replacingFirst = (value: string): string =>
    ["a", ...Array.from(value).slice(1)].join("");
  const replacingLast = (value: string): string =>
    [...Array.from(value).slice(0, -1), "a"].join("");

  for (const vector of vectors) {
    for (const differing of [replacingFirst, replacingLast]) {
      const citation = (name: string): LinkageRuleSetReference => ({
        fieldSet: { name, version: longSemver },
        keySet: { name, version: longSemver },
      });
      const existing = cloneTerms(getDefaultLinkageTerms("Org"));
      const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
      existing.linkageRuleSet = citation(vector);
      incoming.linkageRuleSet = citation(differing(vector));
      // A second conflict, so the message carries a diff line AFTER the
      // citation's, and the legal agreement is what an operator reads next.
      incoming.legalAgreement = {
        reference: "MOU-2025-0042",
        purpose: "Audit and evaluation of the State tutoring program",
        expirationDate: "2030-01-01",
      };
      const { conflicts } = diffLinkageTerms(existing, incoming);
      expect(conflicts.map((c) => c.field)).toEqual([
        "linkage_rule_set",
        "legal_agreement",
      ]);

      const rendered = renderedAcceptReconcileError(conflicts);
      // Under the renderer's own cap, which is what says nothing was cut: the
      // boundary truncates a link that runs past it and appends the marker on
      // top, so a message this length is one it delivered whole.
      expect(rendered.length).toBeLessThanOrEqual(
        COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
      );
      expect(rendered).toContain("legal_agreement");
      expect(rendered).toContain("MOU-2025-0042");
      expect(rendered).toContain("then retry with the same invitation.");
      // The values were fitted rather than dropped: the operator is told a
      // citation value was cut, and the conflict line is still there.
      expect(rendered).toContain(DISPLAY_TRUNCATION_MARKER);
      expect(rendered).toContain("linkage_rule_set");
      // The clause structure survives the fit on BOTH sides, driven at the
      // schema's maximum on both: each side is still a key-set name and version,
      // the connective, and the field-set name and version, however little of
      // each value the share left. A slot spent left to right on the first value
      // deletes everything behind it -- the version, the connective, and the
      // whole field-set half -- and fails here.
      const sides = conflictValues(rendered, "linkage_rule_set");
      expect(sides).toHaveLength(2);
      for (const side of sides) {
        const halves = side.split(" over ");
        expect(halves).toHaveLength(2);
        for (const half of halves) {
          const values = half.split(" ");
          expect(values).toHaveLength(2);
          // Each value opened a delimited run of its own rather than being cut
          // away to the marker alone.
          for (const value of values) expect(value.startsWith('"')).toBe(true);
        }
      }
      // A pair the fit cannot tell apart says so, rather than leaving the
      // operator two sides that read alike with no account of why.
      if (differing === replacingLast) {
        expect(sides[0]).toBe(sides[1]);
        expect(rendered).toContain(
          "two sides that read alike differ only inside what this display withheld",
        );
      }
    }
  }
});

test("diffLinkageTerms: a legal-agreement reference at the schema's length keeps the expiry", () => {
  // The reference is partner-chosen text the schema bounds in UTF-16 units,
  // which is not a display bound, so a reference at that bound outspends the
  // line's whole slot on its own. Spent left to right it takes all of it and
  // what the clip deletes is the clause behind it: the operator is left a cut
  // reference on a line whose two sides differ in the expiry it no longer
  // names, and no reading of the difference at all. Driven at the bound on both
  // sides, over every shape the schema admits.
  for (const vector of schemaMaximalNames()) {
    const existing = cloneTerms(getDefaultLinkageTerms("Org"));
    const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
    existing.legalAgreement = {
      reference: vector,
      purpose: "Audit and evaluation of the State tutoring program",
      expirationDate: "2030-01-01",
    };
    incoming.legalAgreement = {
      reference: vector,
      purpose: "Audit and evaluation of the State tutoring program",
      expirationDate: "2031-06-30",
    };
    // A citation at the same bound beside it, so the legal agreement is fitted
    // against a line competing for the block rather than holding it alone.
    existing.linkageRuleSet = {
      fieldSet: { name: vector, version: "1.0.0" },
      keySet: { name: vector, version: "1.0.0" },
    };
    incoming.linkageRuleSet = {
      fieldSet: { name: vector, version: "2.0.0" },
      keySet: { name: vector, version: "2.0.0" },
    };
    const { conflicts } = diffLinkageTerms(existing, incoming);
    expect(conflicts.map((c) => c.field)).toEqual([
      "linkage_rule_set",
      "legal_agreement",
    ]);

    const rendered = renderedAcceptReconcileError(conflicts);
    // Under the renderer's own cap, which is what says nothing was cut: the
    // boundary truncates a link that runs past it and appends the marker on
    // top, so a message this length is one it delivered whole.
    expect(rendered.length).toBeLessThanOrEqual(
      COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
    );
    expect(rendered).toContain("then retry with the same invitation.");
    // The reference was fitted rather than dropped, and the expiry -- the half
    // of this line the two sides actually differ in, and the half an operator
    // can check against their own copy -- survives the fit on both sides.
    expect(rendered).toContain(DISPLAY_TRUNCATION_MARKER);
    const sides = conflictValues(rendered, "legal_agreement");
    expect(sides).toHaveLength(2);
    expect(sides[0].endsWith("(expires 2030-01-01)")).toBe(true);
    expect(sides[1].endsWith("(expires 2031-06-30)")).toBe(true);
    // The reference opened a delimited run of its own rather than being cut
    // away to the marker alone.
    for (const side of sides) expect(side.startsWith('"')).toBe(true);
  }
});

test("diffLinkageTerms: a citation both sides redact away is reported as withheld", () => {
  // Reaching this takes a marker on BOTH sides, so the config the operator holds
  // carries one too. The two names redact to the same replacement, the clause
  // forms match, and the full-detail fallback -- built from those same redacted
  // values -- matches as well: every byte that differs is a byte the display
  // will not show. Saying so is the only honest reading left.
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  existing.linkageRuleSet = {
    fieldSet: { name: "-----BEGIN OPENSSH PRIVATE KEY-----", version: "1.0.0" },
    keySet: { name: "hmis-keys", version: "1.0.0" },
  };
  incoming.linkageRuleSet = {
    fieldSet: { name: "-----BEGIN RSA PRIVATE KEY-----", version: "1.0.0" },
    keySet: { name: "hmis-keys", version: "1.0.0" },
  };
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts).toHaveLength(1);
  // Both sides come out of the treatment byte-identical: the clause forms match
  // once the names are replaced, and the full-detail fallback built from the
  // same values matches too.
  expect(conflicts[0].existing).toBe(conflicts[0].incoming);

  const rendered = renderedAcceptReconcileError(conflicts);
  expect(rendered).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  expect(rendered).not.toContain("BEGIN RSA PRIVATE KEY");
  // Both sides are shown as they fitted, with one line for the block accounting
  // for why they read alike: what the two share is everything the display can
  // still tell the operator about the citation, so neither side is replaced.
  const sides = conflictValues(rendered, "linkage_rule_set");
  expect(sides[0]).toBe(sides[1]);
  expect(sides[0]).toContain("[redacted private key]");
  expect(sides[0]).toContain('"hmis-keys" 1.0.0 over ');
  expect(rendered).toContain(
    "two sides that read alike differ only inside what this display withheld",
  );
  expect(rendered).toContain("redacted");
  expect(rendered).toContain("then retry with the same invitation.");
});

// The widest a schema-bounded value can render at the display boundary. The
// bound counts UTF-16 units, and what the boundary spends per unit peaks on a
// BMP code point at or above U+0100: it escapes to `\uHHHH`, six characters for
// the one unit it costs. An astral code point escapes wider per CODE POINT (ten
// characters at most) but spends two units, so it buys five per unit, and a
// `\xHH` escape four. Six per unit is therefore the widest the schema admits.
const widestAtSchemaBound = (units: number): string => "\u0100".repeat(units);

// A second value of the same rendered width, differing in one unit. A fixture
// driving BOTH sides of a comparison at the schema's widest needs two of them:
// one value on both sides is no disagreement at all, so the conflict the fixture
// exists to raise would not be raised.
const otherWidestAtSchemaBound = (units: number): string =>
  `${widestAtSchemaBound(units - 1)}\u0101`;

// A citation version at the schema's bound. The bound is the one that holds a
// name (MAX_NAME_LENGTH), but the shape is a semver, so the widest such a value
// can render is that many ASCII digits and dots -- past the ceiling core renders
// a value undelimited under, so it arrives as a delimited run of its own and is
// fitted like any other value rather than standing in the clause as prose.
const schemaMaximalSemver = (major: number): string =>
  `${major}.0.${"9".repeat(MAX_NAME_LENGTH - `${major}.0.`.length)}`;

// A name at the schema's bound in each shape a value's rendered cost can take,
// for the fits driven at their worst case. A function declaration so a test
// composed above the helper it is built from can still call it.
function schemaMaximalNames(): string[] {
  return [
    // The widest the schema admits: six rendered characters per unit.
    widestAtSchemaBound(MAX_NAME_LENGTH),
    // A code point that escapes to four characters, at the schema's maximum.
    "\u{00e9}".repeat(MAX_NAME_LENGTH),
    // An astral code point escapes to nine characters here (ten at the widest
    // of them) and costs two of the schema's units, so half the count is the
    // same bound.
    "\u{1f600}".repeat(MAX_NAME_LENGTH / 2),
    // Nothing to escape: the case where the raw length IS the rendered length.
    "x".repeat(MAX_NAME_LENGTH),
  ];
}

test("the worst-case fixture's values are the widest the schema admits", () => {
  // The helper's name, as a check rather than as its comment: every shape a
  // schema-bounded value can take, each built to the same UTF-16-unit bound the
  // schema counts, and none of them renders wider than the one the fixtures
  // drive. A fixture weakened to a narrower shape -- or an escape policy that
  // moves the peak elsewhere -- fails here.
  const units = MAX_NAME_LENGTH;
  const atBound = (unit: string): string =>
    unit.repeat(units / unit.length).slice(0, units);
  const alternatives = {
    // Escapes to `\u{1f600}`, nine characters over two units.
    astral: atBound("\u{1f600}"),
    // The widest astral escape, `\u{10ffff}`: ten characters over two units.
    widestAstral: atBound("\u{10ffff}"),
    // Escapes to `\xe9`, four characters over one unit.
    latin1: atBound("\u00e9"),
    // Doubled rather than escaped: two characters over one unit.
    backslash: atBound("\\"),
    // Printable ASCII passes through at its own width.
    ascii: atBound("x"),
  };
  const widest = renderedDisplayCost(widestAtSchemaBound(units));
  expect(widest).toBe(units * 6);
  // The second value of that width is that width, so a fixture driving both
  // sides at the bound drives both at the same one.
  expect(renderedDisplayCost(otherWidestAtSchemaBound(units))).toBe(widest);
  expect(otherWidestAtSchemaBound(units)).not.toBe(widestAtSchemaBound(units));
  for (const [shape, value] of Object.entries(alternatives)) {
    expect(value.length, shape).toBe(units);
    expect(renderedDisplayCost(value), shape).toBeLessThan(widest);
  }

  // A version is held to the same bound and to a semver shape, so the widest it
  // can be is that bound in digits -- and at that width core declines the bare
  // form, which is what makes it a delimited run the fit divides its share with.
  const semver = schemaMaximalSemver(1);
  expect(semver).toHaveLength(units);
  expect(renderedDisplayCost(bareTermsValue(semver))).toBe(units + 2);
});

// Two linkage-terms documents that disagree on EVERY field the reconcile
// compares, each disagreement carrying values at the widest the schema admits,
// plus the shapes that are hostile rather than merely wide: a name shaped like
// the display boundary's private-key marker, a name spelling the conflict line's
// own clause, and a payload description at the free-text bound.
function maximallyConflictingTerms(): {
  existing: LinkageTerms;
  incoming: LinkageTerms;
} {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));

  existing.version = "1.0.0";
  incoming.version = "2.0.0";
  existing.algorithm = "psi";
  incoming.algorithm = "psi-c";
  existing.linkageStrategy = "cascade";
  incoming.linkageStrategy = "single-pass";

  existing.linkageFields = [
    { name: widestAtSchemaBound(MAX_NAME_LENGTH), type: "ssn" },
  ];
  incoming.linkageFields = [
    { name: "-----BEGIN OPENSSH PRIVATE KEY-----", type: "ssn" },
    { name: 'forged" vs required "nothing', type: "ssn" },
  ];

  // The keys agree by name, so the conflict falls back to the full JSON of each
  // side -- which is where a value at the schema's width reaches this message.
  existing.linkageKeys[0].elements[0].field =
    widestAtSchemaBound(MAX_NAME_LENGTH);
  incoming.linkageKeys[0].elements[0].field =
    otherWidestAtSchemaBound(MAX_NAME_LENGTH);

  // Both names AND both versions at the schema's bound: a version's own shape
  // caps how wide it can render, but nothing holds it to the five characters a
  // released rule set carries, so the citation's four values are driven at what
  // each of them can actually claim on the slot.
  existing.linkageRuleSet = {
    fieldSet: {
      name: widestAtSchemaBound(MAX_NAME_LENGTH),
      version: schemaMaximalSemver(1),
    },
    keySet: {
      name: widestAtSchemaBound(MAX_NAME_LENGTH),
      version: schemaMaximalSemver(1),
    },
  };
  incoming.linkageRuleSet = {
    fieldSet: {
      name: otherWidestAtSchemaBound(MAX_NAME_LENGTH),
      version: schemaMaximalSemver(3),
    },
    keySet: {
      name: otherWidestAtSchemaBound(MAX_NAME_LENGTH),
      version: schemaMaximalSemver(3),
    },
  };

  existing.legalAgreement = {
    reference: widestAtSchemaBound(MAX_NAME_LENGTH),
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2030-01-01",
  };
  incoming.legalAgreement = {
    reference: otherWidestAtSchemaBound(MAX_NAME_LENGTH),
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2031-01-01",
  };

  existing.payload = { send: [{ name: "note", description: "short" }] };
  incoming.payload = {
    send: [{ name: "note", description: widestAtSchemaBound(MAX_TEXT_LENGTH) }],
  };

  return { existing, incoming };
}

// The connection block's own conflicts, which an online accept appends to the
// linkage-terms ones in the same message. Composed here rather than driven
// through diffConnectionAgainstTarget so this file can reach the widest count
// the two producers together can raise.
function connectionConflicts(): ReconcileDiff[] {
  return (
    [
      "connection.server.host",
      "connection.server.inbound_path",
      "connection.server.outbound_path",
    ] as const
  ).map((field) => ({
    field,
    existing: reconcileDiffValue("/saved/" + "s".repeat(240)),
    incoming: reconcileDiffValue("/required/" + "r".repeat(240)),
  }));
}

test("the reconcile refusal keeps its recovery step and names every field, at every fragment's worst case", () => {
  // The acceptance criterion this whole composition exists for: schema-maximal
  // and hostile values through every fragment AT ONCE -- both sides of the
  // citation, both legal-agreement references, both structural lists (which fall
  // to their full-JSON form), a payload description at the free-text bound, and
  // the connection locators -- and still the operator reads what to do and which
  // fields to go and look at.
  const { existing, incoming } = maximallyConflictingTerms();
  const { conflicts } = diffLinkageTerms(existing, incoming);
  const all = [...conflicts, ...connectionConflicts()];
  expect(all.map((d) => d.field)).toEqual([
    "version",
    "algorithm",
    "linkage_strategy",
    "linkage_fields",
    "linkage_keys",
    "linkage_rule_set",
    "legal_agreement",
    "payload",
    "connection.server.host",
    "connection.server.inbound_path",
    "connection.server.outbound_path",
  ]);

  for (const sources of [ACCEPT_RECONCILE_SOURCES, ONLINE_RECONCILE_SOURCES]) {
    const rendered = renderedAcceptReconcileError(all, sources);
    // Under the renderer's own cap, which is what says nothing was cut: the
    // boundary truncates a link that runs past it and appends the marker on
    // top, so a message this length is one it delivered whole.
    expect(rendered.length).toBeLessThanOrEqual(
      COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
    );
    // The step the operator has to act on, composed ahead of the detail so a
    // cut can only ever eat the detail.
    expect(rendered).toContain("Resolve the differences below");
    expect(rendered).toContain(`then retry with ${sources.retryWith}.`);
    // Every disagreeing field is named, whatever became of its values.
    for (const d of all) expect(rendered).toContain(d.field);
    // Nothing a partner chose survives whole enough to have spent the message:
    // the marker is replaced and the forged clause cannot be read as one.
    expect(rendered).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(rendered).not.toContain('forged" vs required "nothing');

    // Whatever degradation this lands in, the block says only what is so: the
    // notice explaining a field named without its values is shown exactly when
    // there is one, and a line that kept its values kept both of them, neither
    // cut back to a bare truncation marker.
    const lines = rendered.split("\\x0a").filter((l) => l.startsWith("  - "));
    expect(lines).toHaveLength(all.length);
    const namedAlone = lines.filter((l) => !l.includes(": existing "));
    expect(rendered.includes("too wide for the room")).toBe(
      namedAlone.length > 0,
    );
    for (const line of lines) {
      if (namedAlone.includes(line)) continue;
      expect(line).toContain(" vs required ");
      // A shown side opens on its value's OWN rendering -- a delimited run, a
      // list, the unset placeholder, a bare token opening on a digit -- and
      // never on the truncation marker. Reading the opening rather than
      // searching for the marker's text is what catches the shape a side given
      // less than it can read as comes to: the marker itself clipped, which is
      // not the marker's text and so passes any search for it.
      for (const side of line.split(": existing ")[1].split(" vs required "))
        expect(side.startsWith(DISPLAY_TRUNCATION_MARKER[0]), line).toBe(false);
    }
  }
});

test("the reconcile refusal shows values whenever the field count leaves room for them", () => {
  // The same worst-case values over the two conflicts the round that raised this
  // measured: a citation delta beside a legal-agreement one, both sides of both
  // at the schema's bound. Few enough fields that the room reaches every value,
  // which is what keeps a line named without its values the exception rather
  // than the reading every refusal degrades to.
  const { existing, incoming } = maximallyConflictingTerms();
  const pair = diffLinkageTerms(existing, incoming).conflicts.filter((d) =>
    ["linkage_rule_set", "legal_agreement"].includes(d.field),
  );
  expect(pair).toHaveLength(2);

  const rendered = renderedAcceptReconcileError(pair, ONLINE_RECONCILE_SOURCES);
  expect(rendered.length).toBeLessThanOrEqual(
    COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  );
  expect(rendered).toContain("then retry with the same URL and invitation.");
  // Both lines carry values rather than the field name alone, and the values
  // that fit are shown rather than dropped.
  expect(rendered).toContain("linkage_rule_set: existing ");
  expect(rendered).toContain("legal_agreement: existing ");
  expect(rendered).toContain(DISPLAY_TRUNCATION_MARKER);
  // Each side still reads as its whole clause: the citation's two halves around
  // the connective, and the legal agreement's expiry after its reference.
  for (const side of conflictValues(rendered, "linkage_rule_set"))
    expect(side.split(" over ")).toHaveLength(2);
  for (const side of conflictValues(rendered, "legal_agreement"))
    expect(side).toContain(" (expires ");
});

// The room the message's own copy leaves the diff block, read off the composer
// rather than restated: an empty diff list renders no block, so what the message
// costs then is its head.
function reconcileBlockRoom(sources: {
  configPath: string;
  against: string;
  retryWith: string;
}): number {
  return (
    COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH -
    renderedDisplayCost(reconcileConflictMessage({ ...sources, diffs: [] }))
  );
}

// Every field the reconcile compares, disagreeing at the ordinary width of its
// own field: what a kept config from a DIFFERENT exchange raises. Nothing here
// is wide, so nothing here needs constraining -- which is what the block has to
// see rather than counting the lines that carry it.
function ordinarilyConflictingTerms(): {
  existing: LinkageTerms;
  incoming: LinkageTerms;
} {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));

  existing.version = "1.0.0";
  incoming.version = "2.0.0";
  existing.algorithm = "psi";
  incoming.algorithm = "psi-c";
  existing.linkageStrategy = "cascade";
  incoming.linkageStrategy = "single-pass";

  existing.linkageFields = [{ name: "ssn", type: "ssn" }];
  incoming.linkageFields = [{ name: "last_name", type: "last_name" }];

  existing.linkageKeys = [{ name: "SSN", elements: [{ field: "ssn" }] }];
  incoming.linkageKeys = [{ name: "LN", elements: [{ field: "last_name" }] }];

  existing.linkageRuleSet = {
    fieldSet: { name: "baseline-pii", version: "1.0.0" },
    keySet: { name: "baseline-keys", version: "1.0.0" },
  };
  incoming.linkageRuleSet = {
    fieldSet: { name: "county-pii", version: "3.1.0" },
    keySet: { name: "county-keys", version: "3.1.0" },
  };

  existing.legalAgreement = {
    reference: "MOU-2025-0042",
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2030-01-01",
  };
  incoming.legalAgreement = {
    reference: "MOU-2026-0117",
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2031-06-30",
  };

  existing.payload = { send: [{ name: "note" }] };
  incoming.payload = { send: [{ name: "memo" }] };

  return { existing, incoming };
}

test("eight ordinary disagreements each carry both of their values", () => {
  // The count of disagreeing fields is not what decides whether their values
  // fit: these eight ask for so little between them that every one of them is
  // shown whole, and the block says nothing about withholding anything.
  const { existing, incoming } = ordinarilyConflictingTerms();
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts.map((d) => d.field)).toEqual([
    "version",
    "algorithm",
    "linkage_strategy",
    "linkage_fields",
    "linkage_keys",
    "linkage_rule_set",
    "legal_agreement",
    "payload",
  ]);

  const rendered = renderedAcceptReconcileError(
    conflicts,
    ONLINE_RECONCILE_SOURCES,
  );
  expect(rendered.length).toBeLessThanOrEqual(
    COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  );
  expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
  expect(rendered).not.toContain("too wide for the room");
  for (const d of conflicts) {
    expect(rendered).toContain(`${d.field}: existing `);
    expect(rendered).toContain(d.existing);
    expect(rendered).toContain(d.incoming);
  }
  expect(rendered).toContain(
    'linkage_rule_set: existing "baseline-keys" 1.0.0 over "baseline-pii" 1.0.0',
  );

  // What an equal split of the block's room would have handed every value slot,
  // whatever it needed. Every value above renders whole, so what the block costs
  // beyond them is the first-party skeleton their lines are named by, and the
  // rest of the room over the sixteen slots is that split's share. The widest
  // side asks for nearly twice it, so a block that shows all sixteen whole is
  // one that shared the room out by need: dividing it by the count cuts that
  // side -- and drops the share under what shows a value's own bytes at all,
  // which is what took the values off every line here.
  const room = reconcileBlockRoom(ONLINE_RECONCILE_SOURCES);
  const valueCost = conflicts.reduce(
    (total, d) =>
      total + renderedDisplayCost(d.existing) + renderedDisplayCost(d.incoming),
    0,
  );
  const equalShare = Math.floor(
    (room -
      (renderedDisplayCost(formatReconcileDiffs(conflicts, room)) -
        valueCost)) /
      (2 * conflicts.length),
  );
  const widest = Math.max(
    ...conflicts.flatMap((d) => [
      renderedDisplayCost(d.existing),
      renderedDisplayCost(d.incoming),
    ]),
  );
  expect(widest).toBeGreaterThan(equalShare);
});

test("a schema-maximal clause beside ordinary lines never renders as bare markers", () => {
  // The mid-range: few enough fields that the block has room, wide enough on
  // one of them that an equal share of that room cannot hold the citation's
  // four values. The room reaches the citation's line at both counts, so what
  // is read here is that LINE: each side still a name, its version, the
  // connective, and the second half of the pair, with some of every name's own
  // bytes inside its run -- never a column of truncation markers, and never a
  // half clause whose connective and second name the clip deleted.
  const { existing, incoming } = ordinarilyConflictingTerms();
  existing.linkageRuleSet = {
    fieldSet: { name: widestAtSchemaBound(MAX_NAME_LENGTH), version: "1.0.0" },
    keySet: { name: widestAtSchemaBound(MAX_NAME_LENGTH), version: "1.0.0" },
  };
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts).toHaveLength(8);

  for (const count of [6, 7]) {
    const rendered = renderedAcceptReconcileError(
      conflicts.slice(0, count),
      ONLINE_RECONCILE_SOURCES,
    );
    expect(rendered.length).toBeLessThanOrEqual(
      COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
    );
    // Read off the citation's own line, which the display boundary separates
    // from the lines around it by the escape of the break rather than by the
    // break itself.
    for (const side of conflictValues(rendered, "linkage_rule_set")) {
      const halves = side.split(" over ");
      // Both halves of the citation survive the fit, on both sides.
      expect(halves, `${count} conflicts`).toHaveLength(2);
      for (const half of halves) {
        // A name opening a delimited run of its own, with some of its own bytes
        // inside it rather than the marker alone, and its version behind it.
        expect(half.startsWith('"'), `${count} conflicts: ${half}`).toBe(true);
        expect(half, `${count} conflicts`).not.toContain(
          `"${DISPLAY_TRUNCATION_MARKER}`,
        );
        expect(half, `${count} conflicts`).toMatch(/ \d+\.\d+\.\d+$/);
      }
    }
    // Whatever the wide line came to, the lines beside it keep their values.
    expect(rendered).toContain('algorithm: existing "psi" vs required "psi-c"');
    expect(rendered).toContain(
      'linkage_strategy: existing "cascade" vs required "single-pass"',
    );
  }
});

// The smallest budget at which the block shows a line's values instead of naming
// the field alone -- read off the block by driving it, so what it reports is the
// floor the code actually applies rather than the floor arithmetic restated.
function smallestBudgetShowingValues(diff: ReconcileDiff): number {
  const ceiling =
    renderedDisplayCost(diff.existing) +
    renderedDisplayCost(diff.incoming) +
    64;
  for (let budget = 0; budget <= ceiling; budget += 1)
    if (formatReconcileDiffs([diff], budget).includes(": existing "))
      return budget;
  throw new Error("the block never showed the line's values");
}

test("a clause's floor charges a narrow value its width, not the floor", () => {
  // A value narrower than the per-value floor claims its OWN width, not the
  // floor: what a clause cannot go below is the room its wide values need for
  // some of their bytes plus the room its short ones need whole. So a citation
  // naming one wide set and one short one keeps its values at a budget a
  // citation of four wide values cannot -- charge every value the floor flat and
  // the two lines come to the same thing, and the short values are dropped over
  // room they were never going to spend.
  const wideName = "w".repeat(200);
  const wideVersion = schemaMaximalSemver(1);
  const lineFor = (
    existingCitation: LinkageRuleSetReference,
    incomingCitation: LinkageRuleSetReference,
  ): ReconcileDiff => {
    const existing = cloneTerms(getDefaultLinkageTerms("Org"));
    const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
    existing.linkageRuleSet = existingCitation;
    incoming.linkageRuleSet = incomingCitation;
    const { conflicts } = diffLinkageTerms(existing, incoming);
    expect(conflicts.map((d) => d.field)).toEqual(["linkage_rule_set"]);
    return conflicts[0];
  };
  const mixed = lineFor(
    {
      keySet: { name: wideName, version: "1.0.0" },
      fieldSet: { name: "ab", version: "2.0.0" },
    },
    {
      keySet: { name: `x${wideName.slice(1)}`, version: "1.0.0" },
      fieldSet: { name: "ab", version: "2.0.0" },
    },
  );
  const allWide = lineFor(
    {
      keySet: { name: wideName, version: wideVersion },
      fieldSet: { name: wideName, version: wideVersion },
    },
    {
      keySet: { name: `x${wideName.slice(1)}`, version: wideVersion },
      fieldSet: { name: wideName, version: wideVersion },
    },
  );

  const budget = smallestBudgetShowingValues(mixed);
  expect(budget).toBeLessThan(smallestBudgetShowingValues(allWide));
  // At that budget the short values are there whole -- the version behind each
  // name, and the field set's own name -- with only the wide name cut back to
  // some of its own bytes inside its run.
  const [existingSide, incomingSide] = formatReconcileDiffs([mixed], budget)
    .split(": existing ")[1]
    .split(" vs required ");
  for (const side of [existingSide, incomingSide]) {
    expect(side, side).toContain(` 1.0.0 over "ab" 2.0.0`);
    expect(side.startsWith('"'), side).toBe(true);
    expect(side, side).toContain(`w${DISPLAY_TRUNCATION_MARKER}"`);
  }
  expect(formatReconcileDiffs([allWide], budget)).not.toContain(": existing ");
});

// The two locators a split directory hint names, read out of the hint's own
// first-party sentence: what the operator is shown for each half of the pair the
// config holds, with the sentence's closing parenthesis off the second.
function splitHintLocators(hint: string): {
  inbound: string;
  outbound: string;
} {
  const [, named] = hint.split(" split inbound_path ");
  expect(named).toBeDefined();
  const [inbound, outbound] = named.split(", outbound_path ");
  expect(outbound).toBeDefined();
  expect(outbound.endsWith(")")).toBe(true);
  return { inbound, outbound: outbound.slice(0, -1) };
}

test("the directory-form hint keeps both halves of a split locator", () => {
  // The hint is first-party copy naming the locators the config holds in its
  // OTHER directory form, and both of those are the partner's -- the inviting
  // party's endpoint, copied into the config on an earlier acceptance. Spent
  // left to right the slot would go to the inbound path, deleting
  // `, outbound_path "..."` and the sentence's own closing: the operator left
  // with no account of the second half of the pair. Driven at a width the slot
  // holds whole and at one it cannot, so the fit is read both where nothing is
  // cut and where both locators are.
  const target: RunnableConnectionConfig = {
    channel: "filedrop",
    path: `/mnt/shared/${"r".repeat(53)}`,
  };
  const { existing: ordinaryExisting, incoming: ordinaryIncoming } =
    ordinarilyConflictingTerms();
  const beside = diffLinkageTerms(
    ordinaryExisting,
    ordinaryIncoming,
  ).conflicts.slice(0, 7);

  const hintAtWidth = (width: number): string => {
    const existing: ConnectionConfig = {
      channel: "filedrop",
      inboundPath: `/mnt/in/${"i".repeat(width)}`,
      outboundPath: `/mnt/out/${"o".repeat(width)}`,
    };
    const { conflicts } = diffConnectionAgainstTarget(existing, target);
    expect(conflicts.map((c) => c.field)).toEqual(["connection.path"]);
    const rendered = renderedAcceptReconcileError(
      [...beside, ...conflicts],
      ONLINE_RECONCILE_SOURCES,
    );
    expect(rendered.length).toBeLessThanOrEqual(
      COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
    );
    return conflictValues(rendered, "connection.path")[0];
  };

  // Narrow enough for the slot: both locators arrive byte-complete inside runs
  // the fit closed, and nothing on the line is marked cut.
  const fitting = 20;
  const whole = splitHintLocators(hintAtWidth(fitting));
  expect(whole.inbound).toBe(`"/mnt/in/${"i".repeat(fitting)}"`);
  expect(whole.outbound).toBe(`"/mnt/out/${"o".repeat(fitting)}"`);
  expect(whole.inbound + whole.outbound).not.toContain(
    DISPLAY_TRUNCATION_MARKER,
  );

  // Past it: the sentence still names both halves and still closes, and each
  // locator degrades INSIDE its own run -- some of its own bytes, then the
  // marker, then the delimiter the fit closed the cut run with, so the sentence
  // around it reads at the parity it was composed at rather than at the one the
  // cut left.
  const cut = splitHintLocators(hintAtWidth(250));
  for (const [half, opening] of [
    [cut.inbound, '"/mnt/in/i'],
    [cut.outbound, '"/mnt/out/o'],
  ] as const) {
    expect(half.startsWith(opening), half).toBe(true);
    expect(half.endsWith(`${DISPLAY_TRUNCATION_MARKER}"`), half).toBe(true);
  }
});

test("an ordinary reconcile refusal is delivered whole, with nothing truncated", () => {
  // The residual under the arithmetic above: each first-party span fits its
  // budget by measurement, not by construction, so copy that grew past the cap
  // would put the cap back on the operator's text. Driven at the sizes a real
  // run carries, no part of this message is cut at all -- so growing the copy,
  // or a fragment's ordinary width, fails here rather than silently deleting
  // the next step.
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  existing.algorithm = "psi-c";
  incoming.algorithm = "psi";
  existing.legalAgreement = {
    reference: "MOU-2025-0042",
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2030-01-01",
  };
  incoming.legalAgreement = {
    reference: "MOU-2026-0117",
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2031-06-30",
  };
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts.map((d) => d.field)).toEqual([
    "algorithm",
    "legal_agreement",
  ]);

  const rendered = renderedAcceptReconcileError(
    conflicts,
    ONLINE_RECONCILE_SOURCES,
  );
  expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
  expect(rendered.length).toBeLessThan(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH);
  expect(rendered).toContain('existing "psi-c" vs required "psi"');
  expect(rendered).toContain('"MOU-2025-0042" (expires 2030-01-01)');
  expect(rendered).toContain('"MOU-2026-0117" (expires 2031-06-30)');
  expect(rendered).toContain(
    "Resolve the differences below (or pass --config-file to write elsewhere)",
  );
});

test("a linkage field name shaped like a private-key marker cannot swallow the refusal", () => {
  // The display boundary's private-key rule is fail-closed past a BEGIN marker
  // carrying no END: it replaces from the marker to the end of the link, and
  // this whole refusal is one link. A marker in a name the partner chose would
  // otherwise take every conflict line composed behind it.
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  existing.linkageFields = [{ name: "ssn", type: "ssn" }];
  incoming.linkageFields = [
    { name: "-----BEGIN OPENSSH PRIVATE KEY-----", type: "ssn" },
  ];
  incoming.legalAgreement = {
    reference: "MOU-2025-0042",
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2030-01-01",
  };
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts.map((d) => d.field)).toContain("linkage_fields");
  expect(conflicts.map((d) => d.field)).toContain("legal_agreement");

  const rendered = renderedAcceptReconcileError(conflicts);
  expect(rendered).not.toContain("BEGIN OPENSSH PRIVATE KEY");
  expect(rendered).toContain("[redacted private key]");
  // Everything composed behind the marker survives it.
  expect(rendered).toContain("legal_agreement");
  expect(rendered).toContain("MOU-2025-0042");
  expect(rendered).toContain("then retry with the same invitation.");
});

test("a payload description at the free-text bound cannot crowd out the refusal", () => {
  // The description is never rendered by the name-only payload summary, so it
  // reaches the message only through the full-JSON fallback -- which is exactly
  // where a value bounded by the schema in code points and by nothing at the
  // display boundary can spend a whole link.
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  existing.payload = { send: [{ name: "note", description: "short" }] };
  incoming.payload = {
    send: [{ name: "note", description: widestAtSchemaBound(MAX_TEXT_LENGTH) }],
  };
  incoming.legalAgreement = {
    reference: "MOU-2025-0042",
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2030-01-01",
  };
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts.map((d) => d.field)).toEqual(["legal_agreement", "payload"]);

  const rendered = renderedAcceptReconcileError(conflicts);
  expect(rendered.length).toBeLessThanOrEqual(
    COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  );
  expect(rendered).toContain("payload");
  expect(rendered).toContain("MOU-2025-0042");
  expect(rendered).toContain("then retry with the same invitation.");
});

test("a partner-chosen value cannot forge a conflict line's own structure", () => {
  // Each line is first-party prose an operator reads as psilink's own -- field,
  // then `existing X vs required Y` -- and a value spelling that clause is
  // printable ASCII throughout, so nothing at the display boundary rewrites it.
  // Delimiting is what answers it, and the doubling grammar is what makes the
  // delimiting hold: a value carrying a delimiter of its own cannot close the
  // run it sits in.
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  existing.linkageFields = [{ name: "ssn", type: "ssn" }];
  incoming.linkageFields = [
    { name: 'ssn" vs required "nothing_to_see_here', type: "ssn" },
    { name: "a, b", type: "ssn" },
  ];
  const { conflicts } = diffLinkageTerms(existing, incoming);
  const fields = conflicts.find((d) => d.field === "linkage_fields");
  expect(fields).toBeDefined();
  // The forged clause is not reproduced: its delimiter is doubled, so the run
  // carries it as content.
  expect(fields?.incoming).not.toContain('ssn" vs required "nothing');
  expect(fields?.incoming).toContain('ssn"" vs required ""nothing');
  // One entry named `a, b` renders as one run, not as the two the list
  // separator would otherwise suggest -- the same partition the byte-exact
  // comparison used to decide the conflict.
  expect(fields?.incoming).toContain('"a, b"');

  const rendered = renderedAcceptReconcileError(conflicts);
  expect(rendered).toContain("then retry with the same invitation.");
});

// One line's CLAUSE SKELETON under the grammar `quoteTermsValue` emits: outside
// a run every character stands for itself, inside one a doubled delimiter is a
// literal and a single delimiter closes the run, and each run collapses to one
// placeholder. Two renderings that differ only in the bytes inside their runs
// therefore have the same skeleton, which is the precise statement that no value
// was shown to the operator as structure psilink wrote.
//
// The same walk core reads its own seam's messages back through
// (`packages/core/test/utils/compatibilityMessageReader.ts`), restated here
// because apps/cli's tsconfig cannot reach another workspace's test tree. What
// keeps the two walking the same grammar is that the grammar itself is pinned
// against the constructor below, in each suite that walks it.
function clauseSkeleton(line: string): string {
  let skeleton = "";
  let index = 0;
  while (index < line.length) {
    if (line[index] !== '"') {
      skeleton += line[index];
      index += 1;
      continue;
    }
    index += 1;
    let closed = false;
    while (index < line.length) {
      if (line[index] === '"') {
        if (line[index + 1] === '"') {
          index += 2;
          continue;
        }
        index += 1;
        closed = true;
        break;
      }
      index += 1;
    }
    skeleton += closed ? "<value>" : "<unterminated>";
  }
  return skeleton;
}

// The skeleton of a block, read LINE BY LINE: a run is composed inside one line,
// so a run still open where a line ends is one the operator meets unterminated --
// and a walk over the joined block would hide it, closing it on the next line's
// opening delimiter instead.
function blockSkeleton(block: string, lineBreak: string): string {
  return block.split(lineBreak).map(clauseSkeleton).join(lineBreak);
}

// What a value costs the block when it is rendered as one delimited run: the
// seam doubles a delimiter inside a value, so a raw character is not a rendered
// one and the widths the block allocates by have to be measured through it.
const quotedCost = (raw: string): number =>
  renderedDisplayCost(quoteTermsValue(raw));

// The spans a conflict line is composed OF, each carried beside a delimiter of
// the value's own: the field's `: existing `, the two sides' ` vs required `,
// the citation clause's ` over ` and a version-shaped token to stand before it,
// the legal agreement's `(expires ` and the date it closes on, and the name
// list's separator and brackets.
//
// Three of them carry the block's structure ONE LEVEL UP, which is a control
// character rather than a printable span: the line break between lines, the one
// a notice is introduced by, and a bare carriage return, each followed by the
// copy the block puts after its own. The whole refusal is escaped as one link,
// so a value's control character and the block's own reach the operator through
// the same boundary, and a unit that spells a line is what makes the sweep's
// skeleton comparison measure that.
//
// The first is an adjacent run of the SHAPES the seam's markers are cut back to,
// spelled in the value's own printable bytes: a cut anywhere in it lands beside
// one, which is what a back-off walked over a run rather than over the cut's own
// marker would erase. It leads the units so every value carries it, at the
// offsets the narrowest budgets cut. Its shape is a prefix of a marker the block
// never places here -- no unit carries a U+007F -- so the fragment check below
// stays a statement about markers the treatment put in the value.
const FORGED_LINE_UNITS = [
  '"<7<7<7"',
  '": existing "',
  '" vs required "',
  '" over 9.9.9"',
  '" (expires 2030-01-01)"',
  '","',
  '"],["',
  '"\n  - forged_field: existing "',
  '"\n  (a field named above without its values"',
  '"\r  - forged_field"',
];

// A value of exactly `cost` rendered characters, opening on `lead`. Built out of
// the units above, so the value both carries the seam's delimiter throughout --
// a cut anywhere inside it lands at or beside a doubled pair -- and spells the
// connectives and punctuation of the line it is placed in, which is what a
// partner sizing a value to place the cut has to work with. Units are laid down
// while any of them still fits, so the padding that lands the exact width is
// shorter than the shortest of them.
const delimiterCarryingValue = (cost: number, lead: string): string => {
  let raw = lead;
  let index = 0;
  let stalled = 0;
  while (stalled < FORGED_LINE_UNITS.length) {
    const unit = FORGED_LINE_UNITS[index % FORGED_LINE_UNITS.length];
    index += 1;
    if (quotedCost(`${raw}${unit}`) > cost) {
      stalled += 1;
      continue;
    }
    raw += unit;
    stalled = 0;
  }
  while (quotedCost(raw) < cost) raw += "x";
  expect(quotedCost(raw)).toBe(cost);
  return raw;
};

// The inert twin of the same rendered width: nothing to forge with, so what the
// block composes around it is the structure the composition placed and nothing
// else. Same width means the same slot, the same share, and the same cut.
const inertValue = (cost: number, lead: string): string => {
  const raw = lead + "x".repeat(cost - quotedCost(lead));
  expect(quotedCost(raw)).toBe(cost);
  return raw;
};

// The same width spelled END TO END in the shape a marker is cut back to, so a
// cut at ANY offset lands beside one rather than at the offsets the units above
// happen to place. What this measures against the inert twin of the same width
// is the back-off's reach: taken over a run of the shapes rather than over the
// cut's own marker, it deletes the value's own bytes without bound.
const markerShapedValue = (cost: number, lead: string): string => {
  let raw = lead;
  while (quotedCost(`${raw}<7`) <= cost) raw += "<7";
  while (quotedCost(raw) < cost) raw += "x";
  expect(quotedCost(raw)).toBe(cost);
  return raw;
};

// A fragment of the seam's marker left standing where a cut fell, read off the
// markers the units above are treated into rather than restated: the marker is
// four printable characters put where a value's control character was, so a cut
// inside one shows the operator neither the character it names nor the value's
// own bytes.
const MARKER_FRAGMENTS = ["\n", "\r"].flatMap((character) => {
  const marker = controlCharacterMarker(character.codePointAt(0)!);
  return Array.from({ length: marker.length - 1 }, (_unused, index) =>
    marker.slice(0, index + 1),
  );
});

// The back-off to before a marker's opening `<`, read off a marker rather than
// restated: what a cut landing inside one costs the value it cut.
const MARKER_BACK_OFF = controlCharacterMarker("\n".codePointAt(0)!).length - 1;

// The most a cut may cost a value against inert bytes of the same width: that
// back-off, plus the one character a cut that would fall between the two halves
// of a doubled delimiter leaves unspent. Both are bounded per cut, which is the
// property a back-off taken over a RUN of marker shapes does not have.
const MAX_UNDERSHOOT_PER_CUT = MARKER_BACK_OFF + 1;

const cutsIn = (rendered: string): number =>
  rendered.split(DISPLAY_TRUNCATION_MARKER).length - 1;

// Every place in `rendered` where a cut left one, which is the text a truncation
// marker directly follows.
const fragmentsBeforeCuts = (rendered: string): string[] =>
  rendered
    .split(DISPLAY_TRUNCATION_MARKER)
    .slice(0, -1)
    .flatMap((before) =>
      MARKER_FRAGMENTS.filter((fragment) => before.endsWith(fragment)),
    );

// Terms disagreeing on the shapes a cut can fall in: a delimited name list, a
// clause of four values, and a clause whose first value is followed by first-
// party copy and a bare date. Each value is built by `value`, wide enough that
// the budgets below cut it, and every side opens on a character of its own so
// two fitted sides never read alike.
function parityTerms(
  value: (cost: number, lead: string) => string,
  scale = 1,
): {
  existing: LinkageTerms;
  incoming: LinkageTerms;
} {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  existing.linkageFields = [{ name: value(60 * scale, "a"), type: "ssn" }];
  incoming.linkageFields = [{ name: value(60 * scale, "b"), type: "ssn" }];
  existing.linkageRuleSet = {
    keySet: { name: value(80 * scale, "c"), version: "1.0.0" },
    fieldSet: { name: value(80 * scale, "d"), version: "2.0.0" },
  };
  incoming.linkageRuleSet = {
    keySet: { name: value(80 * scale, "e"), version: "1.0.0" },
    fieldSet: { name: value(80 * scale, "f"), version: "2.0.0" },
  };
  existing.legalAgreement = {
    reference: value(70 * scale, "g"),
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2030-01-01",
  };
  incoming.legalAgreement = {
    reference: value(70 * scale, "h"),
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2031-06-30",
  };
  return { existing, incoming };
}

test("a fitted conflict line's runs are the runs the block composed, at every budget", () => {
  // The seam's guarantee has to survive the FIT, which is where a value the
  // partner sized decides where the cut falls. Read back as a clause skeleton: a
  // rendering whose values carry the line's connectives and the seam's delimiter
  // must give the same skeleton as one whose values carry nothing at all, and no
  // run may be left open for what follows it on the line to be read inside.
  //
  // The grammar both the fit and that walk assume, pinned here rather than
  // taken on the constructor's word: one delimiter around a run, doubled inside
  // it.
  expect(quoteTermsValue("a")).toBe('"a"');
  expect(quoteTermsValue('"')).toBe('""""');

  // A locator conflict beside the linkage-terms ones, one side narrow enough to
  // render whole and the other wide enough to be cut: the cut then falls at the
  // END of a line, where a run it leaves open has no later delimiter of the
  // composition's to close it, and the line's delimiter count is odd.
  const locatorLine = (
    value: (cost: number, lead: string) => string,
  ): ReconcileDiff => ({
    field: "connection.server.host",
    existing: reconcileDiffValue(value(40, "i")),
    incoming: reconcileDiffValue(value(200, "j")),
  });
  const diffsFor = (
    value: (cost: number, lead: string) => string,
  ): ReconcileDiff[] => {
    const terms = parityTerms(value);
    return [
      ...diffLinkageTerms(terms.existing, terms.incoming).conflicts,
      locatorLine(value),
    ];
  };
  const hostileDiffs = diffsFor(delimiterCarryingValue);
  const shapedDiffs = diffsFor(markerShapedValue);
  const inertDiffs = diffsFor(inertValue);
  expect(hostileDiffs.map((d) => d.field)).toEqual([
    "linkage_fields",
    "linkage_rule_set",
    "legal_agreement",
    "connection.server.host",
  ]);

  // Every budget from nothing to the whole block's need, which is every position
  // the cut can take on any of these lines: the value widths that place it are
  // the partner's to choose, so the property is read across all of them rather
  // than at a width this file picked.
  const whole = formatReconcileDiffs(hostileDiffs, Number.MAX_SAFE_INTEGER);
  expect(whole).not.toContain(DISPLAY_TRUNCATION_MARKER);
  let sawCut = false;
  let sawNamedOnly = false;
  for (let budget = 0; budget <= renderedDisplayCost(whole); budget += 1) {
    const benign = formatReconcileDiffs(inertDiffs, budget);
    const where = `budget ${budget}`;
    for (const diffs of [hostileDiffs, shapedDiffs]) {
      const hostile = formatReconcileDiffs(diffs, budget);
      expect(blockSkeleton(hostile, "\n"), where).not.toContain(
        "<unterminated>",
      );
      expect(blockSkeleton(hostile, "\n"), where).toBe(
        blockSkeleton(benign, "\n"),
      );
      // The seam's markers are the other unit the cut may not fall inside: what
      // a fitted line carries of them is whole markers or none.
      expect(fragmentsBeforeCuts(hostile), where).toEqual([]);
      // And what that back-off costs is bounded per cut: the hostile block
      // renders what the inert one does, less what each of its cuts pays.
      expect(
        renderedDisplayCost(benign) - renderedDisplayCost(hostile),
        where,
      ).toBeLessThanOrEqual(MAX_UNDERSHOOT_PER_CUT * cutsIn(benign));
      sawCut ||= hostile.includes(DISPLAY_TRUNCATION_MARKER);
      sawNamedOnly ||= hostile.includes("too wide for the room");
    }
  }
  // Non-vacuous in both directions: the sweep covered budgets that cut a value
  // and budgets that left a line named without its values.
  expect(sawCut).toBe(true);
  expect(sawNamedOnly).toBe(true);

  // The same property where the operator meets it: through the whole refusal,
  // escaped at the display boundary, at value widths the message's own cap
  // cannot hold.
  const refusalAtWidth = (
    value: (cost: number, lead: string) => string,
  ): string => {
    const terms = parityTerms(value, 3);
    return renderedAcceptReconcileError(
      diffLinkageTerms(terms.existing, terms.incoming).conflicts,
    );
  };
  const benign = refusalAtWidth(inertValue);
  for (const value of [delimiterCarryingValue, markerShapedValue]) {
    const rendered = refusalAtWidth(value);
    expect(rendered).toContain(DISPLAY_TRUNCATION_MARKER);
    expect(fragmentsBeforeCuts(rendered)).toEqual([]);
    expect(blockSkeleton(rendered, "\\x0a")).not.toContain("<unterminated>");
    expect(blockSkeleton(rendered, "\\x0a")).toBe(
      blockSkeleton(benign, "\\x0a"),
    );
    expect(
      renderedDisplayCost(benign) - renderedDisplayCost(rendered),
    ).toBeLessThanOrEqual(MAX_UNDERSHOOT_PER_CUT * cutsIn(benign));
  }
});

test("a side spelling the marker's shape still renders its own bytes", () => {
  // A shown side reads as some of the value's own bytes -- that is what the
  // floor buys, and what a back-off walked over a RUN of marker shapes takes
  // away: the shapes are the partner's own printable text, so a side spelling
  // them end to end would render as punctuation and a truncation marker at a
  // budget that shows the same width of anything else. Driven through the real
  // block against the inert twin of the same width, which takes the same slot,
  // the same share, and the same cut.
  const conflictsNaming = (name: string, required: string): ReconcileDiff[] => {
    const existing = cloneTerms(getDefaultLinkageTerms("Org"));
    const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
    existing.linkageFields = [{ name, type: "ssn" }];
    incoming.linkageFields = [{ name: required, type: "ssn" }];
    const { conflicts } = diffLinkageTerms(existing, incoming);
    expect(conflicts.map((d) => d.field)).toEqual(["linkage_fields"]);
    return conflicts;
  };
  const shaped = conflictsNaming("<0".repeat(60), "<1".repeat(60));
  const inert = conflictsNaming("x".repeat(120), "y".repeat(120));
  // Each side's own bytes counted by the alphabet it is built out of, none of
  // which the first-party skeleton or the truncation marker spells.
  const alphabets = [
    ["<0", "<1"],
    ["x", "y"],
  ];
  const ownBytes = (line: string, alphabet: string[]): number[] =>
    line
      .split(": existing ")[1]
      .split(" vs required ")
      .map(
        (side, index) =>
          Array.from(side).filter((character) =>
            alphabet[index].includes(character),
          ).length,
      );

  let sawCut = false;
  const whole = formatReconcileDiffs(shaped, Number.MAX_SAFE_INTEGER);
  for (let budget = 0; budget <= renderedDisplayCost(whole); budget += 1) {
    const rendered = [shaped, inert].map((diffs) =>
      formatReconcileDiffs(diffs, budget),
    );
    const where = `budget ${budget}`;
    // What admits a line's values is the widths of its sides, which the two
    // share, so a budget shows them for both or for neither.
    expect(rendered[0].includes(": existing "), where).toBe(
      rendered[1].includes(": existing "),
    );
    if (!rendered[0].includes(": existing ")) continue;
    const [shapedSides, inertSides] = rendered.map((line, index) =>
      ownBytes(line, alphabets[index]),
    );
    for (let side = 0; side < shapedSides.length; side += 1) {
      expect(shapedSides[side], where).toBeGreaterThan(0);
      expect(shapedSides[side], where).toBeGreaterThanOrEqual(
        inertSides[side] - MARKER_BACK_OFF,
      );
    }
    sawCut ||= rendered[0].includes(DISPLAY_TRUNCATION_MARKER);
  }
  // Non-vacuous: the sweep covered budgets that cut the shaped value.
  expect(sawCut).toBe(true);
});

test("a value's control characters cannot render as a line of the block's own", () => {
  // The block's structure one level above its clauses. Its lines are separated
  // by a `\n` and the whole refusal is escaped as ONE link, so the separator
  // reaches the operator as the escape's token for a line break -- the same
  // token a value's own line break would reach them as, with no delimiter or
  // doubling between the two readings. What the treatment at the seam buys is
  // that the token is the block's alone.
  //
  // Driven at a width the message holds whole, so nothing here rests on a cut.
  const lineOfItsOwn =
    '\n  - linkage_keys: existing "a" vs required "b"\n  - connection.server.host';
  const refusalNaming = (name: string): string => {
    const existing = cloneTerms(getDefaultLinkageTerms("Org"));
    const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
    existing.linkageFields = [{ name: "given_name", type: "first_name" }];
    incoming.linkageFields = [{ name, type: "first_name" }];
    return renderedAcceptReconcileError(
      diffLinkageTerms(existing, incoming).conflicts,
    );
  };
  const hostile = refusalNaming(`given_name${lineOfItsOwn}`);
  // The inert twin is the same name with the control characters taken out, which
  // is the count of lines this refusal is: one conflict line, on the one field
  // that disagrees.
  const inert = refusalNaming(`given_name${lineOfItsOwn.replaceAll("\n", "")}`);
  const separator = sanitizeForDisplay("\n");
  expect(hostile).not.toContain(DISPLAY_TRUNCATION_MARKER);
  expect(hostile.split(separator)).toHaveLength(inert.split(separator).length);
  // Said the other way, over what the operator actually reads: no line of the
  // rendered refusal is a field the block never named.
  for (const line of hostile.split(separator))
    expect(line.startsWith("  - linkage_keys")).toBe(false);
  // Non-vacuous: the name reached the message whole, carrying the copy it was
  // built to forge a line out of -- inside the run the block composed for it.
  expect(hostile).toContain("  - linkage_fields: existing ");
  expect(hostile).toContain("connection.server.host");
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
  // The reconcile walk's own depth guard, exercised directly. A real invitation's
  // deep params is rejected earlier, at the decode chokepoint (the camelize fold
  // bounds it -- see the decode-side test in core's invitation.test.ts), so the
  // reconcile does not see one in practice. This builds the 3000-deep value
  // straight into the reconcile input (bypassing decode) to pin that backstop: it
  // is an independent recursion that must reject a deep value itself rather than
  // trust its caller to have pre-bounded it. Build it iteratively so the test does
  // not recurse.
  let deep: Record<string, unknown> = { leaf: "x" };
  for (let i = 0; i < 3000; i++) deep = { a: deep };
  incoming.linkageKeys[0].elements[0].transform = [
    { function: "noop", params: deep },
  ];
  // The depth guard fires as a clean NestingDepthExceededError (a UsageError ->
  // CLI exit 64) at depth 256, before the walk overflows the call stack with an
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

test("diffLinkageTerms: each name-carrying field agrees, differs, and refuses a normalization twin", () => {
  // One logical name in the two Unicode normalization forms -- NFC "e-acute"
  // (U+00E9) against the NFD decomposition "e" + U+0301 -- carried through each
  // agreement-defining field that holds authored text (the rule-set citation,
  // the fifth, has its own pair of tests above). Canonically equivalent and
  // different bytes, which is the whole of the case: core compares each of these
  // values byte-exact, so a twin pair aborts the exchange mid-run, and folding
  // the two forms together here would report the reuse clean and let the run
  // reach that abort with the partner keeping the invitation's spelling.
  const composed = "acc\u00e9s";
  const decomposed = "acce\u0301s";
  expect(composed).not.toBe(decomposed);

  const vectors: ReadonlyArray<{
    field: string;
    coreError: string;
    withName: (terms: LinkageTerms, value: string) => void;
  }> = [
    {
      field: "linkage_fields",
      coreError: "linkage fields do not match",
      withName: (terms, value) => {
        terms.linkageFields = [
          ...terms.linkageFields,
          { ...structuredClone(terms.linkageFields[0]), name: value },
        ];
      },
    },
    {
      field: "linkage_keys",
      coreError: "linkage keys do not match",
      withName: (terms, value) => {
        terms.linkageKeys[0].name = value;
      },
    },
    {
      field: "legal_agreement",
      coreError: "legal agreement reference mismatch",
      withName: (terms, value) => {
        terms.legalAgreement = {
          reference: value,
          purpose: "Audit and evaluation of the State tutoring program",
          expirationDate: "2030-01-01",
        };
      },
    },
    {
      field: "payload",
      coreError: "payload mismatch",
      withName: (terms, value) => {
        terms.payload = { send: [{ name: value }], receive: [{ name: value }] };
      },
    },
  ];

  for (const vector of vectors) {
    const naming = (value: string): LinkageTerms => {
      const terms = cloneTerms(getDefaultLinkageTerms("Org"));
      vector.withName(terms, value);
      return terms;
    };

    const agreeing = diffLinkageTerms(naming(composed), naming(composed));
    expect(agreeing.conflicts, vector.field).toEqual([]);
    expect(agreeing.warnings, vector.field).toEqual([]);
    // The shape the vector builds is compatible on its own, so a conflict below
    // is the value the two sides carry rather than the shape around it.
    expect(
      validateCompatibility(naming(composed), naming(composed)).errors,
      vector.field,
    ).toEqual([]);

    const differing = diffLinkageTerms(naming("alpha-set"), naming("beta-set"));
    expect(
      differing.conflicts.map((c) => c.field),
      vector.field,
    ).toEqual([vector.field]);

    const existing = naming(composed);
    const incoming = naming(decomposed);
    const twins = diffLinkageTerms(existing, incoming);
    expect(
      twins.conflicts.map((c) => c.field),
      vector.field,
    ).toEqual([vector.field]);
    // The same pair through core's own comparison, so the parity this compare
    // exists for is asserted against core rather than restated here.
    expect(
      validateCompatibility(existing, incoming).errors.some((e) =>
        e.includes(vector.coreError),
      ),
      vector.field,
    ).toBe(true);
  }
});

test("diffLinkageTerms: a normalization twin is shown as the code points that differ", () => {
  // A twin pair prints the same glyphs, so the two sides of its conflict line
  // read alike as raw text. They are told apart at the boundary the accept error
  // crosses, which escapes every code point outside printable ASCII: the
  // renderers here compose RAW -- escaping belongs to the single sink that shows
  // the message -- and what the operator reads names the differing code points.
  const composed = "acc\u00e9s";
  const decomposed = "acce\u0301s";

  const namingField = (name: string): LinkageTerms => {
    const terms = cloneTerms(getDefaultLinkageTerms("Org"));
    terms.linkageFields = [
      ...terms.linkageFields,
      { ...structuredClone(terms.linkageFields[0]), name },
    ];
    return terms;
  };
  const nameTwins = diffLinkageTerms(
    namingField(composed),
    namingField(decomposed),
  );
  expect(nameTwins.conflicts.map((c) => c.field)).toEqual(["linkage_fields"]);
  expect(nameTwins.conflicts[0].existing).toContain(composed);
  expect(nameTwins.conflicts[0].existing).not.toBe(
    nameTwins.conflicts[0].incoming,
  );
  const nameRendered = renderedAcceptReconcileError(nameTwins.conflicts);
  expect(nameRendered).toContain("acc\\xe9s");
  expect(nameRendered).toContain("acce\\u0301s");
  expect(nameRendered).not.toContain(composed);
  expect(nameRendered).not.toContain(decomposed);

  // The same pair in a payload column's description, where both sides summarize
  // to the same column names and the diff falls back to the full detail: the
  // fallback carries the twins to that boundary too, rather than collapsing them.
  const describing = (description: string): LinkageTerms => {
    const terms = cloneTerms(getDefaultLinkageTerms("Org"));
    terms.payload = { send: [{ name: "note", description }] };
    return terms;
  };
  const detailTwins = diffLinkageTerms(
    describing(composed),
    describing(decomposed),
  );
  expect(detailTwins.conflicts.map((c) => c.field)).toEqual(["payload"]);
  const detailRendered = renderedAcceptReconcileError(detailTwins.conflicts);
  expect(detailRendered).toContain("acc\\xe9s");
  expect(detailRendered).toContain("acce\\u0301s");
  expect(detailRendered).not.toContain(composed);
  expect(detailRendered).not.toContain(decomposed);

  // A pair that already differs in printable ASCII is shown as it is stored, so
  // the operator reads the value to edit rather than an escape of it.
  const plain = diffLinkageTerms(
    namingField("alpha_set"),
    namingField("beta_set"),
  );
  expect(plain.conflicts.map((c) => c.field)).toEqual(["linkage_fields"]);
  const plainRendered = renderedAcceptReconcileError(plain.conflicts);
  expect(plainRendered).toContain("alpha_set");
  expect(plainRendered).toContain("beta_set");
});

test("diffLinkageTerms: each legal-agreement field is a conflict core refuses too", () => {
  // The agreement is compared here as a whole object and cross-checked field by
  // field in core, which is what makes the two equally strict on it. The vectors
  // are keyed by the agreement's own fields, so a field added to it fails to
  // compile here until that parity is established for it.
  const agreement = {
    reference: "MOU-2025-0042",
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2030-01-01",
  };
  const vectors: Record<
    keyof NonNullable<LinkageTerms["legalAgreement"]>,
    { value: string; coreError: string }
  > = {
    reference: {
      value: "MOU-2025-0043",
      coreError: "legal agreement reference mismatch",
    },
    purpose: {
      value: "Verification of program enrollment",
      coreError: "legal agreement purpose mismatch",
    },
    expirationDate: {
      value: "2031-02-02",
      coreError: "legal agreement expiration date mismatch",
    },
  };

  for (const [field, vector] of Object.entries(vectors)) {
    const existing = cloneTerms(getDefaultLinkageTerms("Org"));
    const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
    existing.legalAgreement = { ...agreement };
    incoming.legalAgreement = { ...agreement, [field]: vector.value };
    expect(
      diffLinkageTerms(existing, incoming).conflicts.map((c) => c.field),
      field,
    ).toEqual(["legal_agreement"]);
    expect(
      validateCompatibility(existing, incoming).errors.some((e) =>
        e.includes(vector.coreError),
      ),
      field,
    ).toBe(true);
  }
});

test("diffLinkageTerms: linkage fields are sorted under core's own comparator", () => {
  // Two fields whose normalization form changes their sort order: NFC "\u00c5"
  // (U+00C5) sorts after "B", but its NFD form "A\u030a" begins with "A" and
  // sorts before "B". The pre-sort exists so a field set's array order is not
  // significant, and it sorts on the raw name -- the key core sorts by -- so the
  // two sides reach the byte-exact compare ordered as validateCompatibility
  // orders them.
  const base = getDefaultLinkageTerms("Org");
  const field = base.linkageFields[0];
  const named = (...names: string[]): LinkageTerms => {
    const terms = cloneTerms(base);
    terms.linkageFields = names.map((name) => ({
      ...structuredClone(field),
      name,
    }));
    return terms;
  };

  // The same two names in either array order reconcile clean: the pre-sort is
  // what makes that order insignificant, and this is a pair whose ordering
  // depends on which spelling the comparator reads -- the raw "A\u030a" before
  // "B", the NFC fold's "\u00c5" after it.
  const reordered = diffLinkageTerms(
    named("B", "A\u030a"),
    named("A\u030a", "B"),
  );
  expect(reordered.conflicts).toEqual([]);
  expect(reordered.warnings).toEqual([]);

  // The same names in different normalization forms are a conflict, and core
  // reaches that verdict on the same pair -- the run would otherwise abort on it
  // after the reconcile had reported the config as matching.
  const existing = named("B", "\u00c5");
  const incoming = named("B", "A\u030a");
  const twins = diffLinkageTerms(existing, incoming);
  expect(twins.conflicts.map((c) => c.field)).toEqual(["linkage_fields"]);
  expect(
    validateCompatibility(existing, incoming).errors.some((e) =>
      e.includes("linkage fields do not match"),
    ),
  ).toBe(true);
});

test("diffLinkageTerms: an explicitly-undefined optional is treated as absent", () => {
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  // An in-process object (unlike a Zod-parsed one) can carry an explicit
  // `undefined` optional. The reconcile walk must drop it rather than feed it to
  // canonicalString (which rejects undefined); it must still compare equal to the
  // side that simply omits `swap`, and reach that verdict as a comparison rather
  // than as the un-encodable-value warning a rejection would soften to.
  existing.linkageKeys[0].swap = undefined;
  expect(() => diffLinkageTerms(existing, incoming)).not.toThrow();
  const { conflicts, warnings } = diffLinkageTerms(existing, incoming);
  expect(conflicts).toEqual([]);
  expect(warnings).toEqual([]);
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
  const rendered = formatReconcileDiffs(
    [
      {
        field: "algorithm",
        existing: reconcileDiffValue("psi-c"),
        incoming: reconcileDiffValue("psi"),
      },
      {
        field: "connection.server.host",
        existing: reconcileDiffValue("old-host"),
        incoming: reconcileDiffValue("host"),
      },
    ],
    COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  );
  expect(rendered).toContain("algorithm");
  expect(rendered).toContain("psi-c");
  expect(rendered).toContain("connection.server.host");
  expect(rendered).toContain("old-host");
  // One line per diff.
  expect(rendered.split("\n")).toHaveLength(2);
});

test("formatReconcileDiffs: neutralizes partner-controlled values against terminal injection", () => {
  // The incoming side can be a partner-controlled string (a linkage key name, or
  // an inviter's split inbound_path/outbound_path from the connection endpoint),
  // rendered to the acceptor's terminal before acceptance. A control/ANSI
  // sequence in it must be neutralized, not passed through. The block is composed
  // into a UsageError by its only caller, so this asserts at that error's rendered
  // boundary rather than on the raw block.
  const rendered = sanitizeErrorForDisplay(
    new Error(
      formatReconcileDiffs(
        [
          {
            field: "connection.server.inbound_path",
            existing: reconcileDiffValue("/safe/in"),
            incoming: reconcileDiffValue("/drop\x1b[2J\x1b[31m"),
          },
        ],
        COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
      ),
    ),
  );
  // Gone from the terminal, and gone in the seam's visible marker rather than in
  // the escape's `\xHH` -- which is the form THIS block's own line breaks take
  // once the refusal is escaped, and so a form no value may share.
  expect(rendered).not.toContain("\x1b");
  expect(rendered).not.toContain("\\x1b");
  expect(rendered).toContain(controlCharacterMarker(0x1b));
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
      linkageTermsStanding: "held-alone",
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

// --- warnOnLinkageRuleSetCitationDrift ---------------------------------------

/** The warnings one drift check emits, in order. Terms default to the standing
 *  that offers both remedies; the accepted standing is asked for explicitly, as
 *  is the alternative a command minting an invitation from them offers. */
function citationWarnings(
  terms: Pick<LinkageTerms, "linkageRuleSet" | "linkageFields" | "linkageKeys">,
  standing: LinkageTermsStanding = "held-alone",
  alternative: CitationDriftAlternative = "decline-to-reuse",
): string[] {
  const warnings: string[] = [];
  warnOnLinkageRuleSetCitationDrift(
    terms,
    "psilink.yaml",
    { warn: (message: string) => warnings.push(message) },
    standing,
    alternative,
  );
  return warnings;
}

/** The terms with their first two keys swapped: the smallest edit that takes
 *  rules out of the set they cite, since key order is cascade order. */
function withReorderedKeys(terms: LinkageTerms): LinkageTerms {
  const [first, second, ...rest] = terms.linkageKeys;
  return { ...terms, linkageKeys: [second!, first!, ...rest] };
}

/** The terms with a linkage field the cited set does not declare, the
 *  field-side counterpart of {@link withReorderedKeys}. A narrowed field list
 *  stays drawn from the set, so it takes an ADDITION to leave it. */
function withAddedField(terms: LinkageTerms): LinkageTerms {
  return {
    ...terms,
    linkageFields: [
      ...terms.linkageFields,
      { name: "zip_code", type: "zip_code" },
    ],
  };
}

test("an untouched psilink init config draws no citation warning", () => {
  expect(citationWarnings(getDefaultLinkageTerms("Agency A"))).toEqual([]);
});

test("narrowing the cited key set draws no citation warning", () => {
  // What an input file that cannot supply every key yields: a subset of the set,
  // which the citation is an upper bound on rather than a claim against.
  const terms = getDefaultLinkageTerms("Agency A");
  expect(
    citationWarnings({ ...terms, linkageKeys: terms.linkageKeys.slice(0, -1) }),
  ).toEqual([]);
});

test("terms carrying no citation draw no warning however their rules read", () => {
  const terms = withReorderedKeys(getDefaultLinkageTerms("Agency A"));
  delete terms.linkageRuleSet;
  expect(citationWarnings(terms)).toEqual([]);
});

test("a reordered cascade under the built-in citation warns, naming linkage_keys", () => {
  const warnings = citationWarnings(
    withReorderedKeys(getDefaultLinkageTerms("Agency A")),
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("psilink.yaml: linkage_terms.linkage_rule_set");
  expect(warnings[0]).toContain(
    `"${DEFAULT_LINKAGE_RULE_SET.reference.keySet.name}" ` +
      DEFAULT_LINKAGE_RULE_SET.reference.keySet.version,
  );
  expect(warnings[0]).toContain("its linkage_keys are not drawn from");
  expect(warnings[0]).not.toContain("linkage_fields");
  expect(warnings[0]).toContain("Remove linkage_rule_set");
});

test("an added linkage field under the built-in citation warns, naming linkage_fields", () => {
  const warnings = citationWarnings(
    withAddedField(getDefaultLinkageTerms("Agency A")),
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("its linkage_fields are not drawn from");
  expect(warnings[0]).not.toContain("linkage_keys");
});

test("both halves edited are reported in one warning, each against its own set", () => {
  const warnings = citationWarnings(
    withAddedField(withReorderedKeys(getDefaultLinkageTerms("Agency A"))),
  );
  const { fieldSet, keySet } = DEFAULT_LINKAGE_RULE_SET.reference;
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain(
    `its linkage_fields are not drawn from the "${fieldSet.name}" ` +
      `${fieldSet.version} this build ships`,
  );
  expect(warnings[0]).toContain(
    `its linkage_keys are not drawn from the "${keySet.name}" ` +
      `${keySet.version} this build ships`,
  );
});

test("a set name in the drift warning cannot forge the clause it is named in", () => {
  // The warning is first-party prose whose clause an operator reads as
  // psilink's own -- `<name> <version> this build ships` -- and the set name is
  // free text whoever authored the config chose. The escape does not reach a
  // forgery made of printable ASCII, so the name is delimited through the same
  // seam core's own rule-set message uses; the doubling grammar is what keeps a
  // name carrying a delimiter of its own from closing its run early.
  //
  // Driven on the CITED half, which the warning echoes back verbatim: the half
  // it reports drift against is this build's own shipped name.
  const terms = withReorderedKeys(getDefaultLinkageTerms("Agency A"));
  const keySet = DEFAULT_LINKAGE_RULE_SET.reference.keySet;
  terms.linkageRuleSet = {
    fieldSet: { name: 'a" 9.9.9 this build ships, and "b', version: "3.1.0" },
    keySet,
  };
  const warnings = citationWarnings(terms);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).not.toContain('"a" 9.9.9 this build ships, and "b"');
  expect(warnings[0]).toContain('"a"" 9.9.9 this build ships, and ""b"');
  // A version that does not meet the seam's checked bare shape takes the
  // delimited form too, rather than standing in the sentence undelimited.
  const versionForged = withReorderedKeys(getDefaultLinkageTerms("Agency A"));
  versionForged.linkageRuleSet = {
    fieldSet: { name: "county-pii", version: "over" },
    keySet,
  };
  expect(citationWarnings(versionForged)[0]).toContain('"county-pii" "over"');
});

test("a set name in the drift warning reaches its sink carrying no control character", () => {
  // The other renderer these values reach. Its route escapes at COMPOSITION and
  // its sink is a `log.warn` that escapes nothing further, so a control
  // character the operator's terminal could act on must be gone by the time the
  // warning is handed over -- and gone from the whole composed line, first-party
  // copy included, so this renderer places no control character for a value to
  // be confused with either.
  const terms = withReorderedKeys(getDefaultLinkageTerms("Agency A"));
  terms.linkageRuleSet = {
    fieldSet: {
      name: "a\n  county-pii\r 9.9.9 this build ships",
      version: "3.1.0\x1b[31m",
    },
    keySet: DEFAULT_LINKAGE_RULE_SET.reference.keySet,
  };
  const warnings = citationWarnings(withAddedField(terms));
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).not.toMatch(/\p{Cc}/u);
  // Non-vacuous: the name did reach the warning, at the width it was chosen.
  expect(warnings[0]).toContain("county-pii");
});

test("a citation this build cannot resolve draws no warning", () => {
  // Nothing here resolves either name to a set, so nothing about these rules is
  // provable: reporting drift would assert a comparison never made.
  const terms = withReorderedKeys(getDefaultLinkageTerms("Agency A"));
  terms.linkageRuleSet = {
    fieldSet: { name: "county-pii", version: "3.1.0" },
    keySet: { name: "county-keys", version: "3.1.0" },
  };
  expect(citationWarnings(withAddedField(terms))).toEqual([]);
});

test("a built-in set name at a version this build does not ship is not resolvable", () => {
  // The recorded content attaches to the name and the version together, so a set
  // at another version is as unknown to this build as another name entirely.
  const terms = withReorderedKeys(getDefaultLinkageTerms("Agency A"));
  terms.linkageRuleSet = {
    fieldSet: DEFAULT_LINKAGE_RULE_SET.reference.fieldSet,
    keySet: {
      name: DEFAULT_LINKAGE_RULE_SET.reference.keySet.name,
      version: "9.9.9",
    },
  };
  expect(citationWarnings(terms)).toEqual([]);
});

test("a foreign field-set half does not exempt the built-in key set beside it", () => {
  const terms = withReorderedKeys(getDefaultLinkageTerms("Agency A"));
  terms.linkageRuleSet = {
    fieldSet: { name: "county-pii", version: "3.1.0" },
    keySet: DEFAULT_LINKAGE_RULE_SET.reference.keySet,
  };
  const warnings = citationWarnings(terms);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("its linkage_keys are not drawn from");
  expect(warnings[0]).not.toContain("linkage_fields");
});

test("a half-foreign citation reports the drift against the half this build ships", () => {
  // Only the key half resolves here, so the report must name that set rather than
  // "the citation": the citation also names a set this build does not ship, and
  // claiming to have compared the rules against it would assert a check no build
  // here can make.
  const terms = withReorderedKeys(getDefaultLinkageTerms("Agency A"));
  const keySet = DEFAULT_LINKAGE_RULE_SET.reference.keySet;
  terms.linkageRuleSet = {
    fieldSet: { name: "county-pii", version: "3.1.0" },
    keySet,
  };
  const warnings = citationWarnings(terms);
  expect(warnings[0]).toContain(
    `its linkage_keys are not drawn from the "${keySet.name}" ` +
      `${keySet.version} this build ships`,
  );
  expect(warnings[0]).not.toContain("this build ships under that citation");
  expect(warnings[0]).not.toContain('"county-pii" 3.1.0 this build ships');
});

test("fields the unresolvable half covers do not decide the resolvable half", () => {
  // Both lists here have been edited, and only the key set's name resolves: the
  // report must be the key set's answer alone, with the added field neither
  // named nor able to turn a fitting key set into a warning.
  const drifted = withAddedField(
    withReorderedKeys(getDefaultLinkageTerms("Agency A")),
  );
  const foreignFieldSet = { name: "county-pii", version: "3.1.0" };
  const keySet = DEFAULT_LINKAGE_RULE_SET.reference.keySet;
  expect(
    citationWarnings({
      ...drifted,
      linkageRuleSet: { fieldSet: foreignFieldSet, keySet },
    }),
  ).toEqual([
    expect.stringContaining("its linkage_keys are not drawn from") as string,
  ]);
  expect(
    citationWarnings({
      ...withAddedField(getDefaultLinkageTerms("Agency A")),
      linkageRuleSet: { fieldSet: foreignFieldSet, keySet },
    }),
  ).toEqual([]);
});

test("a set name carrying control characters is escaped at this sink", () => {
  // Only a resolvable half's name is a shipped literal; the half beside it is
  // whatever the file says, and this log.warn is that value's display boundary.
  const terms = withReorderedKeys(getDefaultLinkageTerms("Agency A"));
  terms.linkageRuleSet = {
    fieldSet: { name: "county-pii\u0007\nsecond line", version: "3.1.0" },
    keySet: DEFAULT_LINKAGE_RULE_SET.reference.keySet,
  };
  const warnings = citationWarnings(terms);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("county-pii");
  expect(warnings[0]).not.toContain("\u0007");
  expect(warnings[0]).not.toContain("\n");
});

test("terms an acceptance stands behind are not addressed to their author", () => {
  // Neither remedy addressed to an author applies to terms both parties hold:
  // restoring the cited set's rules would edit an agreement unilaterally, and
  // the exchange would refuse the result against the partner running the
  // originals.
  const drifted = withReorderedKeys(getDefaultLinkageTerms("Agency A"));
  const warnings = citationWarnings(drifted, "accepted-with-partner");
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("its linkage_keys are not drawn from");
  expect(warnings[0]).not.toContain("rules you author yourself");
  expect(warnings[0]).not.toContain("restore the rules the cited set declares");
  expect(warnings[0]).toContain("not yours alone to correct");
  expect(warnings[0]).toContain("decline to reuse these terms");
});

test("a mint from accepted terms is offered the remedy a mint has", () => {
  // "Accept again" and "decline to reuse these terms" name nothing an operator
  // minting an invitation can do: the acceptance behind these terms is already
  // recorded, and what is in front of them is a new document to author. Settling
  // with the party that acceptance was made with is still the first choice, so
  // only the alternative changes.
  const drifted = withReorderedKeys(getDefaultLinkageTerms("Agency A"));
  const warnings = citationWarnings(
    drifted,
    "accepted-with-partner",
    "author-fresh-terms",
  );
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("Agree the citation with that party");
  expect(warnings[0]).toContain("author fresh terms for this invitation");
  expect(warnings[0]).not.toContain("accept again");
  expect(warnings[0]).not.toContain("decline to reuse these terms");
  // The clauses before the remedy are one source, so the mint reading carries
  // the same account of why the terms are not the operator's alone.
  expect(warnings[0]).toContain("not yours alone to correct");
  expect(warnings[0]).toContain("its linkage_keys are not drawn from");
});

test("terms no acceptance stands behind read the same whatever the command", () => {
  // The alternative is the accepted reading's alone: terms held alone are the
  // operator's to edit whether they are being used or minted from.
  const drifted = withReorderedKeys(getDefaultLinkageTerms("Agency A"));
  expect(citationWarnings(drifted, "held-alone", "author-fresh-terms")).toEqual(
    citationWarnings(drifted, "held-alone", "decline-to-reuse"),
  );
});

test("a drifted citation is reported under either standing", () => {
  // The claim is reported whoever authored it; only the remedy differs, so the
  // accepted reading is not a way for a drifted citation to go unmentioned.
  const drifted = withReorderedKeys(getDefaultLinkageTerms("Agency A"));
  for (const standing of ["held-alone", "accepted-with-partner"] as const) {
    const warnings = citationWarnings(drifted, standing);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      "psilink.yaml: linkage_terms.linkage_rule_set cites",
    );
    expect(warnings[0]).toContain(
      "credits a source these rules did not come from",
    );
  }
});

test("a config with no drift is silent under either standing", () => {
  const clean = getDefaultLinkageTerms("Agency A");
  expect(citationWarnings(clean, "held-alone")).toEqual([]);
  expect(citationWarnings(clean, "accepted-with-partner")).toEqual([]);
});

// --- The vocabulary a bare value must not be able to spell here ---------------

/** Whether a token would render undelimited, asked of core's own seam so this
 *  cannot fall behind a change to the shape it admits. */
const rendersBare = (token: string): boolean => bareTermsValue(token) === token;

test("no token of the reconcile refusal's or the drift warning's copy is bare-shaped", () => {
  // The argument the undelimited form rests on, as a check over the copy THIS
  // module composes. A bare value carries no space, so it is exactly one token
  // wherever a template drops it; if no token of the first-party copy around it
  // can be spelled that way, then no bare value reads as structure this module
  // wrote, whatever the party that chose it intended. Core's own check reads the
  // templates in its `validateCompatibility` module, which says nothing about
  // the clauses composed here -- the citation's version and the legal
  // agreement's expiration date on a conflict line, and the version in the drift
  // warning, all stand in copy no check there reads.
  //
  // Driven rather than restated: each message below is composed for real over
  // values carrying no delimiter of their own, so removing its delimited runs
  // removes exactly the values and leaves the copy. What a removal cannot reach
  // is a value rendered undelimited -- which is the whole point of the form --
  // so those are named as the values they are and every other bare-shaped token
  // is copy a bare value could impersonate.
  const existing = cloneTerms(getDefaultLinkageTerms("Org"));
  const incoming = cloneTerms(getDefaultLinkageTerms("Org"));
  existing.version = "1.0.0";
  incoming.version = "2.0.0";
  existing.linkageRuleSet = {
    fieldSet: { name: "baseline-pii", version: "1.0.0" },
    keySet: { name: "baseline-keys", version: "1.0.0" },
  };
  incoming.linkageRuleSet = {
    fieldSet: { name: "county-pii", version: "3.1.0" },
    keySet: { name: "county-keys", version: "3.1.0" },
  };
  incoming.legalAgreement = {
    reference: "MOU-2025-0042",
    purpose: "Audit and evaluation of the State tutoring program",
    expirationDate: "2030-01-01",
  };
  incoming.payload = { send: [{ name: "note" }], receive: [{ name: "memo" }] };
  const { conflicts } = diffLinkageTerms(existing, incoming);
  expect(conflicts.map((d) => d.field)).toEqual([
    "version",
    "linkage_rule_set",
    "legal_agreement",
    "payload",
  ]);

  // Both sides redacting to the same text, which is what puts the withheld line
  // under the block.
  const withheldExisting = cloneTerms(getDefaultLinkageTerms("Org"));
  const withheldIncoming = cloneTerms(getDefaultLinkageTerms("Org"));
  withheldExisting.linkageRuleSet = {
    fieldSet: { name: "-----BEGIN OPENSSH PRIVATE KEY-----", version: "1.0.0" },
    keySet: { name: "hmis-keys", version: "1.0.0" },
  };
  withheldIncoming.linkageRuleSet = {
    fieldSet: { name: "-----BEGIN RSA PRIVATE KEY-----", version: "1.0.0" },
    keySet: { name: "hmis-keys", version: "1.0.0" },
  };

  const worstCase = maximallyConflictingTerms();
  const messages = [
    reconcileConflictMessage({ ...ACCEPT_RECONCILE_SOURCES, diffs: conflicts }),
    reconcileConflictMessage({
      ...ONLINE_RECONCILE_SOURCES,
      diffs: diffLinkageTerms(withheldExisting, withheldIncoming).conflicts,
    }),
    // Wide enough on enough fields to leave lines named without their values,
    // whose own line is copy this check has to reach as well.
    reconcileConflictMessage({
      ...ONLINE_RECONCILE_SOURCES,
      diffs: [
        ...diffLinkageTerms(worstCase.existing, worstCase.incoming).conflicts,
        ...connectionConflicts(),
      ],
    }),
    ...citationWarnings(withReorderedKeys(getDefaultLinkageTerms("Agency A"))),
    ...citationWarnings(
      withAddedField(withReorderedKeys(getDefaultLinkageTerms("Agency A"))),
      "accepted-with-partner",
      "author-fresh-terms",
    ),
    ...citationWarnings(
      withReorderedKeys(getDefaultLinkageTerms("Agency A")),
      "accepted-with-partner",
      "decline-to-reuse",
    ),
  ];
  // The shapes each message was built to drive, so a message that stopped
  // reaching its own copy fails here rather than shrinking the vocabulary.
  expect(messages[0]).toContain("(unset)");
  expect(messages[1]).toContain("read alike");
  expect(messages[2]).toContain("too wide for the room");
  expect(messages[3]).toContain("Remove linkage_rule_set");
  expect(messages[4]).toContain("author fresh terms");
  expect(messages[5]).toContain("decline");

  const tokens = messages.flatMap((message) =>
    message
      .replaceAll(/"[^"]*"/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 0),
  );
  // The vocabulary is tied back to the copy it came out of, so a removal that
  // ate the message rather than its values fails instead of passing vacuously.
  expect(tokens).toEqual(
    expect.arrayContaining([
      "over",
      "(expires",
      "existing",
      "required",
      "cites",
      "send=[",
      "--config-file",
    ]),
  );

  // The values rendered undelimited: every version this drives, the schema shape
  // the bare form exists for.
  const bareValues = new Set([
    existing.version,
    incoming.version,
    existing.linkageRuleSet.keySet.version,
    incoming.linkageRuleSet.keySet.version,
    DEFAULT_LINKAGE_RULE_SET.reference.keySet.version,
    DEFAULT_LINKAGE_RULE_SET.reference.fieldSet.version,
  ]);
  for (const token of tokens)
    if (!bareValues.has(token)) expect(rendersBare(token), token).toBe(false);
});

// --- linkageTermsStandingOf --------------------------------------------------

test("the partner-deduplicate record is what marks an accepted config", () => {
  // `psilink accept` records the invitation's declared cardinality on every
  // config it writes and every config it reuses, and nothing else writes one, so
  // its presence -- either value -- is the mark of an acceptance.
  expect(linkageTermsStandingOf({})).toBe("held-alone");
  expect(
    linkageTermsStandingOf({ expectedPartnerDeduplicate: undefined }),
  ).toBe("held-alone");
  expect(linkageTermsStandingOf({ expectedPartnerDeduplicate: false })).toBe(
    "accepted-with-partner",
  );
  expect(linkageTermsStandingOf({ expectedPartnerDeduplicate: true })).toBe(
    "accepted-with-partner",
  );
});

test("readConfigLinkageSource reads the terms' standing off the loaded file", () => {
  const write = (
    name: string,
    extra: Partial<ExchangeSpec>,
  ): ConfigLinkageSource => {
    const configPath = path.join(dir, name);
    saveConfig(configPath, {
      connection: { channel: "filedrop", path: "/mnt/share" },
      linkageTerms: getDefaultLinkageTerms("Agency A"),
      ...extra,
    });
    const result = readConfigLinkageSource(configPath);
    if (result.status !== "loaded")
      throw new Error(`expected ${name} to load, got ${result.status}`);
    return result.source;
  };
  expect(write("held-alone.yaml", {}).linkageTermsStanding).toBe("held-alone");
  // The record in the snake_case spelling saveConfig serializes it to.
  expect(
    write("accepted.yaml", { expectedPartnerDeduplicate: false })
      .linkageTermsStanding,
  ).toBe("accepted-with-partner");
});

// Both spellings are read, and the record's PRESENCE is what marks an
// acceptance: a value `psilink accept` would not have written is an operator's
// edit of a machine-written record, but the record still stands there, so it
// reads as an acceptance rather than as an error here (the commands that build
// an exchange from the file refuse the value through core's schema). A key
// carrying no value at all is YAML's null, which is no record.
test.each([
  ["a camelCase spelling", "expectedPartnerDeduplicate: true\n", true],
  ["a key with no value", "expected_partner_deduplicate:\n", false],
  ["a non-boolean value", "expected_partner_deduplicate: 'true'\n", true],
])(
  "readConfigLinkageSource reads an acceptance from %s: %j",
  (_label, block, accepted) => {
    const configPath = path.join(dir, "psilink.yaml");
    const terms = getDefaultLinkageTerms("Agency A");
    fs.writeFileSync(
      configPath,
      `${block}${YAML.stringify({ linkage_terms: terms })}`,
    );
    expect(readConfigLinkageSource(configPath)).toMatchObject({
      status: "loaded",
      source: {
        linkageTermsStanding: accepted ? "accepted-with-partner" : "held-alone",
      },
    });
  },
);

test("the record persistExpectedPartnerDeduplicate writes marks a reused config", () => {
  // The accept-reuse path leaves the operator's own terms on disk and writes
  // this record beside them, so a config whose terms an acceptance agreed to
  // reads as accepted even though nothing rewrote the terms themselves.
  const configPath = path.join(dir, "reused.yaml");
  saveConfig(configPath, {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: getDefaultLinkageTerms("Agency A"),
  });
  persistExpectedPartnerDeduplicate(configPath, true);
  const result = readConfigLinkageSource(configPath);
  if (result.status !== "loaded")
    throw new Error(`expected the config to load, got ${result.status}`);
  expect(result.source.linkageTermsStanding).toBe("accepted-with-partner");
});
