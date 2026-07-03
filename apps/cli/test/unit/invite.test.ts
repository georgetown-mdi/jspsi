import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import logLibrary from "loglevel";
import YAML from "yaml";
import {
  decodeInvitation,
  disclosedColumnNames,
  getDefaultLinkageTerms,
  getLogger,
  inferMetadata,
  StandardizationTermsError,
  UsageError,
} from "@psilink/core";
import type { LinkageTerms, Metadata, Standardization } from "@psilink/core";

import {
  handler as inviteHandler,
  offlineAbandonNotice,
  onlineWaitInvalidationNotice,
  resolveInvitePositionals,
  validateInvite,
} from "../../src/commands/invite";
import { saveConfig } from "../../src/config";
import { MAX_TIMEOUT_SECONDS } from "../../src/util/cli";
import { connectionFromEndpoint } from "../../src/commands/bootstrap";
import type { CommonBootstrapOptions } from "../../src/commands/bootstrap";

const silentLog = getLogger("invite-test");
silentLog.setLevel("silent");

let optionsCounter = 0;
// Minimal options pointing config/key at fresh, non-existent temp paths so the
// conflict gate passes and validateInvite reaches the step under test.
function testOptions(
  overrides: Partial<CommonBootstrapOptions> = {},
): CommonBootstrapOptions {
  const id = `${process.pid}-${optionsCounter++}`;
  return {
    configFile: path.join(tmpdir(), `psilink-invite-test-${id}.yaml`),
    keyFile: path.join(tmpdir(), `psilink-invite-test-${id}.key`),
    record: false,
    logLevel: logLibrary.levels.SILENT,
    verbosity: 0,
    ...overrides,
  };
}

// --- offline vs online dispatch ----------------------------------------------

test("no positionals dispatches offline with no input file", () => {
  const r = resolveInvitePositionals([]);
  expect(r.mode).toBe("offline");
  if (r.mode !== "offline") return;
  expect(r.input).toBeUndefined();
});

test("a lone input file dispatches offline", () => {
  const r = resolveInvitePositionals(["input.csv"]);
  expect(r.mode).toBe("offline");
  if (r.mode !== "offline") return;
  expect(r.input).toBe("input.csv");
});

test("a leading URL dispatches online with input and output", () => {
  const r = resolveInvitePositionals([
    "sftp://host/drop",
    "input.csv",
    "out.csv",
  ]);
  expect(r.mode).toBe("online");
  if (r.mode !== "online") return;
  expect(r.url.hostname).toBe("host");
  expect(r.input).toBe("input.csv");
  expect(r.output).toBe("out.csv");
});

test("an online invitation without an input file is a usage error", () => {
  expect(() => resolveInvitePositionals(["sftp://host/drop"])).toThrow(
    UsageError,
  );
  expect(() => resolveInvitePositionals(["sftp://host/drop"])).toThrow(
    "requires an input file",
  );
});

// --- validateInvite (the no-commit phase) ------------------------------------

