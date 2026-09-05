import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";
import logLibrary from "loglevel";
import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  getDiagnosticSink,
  keyTypeFromBlob,
  MAX_ERROR_CAUSE_DEPTH,
  sanitizeErrorForDisplay,
  setDiagnosticSink,
  UsageError,
} from "@psilink/core";
import { MAX_ENDPOINT_HOST_LENGTH } from "@psilink/core/testing";
import type { ConnectionConfig, PresentedHostKey } from "@psilink/core";

import {
  establishHostKeyTrust,
  type HostKeyPersistence,
  type HostKeyTrustDeps,
} from "../../src/hostKeyTrust";
import { applyConnectionOverrides } from "../../src/config";
import { connectionOverridesFrom } from "../../src/optionDefinitions";
import { snapshotDiagnosticSinkAndLevel } from "../loggingTestSupport";

snapshotDiagnosticSinkAndLevel();

// establishHostKeyTrust gates the interactive prompt on stdin being a TTY. The
// tests drive that flag deterministically and restore it afterward; the
// non-interactive default (isTTY undefined) is what an automated run sees.
const originalIsTTY = process.stdin.isTTY;
afterEach(() => {
  process.stdin.isTTY = originalIsTTY;
});

const FP = "SHA256:" + "A".repeat(43);

