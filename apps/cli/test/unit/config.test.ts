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
  UsageError,
} from "@psilink/core";
import {
  applyConnectionOverrides,
  assertRetainSweepGuard,
  diffLinkageTerms,
  formatReconcileDiffs,
  loadConfigLinkageSource,
  persistDisclosedPayloadColumns,
  persistHostKeyFingerprint,
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

test("peerTimeout is converted to peerTimeoutMs in milliseconds", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    options: { peerTimeout: 30 },
  });
  expect(result.options?.peerTimeoutMs).toBe(30_000);
});

test("connectionTimeout is converted to serverConnectTimeoutMs in milliseconds", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    options: { connectionTimeout: 10 },
  });
  expect(result.options?.serverConnectTimeoutMs).toBe(10_000);
});

test("maxReconnectAttempts is passed through unchanged", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    options: { maxReconnectAttempts: 5 },
  });
  expect(result.options?.maxReconnectAttempts).toBe(5);
});

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

test("persistHostKeyFingerprint does not echo an inline credential on a malformed config", () => {
  // parseDocument collects a syntax error in doc.errors, whose message embeds a
  // snippet of the offending source; the path-only guard must not echo it, or an
  // inline credential near the malformed line leaks into the (logged) error.
  const SECRET = "S3cr3tSFTPPassw0rd";
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    `connection:\n  server:\n\t  password: ${SECRET}\n`,
  );
  let caught: unknown;
  try {
    persistHostKeyFingerprint(configPath, FP_A);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toContain("could not be parsed as YAML");
  expect((caught as Error).message).not.toContain(SECRET);
});

test("persistHostKeyFingerprint does not echo an inline credential via an unresolved alias", () => {
  // parseDocument defers alias resolution, so an unresolved alias leaves
  // doc.errors empty and setIn succeeds; the failure surfaces only when
  // doc.toString() materializes the document, throwing an error whose message
  // echoes the alias token. The path-only guard at serialization must not echo
  // it, or an inline credential written as an alias leaks into the error.
  const SECRET = "S3cr3tSFTPPassw0rd";
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    `connection:\n  channel: sftp\n  server:\n    password: *${SECRET}\n`,
  );
  let caught: unknown;
  try {
    persistHostKeyFingerprint(configPath, FP_A);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toContain(
    "could not be serialized as YAML",
  );
  expect((caught as Error).message).not.toContain(SECRET);
  // The original file is left untouched (the throw precedes the write).
  expect(fs.readFileSync(configPath, "utf8")).toContain(`*${SECRET}`);
});

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
  // error is display-bound (it reaches a terminal/log), so the channel is run
  // through sanitizeForDisplay and emitted escaped, never raw.
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
  const message = (caught as Error).message;
  // The raw control bytes never reach the message ...
  expect(message).not.toContain("\u001b");
  expect(message).not.toContain("\n");
  // ... they are shown as visible escapes instead.
  expect(message).toContain("\\x1b");
  expect(message).toContain("\\x0a");
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
  // role now lives on the WebRTC connection config, not under authentication.
  // saveConfig touches only the top-level authentication block, so role is
  // preserved while the authentication block (key material only) is pruned.
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
  fs.writeFileSync(configPath, "connection: [unbalanced\n");
  // Classified as a local usage error (exit 64), like persistHostKeyFingerprint,
  // not a bare Error that would fall through to the generic exit code.
  expect(() => persistDisclosedPayloadColumns(configPath, ["notes"])).toThrow(
    UsageError,
  );
});

test("persistDisclosedPayloadColumns does not echo an inline credential on a malformed config", () => {
  // Parity with persistHostKeyFingerprint: a syntax error's message embeds a
  // snippet of the offending source; the shared path-only guard must not echo it,
  // or an inline credential near the malformed line leaks into the (logged) error.
  const SECRET = "S3cr3tSFTPPassw0rd";
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    `connection:\n  server:\n\t  password: ${SECRET}\n`,
  );
  let caught: unknown;
  try {
    persistDisclosedPayloadColumns(configPath, ["notes"]);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toContain("could not be parsed as YAML");
  expect((caught as Error).message).not.toContain(SECRET);
});

test("persistDisclosedPayloadColumns does not echo an inline credential via an unresolved alias", () => {
  // Parity with persistHostKeyFingerprint: an unresolved alias clears doc.errors
  // and setIn succeeds; the failure surfaces only at doc.toString(), whose message
  // echoes the alias token. The path-only guard at serialization must not echo it,
  // and the original file must be left untouched (the throw precedes the write).
  const SECRET = "S3cr3tSFTPPassw0rd";
  const configPath = path.join(dir, "psilink.yaml");
  fs.writeFileSync(
    configPath,
    `connection:\n  channel: sftp\n  server:\n    password: *${SECRET}\n`,
  );
  let caught: unknown;
  try {
    persistDisclosedPayloadColumns(configPath, ["notes"]);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UsageError);
  expect((caught as Error).message).toContain(
    "could not be serialized as YAML",
  );
  expect((caught as Error).message).not.toContain(SECRET);
  expect(fs.readFileSync(configPath, "utf8")).toContain(`*${SECRET}`);
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
  // is now rejected earlier, at the decode chokepoint (the camelize fold bounds it
  // -- see the decode-side test in core's invitation.test.ts), so the reconcile no
  // longer sees one in practice. This builds the 3000-deep value straight into the
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
  // sequence in it must be neutralized, not passed through.
  const rendered = formatReconcileDiffs([
    {
      field: "connection.server.inbound_path",
      existing: "/safe/in",
      incoming: "/drop\x1b[2J\x1b[31m",
    },
  ]);
  expect(rendered).not.toContain("\x1b");
  expect(rendered).toContain("\\x1b");
});