test("validateInvite: an unsupported (webrtc) URL is rejected with no side effect", async () => {
  // Online dispatch validates the URL before reading input or minting a token,
  // so an unrunnable scheme aborts before the caller can disclose anything.
  await expect(
    validateInvite({
      resolved: {
        mode: "online",
        url: new URL("ws://host/path"),
        input: "input.csv",
      },
      options: testOptions(),
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

test("validateInvite: offline rejects a missing input file, preserving its exit code", async () => {
  await expect(
    validateInvite({
      resolved: { mode: "offline", input: "/nonexistent/psilink-input.csv" },
      options: testOptions(),
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toMatchObject({ exitCode: 69 });
});

test("validateInvite: offline requires an input file", async () => {
  await expect(
    validateInvite({
      resolved: { mode: "offline" },
      options: testOptions(),
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

test("validateInvite: a non-positive accept-timeout is rejected", async () => {
  await expect(
    validateInvite({
      resolved: {
        mode: "online",
        url: new URL("sftp://host/drop"),
        input: "input.csv",
      },
      options: testOptions(),
      acceptTimeout: 0,
      log: silentLog,
    }),
  ).rejects.toBeInstanceOf(UsageError);
});

// --- onlineWaitInvalidationNotice --------------------------------------------

test("onlineWaitInvalidationNotice: states the invitation is void on cancel/timeout and points at re-invite", () => {
  const notice = onlineWaitInvalidationNotice(900);
  // The accept-timeout bound is surfaced so the user knows how long the wait lasts.
  expect(notice).toContain("900s");
  // Each pre-acceptance exit that voids the invitation is named.
  expect(notice).toContain("Ctrl-C");
  expect(notice).toContain("connection times out");
  expect(notice).toContain("accept-timeout");
  // The consequence and the recovery: the invitation is unusable; re-invite.
  expect(notice).toContain("can no longer be accepted");
  expect(notice).toContain("psilink invite");
});

// --- offlineAbandonNotice ----------------------------------------------------

test("offlineAbandonNotice: names the key file as the early-abandonment path and spares the config", () => {
  const keyPath = "/tmp/agency-a/.psilink.key";
  const notice = offlineAbandonNotice(keyPath);
  // The actionable path -- delete this specific key file -- is named verbatim.
  expect(notice).toContain(keyPath);
  expect(notice).toContain("delete the key file");
  // The consequence: the abandoned invitation cannot complete a handshake.
  expect(notice).toContain("can no longer complete a handshake");
  // The config-safety promise (acceptance criterion: abandonment leaves an
  // existing recurring exchange's configuration intact) is stated.
  expect(notice).toContain("only the key file");
  expect(notice).toContain("configuration");
});

// --- pre-existing config/key on the online path ------------------------------

// 43-char base64url token satisfying the key-file format constraint.
const KEY_TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const d of tmpDirs.splice(0))
    fs.rmSync(d, { recursive: true, force: true });
});

/** A scratch directory with a small valid CSV; config/key default to fresh
 *  (non-existent) paths inside it so each test can occupy just what it needs. */
function onlineFixture(): { input: string; options: CommonBootstrapOptions } {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-online-"));
  tmpDirs.push(dir);
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn\nAlice,Smith,1990-01-02,123456789\n",
  );
  return {
    input,
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
  };
}

test("validateInvite: online warns (does not error) on a pre-existing key file", async () => {
  const { input, options } = onlineFixture();
  fs.writeFileSync(
    options.keyFile,
    JSON.stringify({ sharedSecret: KEY_TOKEN }),
  );
  const log = getLogger("invite-key-warn-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  // Completes without throwing: the pre-existing key is a warning on this path.
  await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options,
    acceptTimeout: 900,
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) =>
        typeof c[0] === "string" && c[0].includes("key file already exists"),
    ),
  ).toBe(true);
  warnSpy.mockRestore();
});

test("validateInvite: online still aborts on a pre-existing config file", async () => {
  const { input, options } = onlineFixture();
  fs.writeFileSync(options.configFile, "channel: filedrop\npath: /mnt/share\n");
  // A pre-existing config remains a hard conflict for invite (reusing it as the
  // terms source is a separate task); the config gate runs before the input read.
  await expect(
    validateInvite({
      resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
      options,
      acceptTimeout: 900,
      log: silentLog,
    }),
  ).rejects.toThrow(options.configFile);
});

// --- online invite emits a connection endpoint -------------------------------

test("validateInvite: online sftp emits a credential-free endpoint the acceptor seeds from", async () => {
  const { input, options } = onlineFixture();
  const ready = await validateInvite({
    resolved: {
      mode: "online",
      url: new URL("sftp://sftp.example.org:2222/exchanges/drop"),
      input,
    },
    // Credentials supplied via overrides: they reach the live connection but must
    // never reach the emitted endpoint.
    options: { ...options, serverUsername: "alice", serverPassword: "hunter2" },
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.connectionEndpoint).toEqual({
    channel: "sftp",
    host: "sftp.example.org",
    port: 2222,
    path: "/exchanges/drop",
  });
  // No credential material rode along (the strongest form of the invariant).
  expect(JSON.stringify(token.connectionEndpoint)).not.toContain("hunter2");
  expect(JSON.stringify(token.connectionEndpoint)).not.toContain("alice");
  // The acceptor seeds its connection block from the embedded endpoint, marking
  // the credential field for replacement (the same path web invitations exercise).
  const { connection, seeded } = connectionFromEndpoint(
    token.connectionEndpoint,
  );
  expect(seeded).toBe(true);
  if (connection.channel !== "sftp") throw new Error("expected sftp");
  expect(connection.server.host).toBe("sftp.example.org");
  expect(connection.server.path).toBe("/exchanges/drop");
  expect(connection.server.username).toMatch(/REPLACE_WITH/);
  expect(connection.server.password).toBeUndefined();
});

test("validateInvite: online carries the disclosed-columns subset from the inferred metadata", async () => {
  // An input with non-linkage columns: `notes` infers as an `other` payload column
  // and `member_id` as an `_id` row-identifier, both transmitted; the name/dob/ssn
  // linkage columns are not. The token must carry exactly that disclosed subset so
  // the acceptor's consent and lock-in derive from the wire's own predicate.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-disc-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn,notes,member_id\n" +
      "Alice,Smith,1990-01-02,123456789,vip,M001\n",
  );
  const ready = await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options: testOptions(),
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.disclosedPayloadColumns).toEqual(
    disclosedColumnNames(
      inferMetadata([
        "first_name",
        "last_name",
        "dob",
        "ssn",
        "notes",
        "member_id",
      ]),
    ),
  );
  expect(token.disclosedPayloadColumns).toEqual(["notes", "member_id"]);
  // The same disclosed set is persisted into the saved config's
  // disclosedPayloadColumns (the send-side commitment), so a later recurring
  // `psilink exchange` can verify its metadata still discloses it before
  // connecting -- byte-identical to the token copy.
  if (ready.mode !== "online") throw new Error("expected online mode");
  expect(ready.dataSpec.disclosedPayloadColumns).toEqual(
    token.disclosedPayloadColumns,
  );
});

test("validateInvite: offline infer-from-input persists the disclosed subset as the send commitment", async () => {
  // The offline infer path writes a config, so it persists the disclosed set it
  // published on the token into disclosedPayloadColumns too -- the send-side
  // commitment the later recurring `psilink exchange` checks.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-disc-off-"));
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn,notes,member_id\n" +
      "Alice,Smith,1990-01-02,123456789,vip,M001\n",
  );
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({ configFile: path.join(dir, "psilink.yaml") }),
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.disclosedPayloadColumns).toEqual(["notes", "member_id"]);
  if (ready.mode !== "offline") throw new Error("expected offline mode");
  expect(ready.dataSpec.disclosedPayloadColumns).toEqual(
    token.disclosedPayloadColumns,
  );
});

test("validateInvite: an all-linkage input carries an empty disclosed subset", async () => {
  // onlineFixture's CSV is first_name,last_name,dob,ssn -- all linkage columns, so
  // nothing is disclosed. The metadata is known (inferred from the input), so the
  // field is carried as the EMPTY set, locking the acceptor in to "receive nothing"
  // (a later non-empty payload aborts) rather than reconciling lazily.
  const { input, options } = onlineFixture();
  const ready = await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options,
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.disclosedPayloadColumns).toEqual([]);
});

// --- linkage strategy selection ----------------------------------------------

test("validateInvite: --linkage-strategy single-pass authors single-pass terms and notes the disclosure", async () => {
  const { input, options } = onlineFixture();
  const log = getLogger("invite-strategy-test");
  log.setLevel("silent");
  const infoSpy = vi.spyOn(log, "info");
  try {
    const ready = await validateInvite({
      resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
      options,
      acceptTimeout: 900,
      linkageStrategy: "single-pass",
      log,
    });
    // The selection flows into the authored terms the invitation carries, so the
    // mandatory-consistency check sees single-pass on both sides.
    const token = await decodeInvitation(ready.invitation);
    expect(token.linkageTerms.linkageStrategy).toBe("single-pass");
    // The disclosure tradeoff is surfaced at the point of selection.
    const info = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(info).toContain("consented disclosure tradeoff");
    expect(info).toContain("docs/EXCHANGE_REFERENCE.md");
  } finally {
    infoSpy.mockRestore();
  }
});

test("validateInvite: omitting --linkage-strategy authors cascade with no disclosure note", async () => {
  // The default is unchanged from before the flag existed: cascade, and no note.
  const { input, options } = onlineFixture();
  const log = getLogger("invite-strategy-default-test");
  log.setLevel("silent");
  const infoSpy = vi.spyOn(log, "info");
  try {
    const ready = await validateInvite({
      resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
      options,
      acceptTimeout: 900,
      log,
    });
    const token = await decodeInvitation(ready.invitation);
    expect(token.linkageTerms.linkageStrategy).toBe("cascade");
    const info = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(info).not.toContain("consented disclosure tradeoff");
  } finally {
    infoSpy.mockRestore();
  }
});

test("validateInvite: offline infer-from-input also carries the selected single-pass strategy and notes the disclosure", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-sp-offline-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const log = getLogger("invite-strategy-offline-test");
  log.setLevel("silent");
  const infoSpy = vi.spyOn(log, "info");
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline", input },
      options: testOptions({
        configFile: path.join(dir, "psilink.yaml"),
        keyFile: path.join(dir, ".psilink.key"),
      }),
      acceptTimeout: 900,
      linkageStrategy: "single-pass",
      log,
    });
    expect(ready.mode).toBe("offline");
    const token = await decodeInvitation(ready.invitation);
    expect(token.linkageTerms.linkageStrategy).toBe("single-pass");
    // The offline-infer path emits the same disclosure note as the online path;
    // assert it fired so deleting the note from this branch is caught here, not
    // only by the online test.
    const info = infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(info).toContain("consented disclosure tradeoff");
  } finally {
    infoSpy.mockRestore();
  }
});

