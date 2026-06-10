import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import YAML from "yaml";
import {
  getDefaultLinkageTerms,
  parseExchangeSpec,
  UsageError,
} from "@psilink/core";
import {
  applyConnectionOverrides,
  assertRetainSweepGuard,
  diffLinkageTerms,
  formatReconcileDiffs,
  loadConfigLinkageSource,
  saveConfig,
} from "../../src/config";
import type {
  ConnectionConfig,
  ExchangeSpec,
  LinkageTerms,
  SFTPConnectionConfig,
} from "@psilink/core";

const baseSFTP: ConnectionConfig = {
  channel: "sftp",
  server: { host: "sftp.example.org" },
};

// --- timeout / reconnect overrides -------------------------------------------

test("peerTimeout is converted to peerTimeoutMs in milliseconds", () => {
  const result = applyConnectionOverrides(baseSFTP, { peerTimeout: 30 });
  expect(result.options?.peerTimeoutMs).toBe(30_000);
});

test("connectionTimeout is converted to serverConnectTimeoutMs in milliseconds", () => {
  const result = applyConnectionOverrides(baseSFTP, { connectionTimeout: 10 });
  expect(result.options?.serverConnectTimeoutMs).toBe(10_000);
});

test("maxReconnectAttempts is passed through unchanged", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    maxReconnectAttempts: 5,
  });
  expect(result.options?.maxReconnectAttempts).toBe(5);
});

test("multiple timeout overrides are merged into options", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    peerTimeout: 60,
    connectionTimeout: 15,
    maxReconnectAttempts: 2,
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
    peerTimeout: 20,
  }) as SFTPConnectionConfig;
  expect(result.options?.pollIntervalMs).toBe(5000);
  expect(result.options?.peerTimeoutMs).toBe(20_000);
});

// --- server credential overrides ---------------------------------------------

test("serverUsername overrides the connection username", () => {
  const result = applyConnectionOverrides(baseSFTP, {
    serverUsername: "alice",
  });
  if (result.channel !== "sftp") return;
  expect(result.server.username).toBe("alice");
});

test("serverPort overrides the connection port", () => {
  const result = applyConnectionOverrides(baseSFTP, { serverPort: 2222 });
  if (result.channel !== "sftp") return;
  expect(result.server.port).toBe(2222);
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
  applyConnectionOverrides(input, { peerTimeout: 10, serverUsername: "bob" });
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
  const result = applyConnectionOverrides(base, { peerId: "agency-a" });
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
  expect(() => applyConnectionOverrides(base, { peerId: "temp" })).toThrow(
    UsageError,
  );
  expect(() => applyConnectionOverrides(base, { peerId: "temp" })).toThrow(
    "reserved",
  );
});

test("peerId without timestampInFilename is rejected by applyConnectionOverrides", () => {
  expect(() =>
    applyConnectionOverrides(baseSFTP, { peerId: "agency-a" }),
  ).toThrow("timestamp_in_filename");
});

test("peerId without timestampInFilename is rejected on filedrop too", () => {
  const base: ConnectionConfig = {
    channel: "filedrop",
    path: "/mnt/share",
  };
  expect(() => applyConnectionOverrides(base, { peerId: "agency-a" })).toThrow(
    "timestamp_in_filename",
  );
});

test("empty peerId is rejected by applyConnectionOverrides", () => {
  const base: ConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    options: { timestampInFilename: true },
  };
  expect(() => applyConnectionOverrides(base, { peerId: "" })).toThrow();
});

// --- retainFiles implication --------------------------------------------------

test("retainFiles: true with unset lockless and timestamp implies both true", () => {
  const result = applyConnectionOverrides(baseSFTP, { retainFiles: true });
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
  const result = applyConnectionOverrides(base, { retainFiles: true });
  if (result.channel !== "sftp") return;
  expect(result.options?.locklessRendezvous).toBe(true);
});

test("retainFiles: true with explicit locklessRendezvous: false throws", () => {
  expect(() =>
    applyConnectionOverrides(baseSFTP, {
      retainFiles: true,
      locklessRendezvous: false,
    }),
  ).toThrow(UsageError);
  expect(() =>
    applyConnectionOverrides(baseSFTP, {
      retainFiles: true,
      locklessRendezvous: false,
    }),
  ).toThrow("lockless_rendezvous");
});

// --- saveConfig --------------------------------------------------------------