function sftpConn(
  pin?: string | string[],
  host = "sftp.example.org",
): ConnectionConfig {
  return {
    channel: "sftp",
    server: {
      host,
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

test("a probe failure propagates unchanged and pins nothing", async () => {
  // A dial that never reaches a host key -- a refused connection, an
  // unresolvable name -- rejects out of the probe. There is no recovery here:
  // the rejection reaches the caller as the error the probe raised, so the
  // exchange path classifies a connect failure exactly as it would with no trust
  // step, and neither the prompt nor a pin follows it.
  const conn = sftpConn();
  const failure = new Error("connect ECONNREFUSED 203.0.113.9:22");
  let confirmCalls = 0;
  const deps: HostKeyTrustDeps = {
    probe: () => Promise.reject(failure),
    confirm: () => {
      confirmCalls++;
      return Promise.resolve(true);
    },
  };
  process.stdin.isTTY = true; // interactive, so the probe is reached
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
  ).rejects.toBe(failure);
  expect(confirmCalls).toBe(0);
  if (conn.channel === "sftp")
    expect(conn.server.hostKeyFingerprint).toBeUndefined();
});

test("is a no-op when a list of host_key_fingerprints is already pinned", async () => {
  // First-use trust gates on the pin being unset (=== undefined), which is
  // value-agnostic: a config already holding multiple pins (a staged rotation)
  // is just as "pinned" as one holding a single string and must not re-prompt.
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
  // value a stored (config-file) pin would hold -- so it reaches the identical
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
  // The in-memory connection now has the confirmed pin (so open() enforces).
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

test("declining under the config-writing mode leaves the file byte-identical", async () => {
  // The refusal tells the operator nothing was written, and write-now is the one
  // mode that writes at all -- so the claim is measured against the bytes of the
  // config a confirmation WOULD have been persisted into, not just against the
  // in-memory connection.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-hkt-declined-"));
  try {
    const configPath = path.join(dir, "psilink.yaml");
    const before =
      "connection:\n  channel: sftp\n  server:\n    host: sftp.example.org\n";
    fs.writeFileSync(configPath, before);
    const conn = sftpConn();
    const deps = makeDeps({ confirm: false });
    process.stdin.isTTY = true;
    await expect(
      establishHostKeyTrust(
        conn,
        {
          verbosity: -1,
          loggerName: "exchange",
          persistence: { mode: "write-now", configPath },
        },
        deps,
      ),
    ).rejects.toThrow(/not trusted/);
    expect(deps.confirmCalls).toBe(1);
    expect(fs.readFileSync(configPath, "utf8")).toBe(before);
    expect(fs.readdirSync(dir)).toEqual(["psilink.yaml"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A raw OpenSSH host-key blob naming `keyType`: a uint32 length prefix, the type
// bytes, then key bytes. Nothing bounds what a server puts in the type field, so
// the bytes are written here exactly as a hostile server would send them.
function hostKeyBlobNaming(keyType: string): Uint8Array {
  const type = new TextEncoder().encode(keyType);
  const blob = new Uint8Array(4 + type.length + 32);
  new DataView(blob.buffer).setUint32(0, type.length);
  blob.set(type, 4);
  return blob;
}

/** Collect every diagnostic line the callback's run emits, sink restored after. */
async function withCapturedDiagnostics(
  run: () => Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const previous = getDiagnosticSink();
  setDiagnosticSink((_method, prefix, args) =>
    lines.push([prefix, ...args.map((arg) => String(arg))].join(" ")),
  );
  try {
    await run();
  } finally {
    setDiagnosticSink(previous);
  }
  return lines;
}

test("the trust prompt names the bounded key type, never the server's bytes", async () => {
  // The prompt shows whatever the probe observed, and what the probe observes is
  // keyTypeFromBlob's output -- so the type is taken from the real primitive over
  // a hostile blob rather than from a string chosen here. A key type outside the
  // accepted charset reaches the operator as the placeholder, and none of the
  // server's own bytes reach the terminal at all.
  const conn = sftpConn();
  const deps = makeDeps({
    confirm: true,
    keyType: keyTypeFromBlob(hostKeyBlobNaming("ssh-\x1b[31mevil\r\nINJECTED")),
  });
  process.stdin.isTTY = true;
  const lines = await withCapturedDiagnostics(() =>
    establishHostKeyTrust(
      conn,
      {
        verbosity: -1,
        loggerName: "psilink",
        persistence: { mode: "ephemeral" },
      },
      deps,
    ),
  );

  const prompt = lines.find((line) =>
    line.includes("The authenticity of host"),
  );
  expect(prompt).toBeDefined();
  expect(prompt).toMatch(/presented a \(unknown:[0-9a-f]+\) host key/);
  expect(prompt).not.toContain("INJECTED");
  // The step the operator acts on is untouched: the fingerprint they verify
  // out-of-band still reads whole.
  expect(prompt).toContain(FP);
});

test("the trust prompt names a conforming key type verbatim", async () => {
  const keyType = "ecdsa-sha2-nistp521-cert-v01@openssh.com";
  const conn = sftpConn();
  const deps = makeDeps({
    confirm: true,
    keyType: keyTypeFromBlob(hostKeyBlobNaming(keyType)),
  });
  process.stdin.isTTY = true;
  const lines = await withCapturedDiagnostics(() =>
    establishHostKeyTrust(
      conn,
      {
        verbosity: -1,
        loggerName: "psilink",
        persistence: { mode: "ephemeral" },
      },
      deps,
    ),
  );

  expect(
    lines.find((line) => line.includes("The authenticity of host")),
  ).toContain(`presented a ${keyType} host key`);
});

// --- the refusals at the rendered boundary -----------------------------------
// Both refusals are partitioned by who chose the bytes on each link:
// sanitizeErrorForDisplay caps every cause-chain link separately, so a
// partner-chosen fragment sharing a link with first-party text can spend the
// budget and cost the operator their actionable step. These assertions run
// at the rendered boundary, through the real renderer -- not the raw
// `.message`, which a regex could pass on text the operator never sees.

// The renderer's own cause-link separator, read back out of a two-link render
// rather than restated here, so splitting a rendered chain into its links cannot
// drift from the framing the renderer emits.
const CAUSE_SEPARATOR = sanitizeErrorForDisplay(
  new Error("a", { cause: new Error("b") }),
).slice(1, -1);

const linksOf = (rendered: string): string[] => rendered.split(CAUSE_SEPARATOR);

// The widest a single link can render: the per-link cap plus the marker the
// sanitizer appends when it truncates.
const MAX_RENDERED_LINK_LENGTH =
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length;

// The first-party copy, restated whole so a link that renders a PREFIX of it --
// the defect this partition exists to close -- fails rather than matching a
// phrase that happens to survive the cap.
const NON_INTERACTIVE_SUMMARY =
  "no host_key_fingerprint is pinned for this SFTP server and this run is " +
  "not interactive, so its identity cannot be confirmed; refusing to connect.";
const RECOVERY_WITH_CONFIG =
  "Run once from an interactive terminal to review and pin the presented key, " +
  "or pin it out-of-band by setting connection.server.host_key_fingerprint in " +
  "the configuration below.";
const RECOVERY_WITHOUT_CONFIG =
  "Run once from an interactive terminal to review and pin the presented key, " +
  "or pin it out-of-band by setting connection.server.host_key_fingerprint in " +
  "a saved configuration.";
// Raised after the probe, itself a connection: this can only accurately
// assure what that connection disclosed, not that none was opened. ssh2
// refuses at host-key verification, before userauth (the assumption recorded
// in docs/spec/DEPENDENCY_PINS.md), so no credential was sent; and the
// decline returns ahead of every persist arm, so nothing was written (the
// check above).
const DECLINED_SUMMARY =
  "the presented host key was not trusted; no credential was sent and nothing " +
  "was written. Obtain and verify the server's fingerprint out-of-band, then " +
  "retry.";

const HOST_LABEL = "configured host: ";
const CONFIG_LABEL = "configuration file: ";

// Refuse through establishHostKeyTrust and render what the operator sees:
// sanitizeErrorForDisplay over the whole cause chain, which is the boundary
// every CLI sink shows a thrown error at. That each sink renders the chain
// rather than a bare `.message` -- what delivers a recovery step composed onto a
// cause link -- is held by errorSinkCauseChain.test.ts. The real renderer here,
// not a stub: the per-link cap is the whole subject.
async function refuse(options: {
  persistence: HostKeyPersistence;
  host?: string;
  /** Drive the declined-trust refusal (a TTY whose prompt is answered no). */
  interactive?: boolean;
}): Promise<{
  rendered: string;
  links: string[];
  error: unknown;
  connection: ConnectionConfig;
  probeCalls: number;
}> {
  const connection = sftpConn(undefined, options.host);
  const deps = makeDeps({ confirm: false });
  process.stdin.isTTY = options.interactive === true;
  const error: unknown = await establishHostKeyTrust(
    connection,
    { verbosity: -1, loggerName: "psilink", persistence: options.persistence },
    deps,
  ).then(
    () => new Error("establishHostKeyTrust resolved instead of refusing"),
    (err: unknown) => err,
  );
  const rendered = sanitizeErrorForDisplay(error);
  return {
    rendered,
    links: linksOf(rendered),
    error,
    connection,
    probeCalls: deps.probeCalls,
  };
}

const ORDINARY_HOST = "sftp.example.org";
const ORDINARY_CONFIG_PATH = "/etc/psilink.yaml";

// The sizes the configured host arrives in. On the acceptor route it is the
// partner's, copied verbatim from the invitation endpoint into the written
// config (connectionFromEndpoint); SFTPServerSchema bounds `server.host` only
// by `min(1)`, so MAX_ENDPOINT_HOST_LENGTH bounds only what an INVITATION can
// hold, and a hand-written or partner-derived config admits any length above
// it. Each row states whether its host overruns its own link.
const HOSTS: Array<[string, string, boolean]> = [
  ["an ordinary host", ORDINARY_HOST, false],
  [
    "a partner-supplied host at the invitation schema's full length",
    "h".repeat(MAX_ENDPOINT_HOST_LENGTH),
    false,
  ],
  // Between the invitation bound and the flood: sized off the renderer's own
  // link budget so it overruns that link whatever the budget is, and short
  // enough that a config holding it looks unremarkable.
  [
    "a host past a link's display budget",
    "h".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH + 100),
    true,
  ],
  ["a host past every budget", "h".repeat(50_000), true],
];

// The operator's own config path is unbounded too, so it is varied on the same
// axis: an over-long one must spend its own link and nothing else.
const CONFIG_PATHS: Array<[string, string, boolean]> = [
  ["an ordinary config path", ORDINARY_CONFIG_PATH, false],
  [
    "a config path past its budget",
    `/${"d".repeat(50_000)}/psilink.yaml`,
    true,
  ],
];

// The two persistence shapes that name a config path. Both must render the same
// recovery whole; the ephemeral shape below interpolates no path at all.
const CONFIG_BEARING_MODES: Array<
  [string, (path: string) => HostKeyPersistence]
> = [
  ["write-now", (configPath) => ({ mode: "write-now", configPath })],
  [
    "save-with-config",
    (configPath) => ({ mode: "save-with-config", configPath }),
  ],
];

for (const [modeLabel, persistenceFor] of CONFIG_BEARING_MODES)
  for (const [hostLabel, host, hostOverruns] of HOSTS)
    for (const [pathLabel, configPath, pathOverruns] of CONFIG_PATHS)
      test(`the non-interactive refusal (${modeLabel}) renders its recovery whole under ${hostLabel} and ${pathLabel}`, async () => {
        const { links, error, connection, probeCalls } = await refuse({
          persistence: persistenceFor(configPath),
          host,
        });

        // Whole links, not prefixes: the summary and the recovery each hold a
        // budget nobody else can spend.
        expect(links[0]).toBe(NON_INTERACTIVE_SUMMARY);
        expect(links[1]).toBe(RECOVERY_WITH_CONFIG);
        // Each unbounded fragment sits alone behind its own first-party label,
        // and a fragment wider than a link spends its own budget and no other.
        expect(links[2]?.startsWith(CONFIG_LABEL)).toBe(true);
        expect(links[2]).toContain(configPath.slice(0, 32));
        expect(links[2]?.includes(DISPLAY_TRUNCATION_MARKER)).toBe(
          pathOverruns,
        );
        expect(links[3]?.startsWith(HOST_LABEL)).toBe(true);
        expect(links[3]).toContain(host.slice(0, 16));
        expect(links[3]?.includes(DISPLAY_TRUNCATION_MARKER)).toBe(
          hostOverruns,
        );
        // Enforcement is untouched: still a UsageError (exit 64), still no
        // probe, still nothing pinned.
        expect(error).toBeInstanceOf(UsageError);
        expect(probeCalls).toBe(0);
        if (connection.channel === "sftp")
          expect(connection.server.hostKeyFingerprint).toBeUndefined();
      });

for (const [hostLabel, host, hostOverruns] of HOSTS)
  test(`the non-interactive refusal (ephemeral) renders its recovery whole under ${hostLabel}`, async () => {
    const { rendered, links, error, connection, probeCalls } = await refuse({
      persistence: { mode: "ephemeral" },
      host,
    });

    expect(links[0]).toBe(NON_INTERACTIVE_SUMMARY);
    expect(links[1]).toBe(RECOVERY_WITHOUT_CONFIG);
    expect(links[2]?.startsWith(HOST_LABEL)).toBe(true);
    expect(links[2]?.includes(DISPLAY_TRUNCATION_MARKER)).toBe(hostOverruns);
    // Nothing to name, so nothing is named: the ephemeral shape has no
    // config path at all, so no link -- and no empty or `undefined` label --
    // is grown for one.
    expect(rendered).not.toContain(CONFIG_LABEL);
    expect(error).toBeInstanceOf(UsageError);
    expect(probeCalls).toBe(0);
    if (connection.channel === "sftp")
      expect(connection.server.hostKeyFingerprint).toBeUndefined();
  });

for (const [hostLabel, host, hostOverruns] of HOSTS)
  test(`the declined-trust refusal renders whole under ${hostLabel}`, async () => {
    const { rendered, links, error, connection } = await refuse({
      persistence: { mode: "ephemeral" },
      host,
      interactive: true,
    });

    expect(links[0]).toBe(DECLINED_SUMMARY);
    expect(links[1]?.startsWith(HOST_LABEL)).toBe(true);
    expect(links[1]?.includes(DISPLAY_TRUNCATION_MARKER)).toBe(hostOverruns);
    expect(rendered).not.toContain(CONFIG_LABEL);
    expect(error).toBeInstanceOf(UsageError);
    if (connection.channel === "sftp")
      expect(connection.server.hostKeyFingerprint).toBeUndefined();
  });

// A first-party link fits its own budget by measurement, not by construction:
// nothing stops the fixed copy growing past the cap, and then the cap is back on
// the operator's text. That is the partition's one residual, so it is a check
// rather than a caveat. With every variable fragment at its ordinary size no
// link truncates at all, so growing any of the fixed copy past its budget fails
// here -- including growth after the phrase another assertion happens to read.
test("no link of either refusal truncates when no fragment overruns", async () => {
  for (const options of [
    { persistence: { mode: "write-now", configPath: ORDINARY_CONFIG_PATH } },
    {
      persistence: {
        mode: "save-with-config",
        configPath: ORDINARY_CONFIG_PATH,
      },
    },
    { persistence: { mode: "ephemeral" } },
    { persistence: { mode: "ephemeral" }, interactive: true },
  ] satisfies Array<Parameters<typeof refuse>[0]>) {
    const { rendered } = await refuse(options);
    expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
  }
});

// The partition does not remove the cap, it only stops the cap falling on
// first-party text. Both bounds still hold with every fragment flooded at once:
// each link truncates on its own budget, the chain stays inside the renderer's
// depth bound (so no detail is dropped in favour of an earlier one), and the
// whole rendered output stays bounded by the two together.
const FLOODED_REFUSALS: Array<
  [string, () => ReturnType<typeof refuse>, string]
> = [
  [
    "the non-interactive refusal",
    () =>
      refuse({
        persistence: {
          mode: "save-with-config",
          configPath: `/${"d".repeat(100_000)}/psilink.yaml`,
        },
        host: "h".repeat(100_000),
      }),
    RECOVERY_WITH_CONFIG,
  ],
  [
    "the declined-trust refusal",
    () =>
      refuse({
        persistence: { mode: "ephemeral" },
        host: "h".repeat(100_000),
        interactive: true,
      }),
    DECLINED_SUMMARY,
  ],
];

for (const [label, render, firstPartyText] of FLOODED_REFUSALS)
  test(`${label} truncates per link and stays bounded overall when flooded`, async () => {
    const { rendered, links } = await render();

    for (const link of links)
      expect(link.length).toBeLessThanOrEqual(MAX_RENDERED_LINK_LENGTH);
    expect(links.length).toBeLessThanOrEqual(MAX_ERROR_CAUSE_DEPTH);
    expect(rendered.length).toBeLessThanOrEqual(
      MAX_ERROR_CAUSE_DEPTH *
        (MAX_RENDERED_LINK_LENGTH + CAUSE_SEPARATOR.length),
    );
    // The cap fell on the flooded fragments' own links and nowhere else.
    expect(rendered).toContain(firstPartyText);
    expect(
      links.filter((link) => link.includes(DISPLAY_TRUNCATION_MARKER)),
    ).toEqual(
      links.filter(
        (link) => link.startsWith(HOST_LABEL) || link.startsWith(CONFIG_LABEL),
      ),
    );
  });

test("a control-laden host is escaped at the boundary and cannot forge a link", async () => {
  // The host is composed raw (the display boundary escapes the rendered chain
  // once); a hostile one must neither break the flow nor spill an ANSI sequence,
  // a bidi override, or a forged log line, and its own link is where it lands.
  const { rendered, links } = await refuse({
    persistence: { mode: "save-with-config", configPath: ORDINARY_CONFIG_PATH },
    // The bidi override is written as an escape rather than a literal: a raw RLO
    // in a source file is itself the hazard this delivery measures.
    host:
      "sftp\x1b[31m.example.org\nnot-an-error: forged\r\ncaused by: forged" +
      "\x00\u202e",
  });

  for (const raw of ["\x1b", "\r", "\x00", "\u202e"])
    expect(rendered).not.toContain(raw);
  expect(links[0]).toBe(NON_INTERACTIVE_SUMMARY);
  expect(links[1]).toBe(RECOVERY_WITH_CONFIG);
  expect(links[3]).toBe(
    `${HOST_LABEL}sftp\\x1b[31m.example.org\\x0anot-an-error: forged\\x0d` +
      `\\x0acaused by: forged\\x00\\u202e`,
  );
  // Non-forgeable framing: the separator's newline is the only one the render
  // contains, so a host holding `caused by: ` text of its own adds no link and
  // cannot pass its bytes off as a further step in the chain.
  expect(links.length).toBe(4);
  expect(rendered.split("\n").length).toBe(links.length);
});

// The private-key redaction is fail-closed past a truncated block: it replaces
// from a BEGIN marker to the end of the LINK the marker lands on. So a marker
// planted in a chooser's fragment is what would consume first-party text sharing
// that link, and each chooser's fragment is delivered one -- alone and with text
// around it -- and measured at the rendered boundary. Core pins its own refusals
// on the same deliveries (packages/core/test/connection/sftpSession.test.ts).
const PEM_MARKER = "-----BEGIN OPENSSH PRIVATE KEY-----";
const KEY_BODY = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAAB";
const REDACTED = "[redacted private key]";

test("a bare PEM marker as the host is redacted on the host's own link", async () => {
  const { rendered, links } = await refuse({
    persistence: { mode: "save-with-config", configPath: ORDINARY_CONFIG_PATH },
    host: PEM_MARKER,
  });

  expect(links[0]).toBe(NON_INTERACTIVE_SUMMARY);
  expect(links[1]).toBe(RECOVERY_WITH_CONFIG);
  expect(links[2]).toBe(`${CONFIG_LABEL}${ORDINARY_CONFIG_PATH}`);
  expect(links[3]).toBe(`${HOST_LABEL}${REDACTED}`);
  expect(rendered).not.toContain("PRIVATE KEY");
});

test("a sliced key in the host is redacted with the surrounding text kept", async () => {
  const { rendered, links } = await refuse({
    persistence: { mode: "save-with-config", configPath: ORDINARY_CONFIG_PATH },
    host: `${ORDINARY_HOST} ${PEM_MARKER}\n${KEY_BODY}\ntrailing`,
  });

  expect(links[0]).toBe(NON_INTERACTIVE_SUMMARY);
  expect(links[1]).toBe(RECOVERY_WITH_CONFIG);
  expect(links[3]).toBe(`${HOST_LABEL}${ORDINARY_HOST} ${REDACTED}`);
  expect(rendered).not.toContain(KEY_BODY.slice(0, 24));
  expect(rendered).not.toContain("trailing");
});

test("a sliced key in the config path is redacted on the config path's own link", async () => {
  const { rendered, links } = await refuse({
    persistence: {
      mode: "write-now",
      configPath: `/etc/${PEM_MARKER}${KEY_BODY}/psilink.yaml`,
    },
    host: ORDINARY_HOST,
  });

  expect(links[0]).toBe(NON_INTERACTIVE_SUMMARY);
  expect(links[1]).toBe(RECOVERY_WITH_CONFIG);
  expect(links[2]).toBe(`${CONFIG_LABEL}/etc/${REDACTED}`);
  expect(rendered).not.toContain(KEY_BODY.slice(0, 24));
  // The reach stops at the link boundary: each link is redacted on its own, so
  // a marker in the config path cannot swallow the host link behind it.
  expect(links[3]).toBe(`${HOST_LABEL}${ORDINARY_HOST}`);
});

// Every link has its `cause` the way the two-argument Error constructor
// would, so a sink that enumerates or serializes a refusal rather than rendering
// it through sanitizeErrorForDisplay sees the same shape at every depth as it
// does at the top.
const causeChainOf = (error: unknown): object[] => {
  const chain: object[] = [];
  let link: unknown = error;
  while (typeof link === "object" && link !== null) {
    chain.push(link);
    link = (link as { cause?: unknown }).cause;
  }
  return chain;
};

test("every refusal link installs its cause non-enumerably", async () => {
  const { error } = await refuse({
    persistence: { mode: "save-with-config", configPath: ORDINARY_CONFIG_PATH },
  });

  const chain = causeChainOf(error);
  expect(chain.length).toBe(4);
  for (const link of chain) {
    expect(Object.getOwnPropertyDescriptor(link, "cause")?.enumerable).toBe(
      false,
    );
    expect(Object.keys(link)).not.toContain("cause");
  }
  expect(JSON.stringify(chain[1])).toBe("{}");
});

// --- the log and prompt lines against the sinks' private-key pass ------------
// The configured host reaches the trust warning, the confirm question, and the
// pin lines, and on an offline-accept-seeded config it is the PARTNER's, copied
// verbatim out of the invitation endpoint under no format bound. It is composed
// AHEAD of the out-of-band verification step, and the log sink redacts the whole
// line, fail-closed past a BEGIN marker with no END -- so the step survives only
// because the fragment is redacted where it is interpolated.

const VERIFY_STEP =
  "Verify this matches the server's published fingerprint out-of-band";

test("a marker in the configured host cannot delete the verify step or the prompt", async () => {
  const conn = sftpConn(undefined, `${PEM_MARKER}.example.org`);
  const questions: string[] = [];
  const deps: HostKeyTrustDeps = {
    probe: () => Promise.resolve({ fingerprint: FP, keyType: "ssh-ed25519" }),
    confirm: (question) => {
      questions.push(question);
      return Promise.resolve(true);
    },
  };
  process.stdin.isTTY = true;
  logLibrary.setDefaultLevel(logLibrary.levels.INFO);
  const lines = await withCapturedDiagnostics(() =>
    establishHostKeyTrust(
      conn,
      {
        verbosity: -1,
        loggerName: "host-redaction-ephemeral",
        persistence: { mode: "ephemeral" },
      },
      deps,
    ),
  );

  const warning = lines.find((line) => line.includes("The authenticity of"));
  expect(warning).toBeDefined();
  expect(warning).toContain(REDACTED);
  expect(warning).toContain(VERIFY_STEP);
  expect(warning).toContain(FP);
  // The confirm question is its own sink and keeps its subject.
  expect(questions).toHaveLength(1);
  expect(questions[0]).toContain(REDACTED);
  expect(questions[0]).toContain("Trust this host key for");
  // The ephemeral pin line states what is NOT saved, behind the same host.
  const pinned = lines.find((line) => line.includes("[INFO]"));
  expect(pinned).toContain(REDACTED);
  expect(pinned).toContain("it is not saved");
});

test("a marker in the config path cannot delete the pin line's assurance", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-hkt-redact-"));
  try {
    const configPath = path.join(dir, `${PEM_MARKER}.yaml`);
    fs.writeFileSync(
      configPath,
      "connection:\n  channel: sftp\n  server:\n    host: sftp.example.org\n",
    );
    const conn = sftpConn();
    const deps = makeDeps({ confirm: true });
    process.stdin.isTTY = true;
    logLibrary.setDefaultLevel(logLibrary.levels.INFO);
    const lines = await withCapturedDiagnostics(() =>
      establishHostKeyTrust(
        conn,
        {
          verbosity: -1,
          loggerName: "host-redaction-write-now",
          persistence: { mode: "write-now", configPath },
        },
        deps,
      ),
    );

    const pinned = lines.find((line) => line.includes("[INFO]"));
    expect(pinned).toBeDefined();
    expect(pinned).toContain(REDACTED);
    expect(pinned).toContain(
      "future connections will verify it automatically.",
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