test("validateInvite: --linkage-strategy is warned-ignored when terms come from a config", async () => {
  // Config-as-source: the config is authoritative, so the flag must not silently
  // override its linkage_strategy. The flag is named as ignored and the minted
  // terms keep the config's strategy.
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  const log = getLogger("invite-strategy-config-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      linkageStrategy: "single-pass",
      log,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    const token = await decodeInvitation(ready.invitation);
    // cascade: the config's strategy, not the ignored flag's single-pass.
    expect(token.linkageTerms.linkageStrategy).toBe("cascade");
    const warn = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    // The warning names what was requested and what the config uses instead, so
    // an operator who wanted single-pass sees they did not get it.
    expect(warn).toContain("--linkage-strategy single-pass has no effect");
    expect(warn).toContain("linkage_strategy (cascade) is used instead");
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config's single-pass strategy is preserved when no flag is passed, with no warning", async () => {
  // The reverse of the warn case: a config that selects single-pass is honored
  // verbatim when the operator passes no flag, and the ignore-warning stays quiet.
  const terms: LinkageTerms = {
    ...defaultTerms(),
    linkageStrategy: "single-pass",
  };
  const { dir, configPath, keyPath } = withConfig(terms);
  const log = getLogger("invite-strategy-config-keep-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    const token = await decodeInvitation(ready.invitation);
    expect(token.linkageTerms.linkageStrategy).toBe("single-pass");
    const warn = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warn).not.toContain("has no effect");
  } finally {
    warnSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: online filedrop emits the shared-path endpoint", async () => {
  const { input, options } = onlineFixture();
  const ready = await validateInvite({
    resolved: { mode: "online", url: new URL("file:///mnt/share/drop"), input },
    options,
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.connectionEndpoint).toEqual({
    channel: "filedrop",
    path: "/mnt/share/drop",
  });
});

test("validateInvite: a split online invite emits the pair verbatim, acceptor mirror-swaps", async () => {
  // --outbound-path makes the connection split (URL path = inbound, override =
  // outbound). The endpoint carries the inviter's pair unswapped; the acceptor's
  // connectionFromEndpoint lands the inviter's outbound on the acceptor's inbound,
  // making the two parties mirror images (item 202418344's consumer, end-to-end).
  const { input, options } = onlineFixture();
  const ready = await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/inviter-in"), input },
    options: { ...options, outboundPath: "/inviter-out", retainFiles: true },
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  if (token.connectionEndpoint?.channel !== "sftp")
    throw new Error("expected sftp endpoint");
  // Verbatim at emit: no pre-swap.
  expect(token.connectionEndpoint.inboundPath).toBe("/inviter-in");
  expect(token.connectionEndpoint.outboundPath).toBe("/inviter-out");
  // Swapped at the acceptor.
  const { connection } = connectionFromEndpoint(token.connectionEndpoint);
  if (connection.channel !== "sftp") throw new Error("expected sftp");
  expect(connection.server.inboundPath).toBe("/inviter-out");
  expect(connection.server.outboundPath).toBe("/inviter-in");
});

test("validateInvite: an offline invitation carries no endpoint (field stays optional)", async () => {
  // Only the online producer emits an endpoint; an offline invitation omits it
  // and still encodes/decodes cleanly, so no regression for tokens minted
  // elsewhere (the field is optional).
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-noendpoint-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    log: silentLog,
  });
  const token = await decodeInvitation(ready.invitation);
  expect(token.connectionEndpoint).toBeUndefined();
});