// --- loadConfigLinkageSource -------------------------------------------------

test("loadConfigLinkageSource returns undefined when no file exists", () => {
  expect(
    loadConfigLinkageSource(path.join(dir, "absent.yaml")),
  ).toBeUndefined();
});

test("loadConfigLinkageSource round-trips the terms a saveConfig wrote", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const terms = getDefaultLinkageTerms("Agency A");
  saveConfig(configPath, {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: terms,
  });
  const source = loadConfigLinkageSource(configPath);
  expect(source?.linkageTerms).toEqual(terms);
  // No standardization block was written, so none is returned.
  expect(source?.standardization).toBeUndefined();
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

test("loadConfigLinkageSource rejects invalid linkage_terms", () => {
  const configPath = path.join(dir, "psilink.yaml");
  // linkage_terms present but missing the mandatory fields the schema requires.
  fs.writeFileSync(configPath, "linkage_terms:\n  identity: Agency A\n");
  expect(() => loadConfigLinkageSource(configPath)).toThrow(UsageError);
  expect(() => loadConfigLinkageSource(configPath)).toThrow(
    "invalid linkage_terms",
  );
});

// A local config whose linkage_terms trips a camelizeKeys structural bound (here
// the depth bound, the cheapest to reach) must still surface the file-named
// "config file X has invalid linkage_terms: ..." wrap, not the raw bound-error
// text -- safeParseLinkageTerms is now genuinely non-throwing for the bound, so
// the if(!result.success) branch produces the helpful message rather than the
// throw skipping straight past it. Still a UsageError (CLI exit 64), as before.
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

// The three parse-error formatters route every issue-path segment through
// sanitizeForDisplay, like describeDecodeError, so a control/ANSI or
// deceptive-Unicode byte in a path can never reach the operator raw. No reachable
// failure produces such a path today (the linkage schemas are non-strict, so
// unrecognized keys are stripped before they can appear), so this drives the one
// schema position that can carry a partner-style string into a path -- a
// transform `params` record key, whose key schema bounds length -- with an
// over-long key built from control and bidi-override bytes. The guard must escape
// it; the two tests below pin both the escaping and the absence of over-escaping.
test("loadConfigLinkageSource escapes control/ANSI bytes in a linkage_terms issue path", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const terms = cloneTerms(getDefaultLinkageTerms("Agency A"));
  // An ESC-driven ANSI sequence and a right-to-left override (U+202E). The key
  // must exceed MAX_NAME_LENGTH so the record-key schema rejects it and Zod
  // surfaces the offending key in the issue path.
  const badKey = "\x1b[31m‮evil" + "x".repeat(MAX_NAME_LENGTH + 10);
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
  const message = (caught as Error).message;
  expect(message).toContain("invalid linkage_terms");
  // The fixed path prefix passes through verbatim; only the partner-style key
  // segment is escaped.
  expect(message).toContain("linkageKeys.0.elements.0.transform.0.params.");
  // The raw bytes are neutralized: their escaped forms appear, never the bytes.
  expect(message).not.toContain("\x1b");
  expect(message).not.toContain("‮");
  expect(message).toContain("\\x1b");
  expect(message).toContain("\\u202e");
});

test("loadConfigLinkageSource leaves a schema-fixed linkage_terms issue path unescaped", () => {
  const configPath = path.join(dir, "psilink.yaml");
  const terms = cloneTerms(getDefaultLinkageTerms("Agency A"));
  // An empty name fails the linkage-key `name` min-length, locating the issue
  // at the schema-fixed path linkageKeys.0.name (field names + a numeric index).
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
  expect((caught as Error).message).toContain("linkageKeys.0.name");
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
  expect(() => loadConfigLinkageSource(configPath)).toThrow(UsageError);
  expect(() => loadConfigLinkageSource(configPath)).toThrow(
    "could not be parsed as YAML",
  );
});

// A YAML parse failure embeds a snippet of the offending source in its message,
// which can carry an inline credential; the path-only guard must close both a
// syntax error (a YAMLParseError reproducing the malformed line) and an
// unresolved alias (a plain ReferenceError echoing the alias name). Mirrors the
// exchange-side guard (exchange.test.ts).
test.each([
  ["syntax error (tab indentation)", (s: string) => `\t  password: ${s}\n`],
  ["unresolved alias", (s: string) => `connection:\n  password: *${s}\n`],
])(
  "loadConfigLinkageSource does not echo an inline credential: %s",
  (_, mk) => {
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
    expect((caught as Error).message).toContain("could not be parsed as YAML");
    expect((caught as Error).message).not.toContain(SECRET);
  },
);

// The schema-validation error branches (linkage_terms / standardization /
// metadata) interpolate the Zod issue message, which under Zod v4 names only the
// expected literals, never the rejected input value. That is what keeps a secret
// mistakenly placed in one of these blocks out of the error; Zod v3's enum error
// echoed the received value ("...received '<value>'") and would have leaked it.
// The YAML-parse leak test above does not cover this branch, so pin it directly:
// embed a secret as an invalid enum value and assert it never reaches the message.
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

// --- CLI-only entry-sweep flags (195255994) ----------------------------------

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
    | Record<string, unknown>
    | undefined;
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