test("saveConfig emits snake_case keys and round-trips through parseExchangeSpec", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
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
    // The writer is the inverse of the reader's camelizeKeys: parsing the
    // written file reproduces the original spec exactly.
    expect(parseExchangeSpec(YAML.parse(raw))).toEqual(spec);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveConfig writes the config owner-read-only (0600)", () => {
  // Windows uses a restricted ACL, not POSIX mode bits; fs.statSync reports a
  // synthetic mode there, so this assertion is Unix-only.
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveConfig strips sharedSecret/expires and does not mutate the caller's spec", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const spec = {
      connection: {
        channel: "sftp",
        server: { host: "h" },
        authentication: {
          sharedSecret: token,
          expires: "2028-01-01T00:00:00.000Z",
        },
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
    expect(spec.connection.authentication?.sharedSecret).toBe(token);
    expect(spec.connection.authentication?.expires).toBe(
      "2028-01-01T00:00:00.000Z",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveConfig round-trips provider_options verbatim in both directions", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    // provider_options is opaque: a literal camelCase key (ssh2's readyTimeout)
    // and a snake_case key must both survive the writer + reader unchanged. The
    // writer must not snakeize readyTimeout, and the reader must not camelize
    // keepalive_interval. The field name itself (`providerOptions`) is camelCase,
    // which is what snakeizeKeys' raw-key opaque check relies on to skip it.
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveConfig round-trips webrtc provider_options verbatim", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("saveConfig keeps authentication when role remains after stripping (WebRTC)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    const token = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    // WebRTC is the only channel where authentication survives the strip: role
    // is a valid field, so the container is kept rather than pruned to `{}`.
    const spec = {
      connection: {
        channel: "webrtc",
        server: { host: "api.peerjs.com" },
        authentication: {
          role: "inviter",
          sharedSecret: token,
          expires: "2028-01-01T00:00:00.000Z",
        },
      },
      linkageTerms: getDefaultLinkageTerms("Agency A"),
    } as unknown as ExchangeSpec;
    saveConfig(configPath, spec);
    const raw = fs.readFileSync(configPath, "utf8");
    // role survives and keeps the authentication container alive ...
    expect(raw).toContain("authentication:");
    expect(raw).toContain("role: inviter");
    // ... while the key material is still stripped.
    expect(raw).not.toContain("shared_secret");
    expect(raw).not.toContain(token);
    expect(raw).not.toContain("expires");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// --- loadConfigLinkageSource -------------------------------------------------

test("loadConfigLinkageSource returns undefined when no file exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
    expect(
      loadConfigLinkageSource(path.join(dir, "absent.yaml")),
    ).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfigLinkageSource round-trips the terms a saveConfig wrote", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfigLinkageSource round-trips an explicit standardization block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    const terms = getDefaultLinkageTerms("Agency A");
    const standardization = [
      { output: "ssn", input: "tax_id", steps: [{ function: "trim_whitespace" }] },
    ];
    saveConfig(configPath, {
      connection: { channel: "filedrop", path: "/mnt/share" },
      linkageTerms: terms,
      standardization,
    });
    expect(loadConfigLinkageSource(configPath)?.standardization).toEqual(
      standardization,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfigLinkageSource rejects a config with no linkage_terms", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    fs.writeFileSync(
      configPath,
      "connection:\n  channel: filedrop\n  path: /x\n",
    );
    expect(() => loadConfigLinkageSource(configPath)).toThrow(UsageError);
    expect(() => loadConfigLinkageSource(configPath)).toThrow("no linkage_terms");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfigLinkageSource rejects invalid linkage_terms", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    // linkage_terms present but missing the mandatory fields the schema requires.
    fs.writeFileSync(configPath, "linkage_terms:\n  identity: Agency A\n");
    expect(() => loadConfigLinkageSource(configPath)).toThrow(UsageError);
    expect(() => loadConfigLinkageSource(configPath)).toThrow(
      "invalid linkage_terms",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfigLinkageSource rejects an invalid standardization block", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfigLinkageSource rejects malformed YAML", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    fs.writeFileSync(configPath, "linkage_terms: [unclosed\n");
    expect(() => loadConfigLinkageSource(configPath)).toThrow(UsageError);
    expect(() => loadConfigLinkageSource(configPath)).toThrow(
      "could not be read or parsed",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfigLinkageSource rejects a non-mapping top-level value", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    // A top-level YAML array parses as an object in JS; it must be reported as a
    // malformed config, not misattributed to a missing linkage_terms block.
    fs.writeFileSync(configPath, "- a\n- b\n");
    expect(() => loadConfigLinkageSource(configPath)).toThrow(UsageError);
    expect(() => loadConfigLinkageSource(configPath)).toThrow(
      "not a valid configuration object",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI-only entry-sweep flags (195255994) ----------------------------------

test("connection.options.sweep_exchange_files is not a persistable config field (CLI-only)", () => {
  // The entry sweep is invocation-scoped: FileSyncOptionsSchema has no such
  // field, so the snake_case key is stripped at parse rather than flowing into
  // the connection options (where open() would otherwise read it).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-config-"));
  try {
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
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