// --- validateInvite: offline, config as the linkage-terms source -------------

// Terms an inviter's config would carry after being generated from an input
// with first/last name, dob, and ssn columns: passing that metadata drops the
// default keys (and the ssn4 field) the input cannot satisfy, so the terms
// reference exactly firstName, lastName, dateOfBirth, and ssn.
function defaultTerms(): LinkageTerms {
  return getDefaultLinkageTerms(
    "Agency A",
    inferMetadata(["first_name", "last_name", "dob", "ssn"]),
  );
}

// A pre-existing config carrying `terms` (and optionally an explicit
// `standardization` and/or `metadata`) is written to a temp dir; the helper
// returns the paths so a test can point its options at them. The connection is a
// placeholder -- invite does not use it.
function withConfig(
  terms: LinkageTerms,
  standardization?: Standardization,
  metadata?: Metadata,
): { dir: string; configPath: string; keyPath: string } {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-cfg-"));
  const configPath = path.join(dir, "psilink.yaml");
  saveConfig(configPath, {
    connection: { channel: "filedrop", path: "/mnt/share" },
    linkageTerms: terms,
    ...(standardization !== undefined && { standardization }),
    ...(metadata !== undefined && { metadata }),
  });
  return { dir, configPath, keyPath: path.join(dir, ".psilink.key") };
}

function writeCsv(dir: string, header: string): string {
  const p = path.join(dir, "input.csv");
  fs.writeFileSync(p, `${header}\nAlice,Smith,1990-01-02,123456789\n`);
  return p;
}

test("validateInvite: derives terms from a config when no input file is given", async () => {
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    if (ready.mode !== "offlineFromConfig") return;
    expect(ready.configPath).toBe(configPath);
    expect(ready.linkageTerms).toEqual(terms);
    // The minted invitation carries the config's terms, not inferred ones.
    const token = await decodeInvitation(ready.invitation);
    expect(token.linkageTerms).toEqual(terms);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: config-as-source threads the disclosed subset for the send commitment", async () => {
  // A config with an explicit metadata block: the disclosed set is derived from
  // it, carried on the token, AND threaded to the handler so it is persisted into
  // the reused config's disclosed_payload_columns (closing the init-config gap and
  // refreshing a stale prior commitment on re-invite).
  const terms = defaultTerms();
  const metadata = inferMetadata([
    "first_name",
    "last_name",
    "dob",
    "ssn",
    "notes",
  ]);
  const { dir, configPath, keyPath } = withConfig(terms, undefined, metadata);
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    if (ready.mode !== "offlineFromConfig") return;
    const token = await decodeInvitation(ready.invitation);
    expect(ready.disclosedPayloadColumns).toEqual(
      disclosedColumnNames(metadata),
    );
    expect(ready.disclosedPayloadColumns).toEqual(
      token.disclosedPayloadColumns,
    );
    expect(ready.disclosedPayloadColumns).toEqual(["notes"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: config-as-source with no metadata block carries no commitment (lazy)", async () => {
  // Without a metadata block the transmitted set is unknown at mint, so nothing is
  // committed and the handler removes any stale field rather than freezing one.
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    if (ready.mode !== "offlineFromConfig") return;
    expect(ready.disclosedPayloadColumns).toBeUndefined();
    const token = await decodeInvitation(ready.invitation);
    expect(token.disclosedPayloadColumns).toBeUndefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config plus an agreeing input file succeeds from the config", async () => {
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const ready = await validateInvite({
      resolved: { mode: "offline", input },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
    if (ready.mode !== "offlineFromConfig") return;
    expect(ready.linkageTerms).toEqual(terms);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config plus a disagreeing input fails naming the unsatisfiable fields", async () => {
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    // Only a first-name column: last name, dob, and ssn cannot be produced.
    const input = writeCsv(dir, "first_name,notes,memo,comment");
    const promise = validateInvite({
      resolved: { mode: "offline", input },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    await expect(promise).rejects.toBeInstanceOf(UsageError);
    await expect(promise).rejects.toThrow(/last_name/);
    await expect(promise).rejects.toThrow(/cannot satisfy/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config whose payload.send over-declares is rejected before minting", async () => {
  // An explicit metadata block gates `secret` off (role: ignored), but the
  // hand-authored payload.send still lists it. The over-declaration must be
  // caught at the mint boundary, before the token or the partner's consent
  // screen can carry a column whose values never flow.
  const terms: LinkageTerms = {
    ...defaultTerms(),
    payload: { send: [{ name: "secret" }] },
  };
  const metadata: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    { name: "secret", type: "other", role: "ignored", isPayload: true },
  ];
  const { dir, configPath, keyPath } = withConfig(terms, undefined, metadata);
  try {
    const promise = validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    await expect(promise).rejects.toBeInstanceOf(UsageError);
    await expect(promise).rejects.toThrow(/secret/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config's explicit standardization lets an otherwise-unsatisfying input pass", async () => {
  const terms = defaultTerms();
  // The config maps tax_id -> ssn explicitly; the input carries tax_id (inferred
  // as an identifier, not ssn) rather than an ssn column, so without the
  // standardization the ssn field would be unsatisfiable. The remap binds only a
  // `role: linkage` column (matching participation is the explicit linkage role),
  // so the config roles tax_id linkage while leaving its type non-ssn -- the
  // remap, not the type fallback, is what binds it.
  const metadata: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
    { name: "dob", type: "date_of_birth", role: "linkage", isPayload: false },
    { name: "tax_id", type: "identifier", role: "linkage", isPayload: false },
  ];
  const { dir, configPath, keyPath } = withConfig(
    terms,
    [
      {
        output: "ssn",
        input: "tax_id",
        steps: [{ function: "trim_whitespace" }],
      },
    ],
    metadata,
  );
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,tax_id");
    const ready = await validateInvite({
      resolved: { mode: "offline", input },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: offline config-source refuses a standardization that contradicts its terms, before minting", async () => {
  // The mint-boundary counterpart of the exchange-time fail-closed check: a config
  // whose authored standardization names an output that is no declared linkage
  // field must be refused BEFORE the token is disclosed, so `invite` never mints a
  // token the config's own `psilink exchange` would then reject (exit 64). No input
  // is passed, so this exercises the check in isolation from the input-satisfiability
  // gate.
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms, [
    { output: "definitely_not_a_field_xyz", input: "first_name" },
  ]);
  try {
    const invite = () =>
      validateInvite({
        resolved: { mode: "offline" },
        options: testOptions({ configFile: configPath, keyFile: keyPath }),
        acceptTimeout: 900,
        log: silentLog,
      });
    await expect(invite()).rejects.toThrow(StandardizationTermsError);
    // The refusal names the offending output, so the operator can fix the config.
    await expect(invite()).rejects.toThrow(/definitely_not_a_field_xyz/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: offline config-source refuses a psi-c algorithm before minting", async () => {
  // The mint-boundary counterpart of the run-side count-only refusal: a config
  // whose `algorithm` is `psi-c` (advertised but not yet runnable) must be refused
  // BEFORE the token is disclosed, so `invite` never mints an invitation the
  // config's own `psilink exchange` would then reject (exit 64) -- the same
  // fail-fast, mint-mirrors-run posture as the payload and standardization guards
  // above. No input is passed, so it exercises the check in isolation.
  const terms: LinkageTerms = { ...defaultTerms(), algorithm: "psi-c" };
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    const invite = () =>
      validateInvite({
        resolved: { mode: "offline" },
        options: testOptions({ configFile: configPath, keyFile: keyPath }),
        acceptTimeout: 900,
        log: silentLog,
      });
    await expect(invite()).rejects.toBeInstanceOf(UsageError);
    await expect(invite()).rejects.toThrow(/psi-c/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: a config's explicit metadata lets an otherwise-unsatisfying input pass", async () => {
  const terms = defaultTerms();
  // The config's metadata types tax_id as ssn; the input carries tax_id, which
  // name inference would type as an identifier (not ssn). Without honoring the
  // config metadata the ssn field would look unsatisfiable and invite would
  // refuse, even though the exchange (which uses the metadata) can produce it.
  const metadata: Metadata = [
    {
      name: "first_name",
      type: "first_name",
      role: "linkage",
      isPayload: false,
    },
    { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
    { name: "dob", type: "date_of_birth", role: "linkage", isPayload: false },
    { name: "tax_id", type: "ssn", role: "linkage", isPayload: false },
  ];
  const { dir, configPath, keyPath } = withConfig(terms, undefined, metadata);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,tax_id");
    const ready = await validateInvite({
      resolved: { mode: "offline", input },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offlineFromConfig");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: config-sourced invite still refuses a pre-existing key file", async () => {
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    fs.writeFileSync(
      keyPath,
      JSON.stringify({
        sharedSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    );
    await expect(
      validateInvite({
        resolved: { mode: "offline" },
        options: testOptions({ configFile: configPath, keyFile: keyPath }),
        acceptTimeout: 900,
        log: silentLog,
      }),
    ).rejects.toBeInstanceOf(UsageError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: with no config and an input file, terms are inferred and written", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-infer-"));
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const ready = await validateInvite({
      resolved: { mode: "offline", input },
      // Fresh, non-existent config/key paths: the input-only inference path.
      options: testOptions(),
      acceptTimeout: 900,
      log: silentLog,
    });
    expect(ready.mode).toBe("offline");
    if (ready.mode !== "offline") return;
    expect(ready.dataSpec.linkageTerms.identity).toBeTypeOf("string");
    expect(ready.dataSpec.metadata).toBeDefined();
    expect(ready.dataSpec.standardization).toBeDefined();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- validateInvite: offline connection-override warning ---------------------

test("validateInvite: offline warns that a --server-* override is ignored", async () => {
  // The offline path writes a placeholder connection block, so a --server-*
  // override cannot take effect; it must be surfaced rather than silently dropped.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-override-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const log = getLogger("invite-offline-override-warn");
  log.setLevel("warn");
  const warnSpy = vi.spyOn(log, "warn");
  await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
      serverUsername: "alice",
    }),
    acceptTimeout: 900,
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("--server-username") &&
        c[0].includes("no effect on an offline invite/accept"),
    ),
  ).toBe(true);
  warnSpy.mockRestore();
});

test("validateInvite: online does not warn about a --server-* override (it is applied)", async () => {
  // The online path builds the connection from the URL through
  // applyConnectionOverrides, so the override takes effect and no ignored-override
  // warning is emitted.
  const { input, options } = onlineFixture();
  const log = getLogger("invite-online-override-nowarn");
  log.setLevel("warn");
  const warnSpy = vi.spyOn(log, "warn");
  const ready = await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options: { ...options, serverUsername: "alice" },
    acceptTimeout: 900,
    log,
  });
  expect(ready.mode).toBe("online");
  if (ready.mode !== "online") return;
  if (ready.connection.channel !== "sftp") throw new Error("expected sftp");
  expect(ready.connection.server.username).toBe("alice");
  expect(
    warnSpy.mock.calls.some(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("no effect on an offline invite/accept"),
    ),
  ).toBe(false);
  warnSpy.mockRestore();
});

test("validateInvite: offline warns that a connection-options override is ignored", async () => {
  // The offline path writes a placeholder connection block with no `options`
  // block, so a --peer-timeout (or any connection-options) override cannot take
  // effect; it must be surfaced, with a remedy distinct from the server warning's
  // -- pointing at connection.options.
  const dir = fs.mkdtempSync(
    path.join(tmpdir(), "psilink-invite-opt-override-"),
  );
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const log = getLogger("invite-offline-opt-override-warn");
  log.setLevel("warn");
  const warnSpy = vi.spyOn(log, "warn");
  await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
      peerTimeout: 60,
    }),
    acceptTimeout: 900,
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("--peer-timeout") &&
        c[0].includes("connection.options"),
    ),
  ).toBe(true);
  warnSpy.mockRestore();
});

test("validateInvite: offline does not warn about connection.options when no options flag is set", async () => {
  // No connection-options flag is set, so the connection.options warning must
  // stay silent. acceptTimeout is a separate param, NOT a --peer-timeout
  // override: it feeds peerTimeout only on the online path (via the override
  // bag's `extra`), so an offline invite that sets it must not warn spuriously
  // about a dropped --peer-timeout.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-no-opt-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const log = getLogger("invite-offline-no-opt-warn");
  log.setLevel("warn");
  const warnSpy = vi.spyOn(log, "warn");
  await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) => typeof c[0] === "string" && c[0].includes("connection.options"),
    ),
  ).toBe(false);
  warnSpy.mockRestore();
});

test("validateInvite: online does not warn about a connection-options override (it is applied)", async () => {
  // The online path builds the connection from the URL through
  // applyConnectionOverrides, so a connection-options override takes effect and
  // no ignored-override warning is emitted.
  const { input, options } = onlineFixture();
  const log = getLogger("invite-online-opt-override-nowarn");
  log.setLevel("warn");
  const warnSpy = vi.spyOn(log, "warn");
  const ready = await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options: { ...options, maxReconnectAttempts: 5 },
    acceptTimeout: 900,
    log,
  });
  expect(ready.mode).toBe("online");
  if (ready.mode !== "online") return;
  expect(ready.connection.options?.maxReconnectAttempts).toBe(5);
  expect(
    warnSpy.mock.calls.some(
      (c) => typeof c[0] === "string" && c[0].includes("connection.options"),
    ),
  ).toBe(false);
  warnSpy.mockRestore();
});

// --- validateInvite: --expires-in override -----------------------------------

test("validateInvite: --expires-in sets the token's expiry to the override", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-expires-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const before = Date.now();
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    expiresIn: "2h",
    log: silentLog,
  });
  const after = Date.now();
  const token = await decodeInvitation(ready.invitation);
  expect(token.expires).toBeDefined();
  if (token.expires === undefined) return;
  // The expiry is two hours past the moment the token was minted, which lies in
  // [before, after]; bound it on both sides rather than assert an exact value.
  const twoHours = 2 * 60 * 60 * 1000;
  const expiresMs = new Date(token.expires).getTime();
  expect(expiresMs).toBeGreaterThanOrEqual(before + twoHours);
  expect(expiresMs).toBeLessThanOrEqual(after + twoHours);
});

test("validateInvite: omitting --expires-in keeps the one-hour default", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-default-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const before = Date.now();
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    log: silentLog,
  });
  const after = Date.now();
  const token = await decodeInvitation(ready.invitation);
  expect(token.expires).toBeDefined();
  if (token.expires === undefined) return;
  const oneHour = 60 * 60 * 1000;
  const expiresMs = new Date(token.expires).getTime();
  expect(expiresMs).toBeGreaterThanOrEqual(before + oneHour);
  expect(expiresMs).toBeLessThanOrEqual(after + oneHour);
});

test("validateInvite: a zero --expires-in is rejected before any token is minted", async () => {
  // A non-existent input would itself error once read; the duration is parsed at
  // the very top of validateInvite, so the duration rejection -- not the missing
  // input -- is what surfaces, proving no token is minted on a bad override.
  const promise = validateInvite({
    resolved: { mode: "offline", input: "/nonexistent/psilink-input.csv" },
    options: testOptions(),
    acceptTimeout: 900,
    expiresIn: "0m",
    log: silentLog,
  });
  await expect(promise).rejects.toBeInstanceOf(UsageError);
  await expect(promise).rejects.toThrow(/duration/);
});

test("validateInvite: an --expires-in beyond the one-year maximum is rejected before any token is minted", async () => {
  // Nonexistent input, as in the zero case: the override is bounded at the top
  // of validateInvite, so the ceiling rejection -- not the missing input -- is
  // what surfaces, proving no token is minted.
  const promise = validateInvite({
    resolved: { mode: "offline", input: "/nonexistent/psilink-input.csv" },
    options: testOptions(),
    acceptTimeout: 900,
    expiresIn: "366d",
    log: silentLog,
  });
  await expect(promise).rejects.toBeInstanceOf(UsageError);
  await expect(promise).rejects.toThrow(/expires-in must not exceed/);
});

test("validateInvite: an --expires-in at the one-year maximum is accepted", async () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-max-"));
  tmpDirs.push(dir);
  const input = writeCsv(dir, "first_name,last_name,dob,ssn");
  const before = Date.now();
  const ready = await validateInvite({
    resolved: { mode: "offline", input },
    options: testOptions({
      configFile: path.join(dir, "psilink.yaml"),
      keyFile: path.join(dir, ".psilink.key"),
    }),
    acceptTimeout: 900,
    expiresIn: "365d",
    log: silentLog,
  });
  const after = Date.now();
  const token = await decodeInvitation(ready.invitation);
  expect(token.expires).toBeDefined();
  if (token.expires === undefined) return;
  const oneYear = 365 * 24 * 60 * 60 * 1000;
  const expiresMs = new Date(token.expires).getTime();
  expect(expiresMs).toBeGreaterThanOrEqual(before + oneYear);
  expect(expiresMs).toBeLessThanOrEqual(after + oneYear);
});

test("validateInvite: --expires-in applies on the offlineFromConfig path", async () => {
  const terms = defaultTerms();
  const { dir, configPath, keyPath } = withConfig(terms);
  try {
    const before = Date.now();
    const ready = await validateInvite({
      resolved: { mode: "offline" },
      options: testOptions({ configFile: configPath, keyFile: keyPath }),
      acceptTimeout: 900,
      expiresIn: "2h",
      log: silentLog,
    });
    const after = Date.now();
    expect(ready.mode).toBe("offlineFromConfig");
    const token = await decodeInvitation(ready.invitation);
    expect(token.expires).toBeDefined();
    if (token.expires === undefined) return;
    const twoHours = 2 * 60 * 60 * 1000;
    const expiresMs = new Date(token.expires).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + twoHours);
    expect(expiresMs).toBeLessThanOrEqual(after + twoHours);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("validateInvite: online warns when --expires-in is shorter than --accept-timeout", async () => {
  const { input, options } = onlineFixture();
  const log = getLogger("invite-lifetime-warn-test");
  log.setLevel("silent");
  const warnSpy = vi.spyOn(log, "warn");
  // 5m lifetime under a 15m accept-timeout: the inviter would wait past the
  // point the token can be honored, so the warning fires and names the resolved
  // override lifetime (300s), not the default hour.
  await validateInvite({
    resolved: { mode: "online", url: new URL("sftp://host/drop"), input },
    options,
    acceptTimeout: 900,
    expiresIn: "5m",
    log,
  });
  expect(
    warnSpy.mock.calls.some(
      (c) =>
        typeof c[0] === "string" &&
        c[0].includes("exceeds the invitation") &&
        c[0].includes("(300s)"),
    ),
  ).toBe(true);
  warnSpy.mockRestore();
});

// --- handler: repeated single-value flag -------------------------------------

test("handler: a repeated --accept-timeout is rejected (exit 64) before validation runs", async () => {
  // The concrete instance `psilink invite --accept-timeout 60 --accept-timeout
  // 120`: the handler reads accept-timeout via singleValue before
  // resolveInvitePositionals/validateInvite, so the repeat fails with a clean
  // usage error (exit 64) instead of reaching the `acceptTimeout <= 0` /
  // `acceptTimeout > lifetimeSeconds` comparisons in validateInvite with an array
  // operand. A valid input file is present, so without the guard validateInvite
  // would mint and print the token and write both files; the guard means none of
  // that happens -- which is exactly what the assertions below check.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-dup-"));
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const configFile = path.join(dir, "psilink.yaml");
    const keyFile = path.join(dir, ".psilink.key");
    await inviteHandler({
      _: [],
      $0: "psilink",
      args: [input],
      "accept-timeout": [60, 120],
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    // Assert before restoring the spies: mockRestore clears the recorded calls.
    expect(exit).toHaveBeenCalledWith(64);
    // No invitation token reached stdout and neither file was written, so
    // validateInvite (and the commit that follows it) never ran.
    expect(logSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: a bare-integer --accept-timeout is rejected (exit 64) before any side effect", async () => {
  // `psilink invite --accept-timeout 60`: the value migrated to the duration
  // syntax, so a bare number is no longer accepted. The handler parses it (via
  // durationFlagSeconds) before resolveInvitePositionals/validateInvite, so the
  // rejection fires before the offline commit would mint and print the token and
  // write both files -- exactly the no-side-effect guarantee asserted below.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-bare-"));
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const configFile = path.join(dir, "psilink.yaml");
    const keyFile = path.join(dir, ".psilink.key");
    await inviteHandler({
      _: [],
      $0: "psilink",
      args: [input],
      "accept-timeout": "60",
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).toHaveBeenCalledWith(64);
    expect(logSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: an --accept-timeout above the 7d ceiling is rejected (exit 64) before any side effect", async () => {
  // `psilink invite --accept-timeout 8d`: the value is well-formed but past the
  // sanity ceiling, so durationFlagSeconds (with MAX_TIMEOUT_SECONDS) rejects it
  // (exit 64) before resolveInvitePositionals/validateInvite -- so the offline
  // commit never mints or prints the token or writes either file, exactly as the
  // bare-integer case above. The flag-named, max-stating message content is
  // asserted at the shared seam (cli.test.ts). One day past the 7d cap.
  const overCeiling = `${MAX_TIMEOUT_SECONDS / 86_400 + 1}d`;
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-cap-"));
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const configFile = path.join(dir, "psilink.yaml");
    const keyFile = path.join(dir, ".psilink.key");
    await inviteHandler({
      _: [],
      $0: "psilink",
      args: [input],
      "accept-timeout": overCeiling,
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).toHaveBeenCalledWith(64);
    expect(logSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: an unrecognized --linkage-strategy is rejected (exit 64) before any side effect", async () => {
  // The handler validates the enum (parseLinkageStrategyFlag) inside runOrExit
  // before resolveInvitePositionals/validateInvite, so a bad value is a clean
  // usage error (exit 64) and no token reaches stdout and no files are written --
  // pinning the wiring symmetrically with the --accept-timeout guards above (the
  // parser itself is unit-tested in bootstrap.test.ts).
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-strat-"));
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    const input = writeCsv(dir, "first_name,last_name,dob,ssn");
    const configFile = path.join(dir, "psilink.yaml");
    const keyFile = path.join(dir, ".psilink.key");
    await inviteHandler({
      _: [],
      $0: "psilink",
      args: [input],
      "linkage-strategy": "complete",
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).toHaveBeenCalledWith(64);
    expect(logSpy).not.toHaveBeenCalled();
    expect(fs.existsSync(configFile)).toBe(false);
    expect(fs.existsSync(keyFile)).toBe(false);
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- handler: the send commitment is persisted end-to-end --------------------

test("handler: offline-from-config persists the disclosed subset into the reused config", async () => {
  // The end-to-end wiring this whole change exists for. `psilink invite` from a
  // pre-existing config with a metadata block reuses that config (writing only the
  // key) and refreshes disclosed_payload_columns in place, so the later recurring
  // exchange has the commitment to check. validateInvite is tested above; this
  // proves the handler actually calls persistDisclosedPayloadColumns on the reused
  // config (the offlineFromConfig branch), not merely that the value is threaded.
  const metadata = inferMetadata([
    "first_name",
    "last_name",
    "dob",
    "ssn",
    "notes",
  ]);
  const { dir, configPath, keyPath } = withConfig(
    defaultTerms(),
    undefined,
    metadata,
  );
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      args: [],
      "config-file": configPath,
      "key-file": keyPath,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    // The branch ran to completion: the key was written and no usage-error exit.
    expect(exit).not.toHaveBeenCalledWith(64);
    expect(fs.existsSync(keyPath)).toBe(true);
    // The reused config now carries the send commitment, equal to the disclosed set.
    const parsed = YAML.parse(fs.readFileSync(configPath, "utf8")) as {
      disclosed_payload_columns?: string[];
    };
    expect(parsed.disclosed_payload_columns).toEqual(
      disclosedColumnNames(metadata),
    );
    expect(parsed.disclosed_payload_columns).toEqual(["notes"]);
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("handler: offline infer-from-input writes the disclosed subset into the fresh config", async () => {
  // The fresh-config counterpart: `psilink invite input.csv` infers metadata,
  // mints, and writes a new config via saveConfig; disclosed_payload_columns must
  // land in that written file (not just on the token) so the recurring exchange can
  // enforce it -- proven here on the written file, not only at the validateInvite
  // return value.
  const dir = fs.mkdtempSync(path.join(tmpdir(), "psilink-invite-infer-"));
  const configFile = path.join(dir, "psilink.yaml");
  const keyFile = path.join(dir, ".psilink.key");
  const input = path.join(dir, "input.csv");
  fs.writeFileSync(
    input,
    "first_name,last_name,dob,ssn,notes\nAlice,Smith,1990-01-02,123456789,hi\n",
  );
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  try {
    await inviteHandler({
      _: [],
      $0: "psilink",
      args: [input],
      "config-file": configFile,
      "key-file": keyFile,
      "log-level": "silent",
      record: false,
    } as unknown as Arguments);
    expect(exit).not.toHaveBeenCalledWith(64);
    expect(fs.existsSync(configFile)).toBe(true);
    const parsed = YAML.parse(fs.readFileSync(configFile, "utf8")) as {
      disclosed_payload_columns?: string[];
    };
    expect(parsed.disclosed_payload_columns).toEqual(["notes"]);
  } finally {
    logSpy.mockRestore();
    exit.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
