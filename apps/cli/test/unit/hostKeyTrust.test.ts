import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";
import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  MAX_ENDPOINT_HOST_LENGTH,
  MAX_ERROR_CAUSE_DEPTH,
  sanitizeErrorForDisplay,
  UsageError,
} from "@psilink/core";
import type { ConnectionConfig, PresentedHostKey } from "@psilink/core";

import {
  establishHostKeyTrust,
  type HostKeyPersistence,
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
  // The config path rides a cause link, so it is asserted at the rendered
  // boundary below (the raw `.message` is the summary alone).
  const rendered = sanitizeErrorForDisplay(await run.catch((e: unknown) => e));
  expect(rendered).toContain("/etc/psilink.yaml");
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
  const rendered = sanitizeErrorForDisplay(await run.catch((e: unknown) => e));
  expect(rendered).toMatch(/out-of-band/i);
  expect(rendered).toMatch(/saved configuration/i);
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

// --- the refusals at the rendered boundary -----------------------------------
// Both refusals are partitioned by WHO CHOSE THE BYTES on each link, because
// sanitizeErrorForDisplay caps every cause-chain link separately: on a link that
// mixes first-party text with a fragment somebody else chose, that chooser
// spends the budget and the operator loses the step they have to act on. These
// assertions therefore run at the RENDERED boundary through the real renderer --
// the raw `.message` is only the summary, and a regex over it passes on text the
// operator never sees.

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
  DEFAULT_MAX_DISPLAY_LENGTH + DISPLAY_TRUNCATION_MARKER.length;

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
const DECLINED_SUMMARY =
  "the presented host key was not trusted; no connection was made and nothing " +
  "was written. Obtain and verify the server's fingerprint out-of-band, then " +
  "retry.";

const HOST_LABEL = "configured host: ";
const CONFIG_LABEL = "configuration file: ";

// Refuse through establishHostKeyTrust and render what the operator sees:
// sanitizeErrorForDisplay over the whole cause chain, which is the boundary
// every CLI sink shows a thrown error at (`exitWithError` and `runOrExit` in
// src/util/cli.ts, and src/index.ts's last-resort catch, all of which call it;
// nothing between the throw and them re-wraps a bare `.message`). The real
// renderer, not a stub: the per-link cap is the whole subject.
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
// PARTNER's, copied verbatim out of the invitation endpoint into the written
// config (connectionFromEndpoint), and the operator-config schema bounds it
// neither in length nor in format -- so the invitation schema's own
// MAX_ENDPOINT_HOST_LENGTH is a floor on what can arrive, not a ceiling.
const HOSTS: Array<[string, string]> = [
  ["an ordinary host", ORDINARY_HOST],
  [
    "a partner-supplied host at the invitation schema's full length",
    "h".repeat(MAX_ENDPOINT_HOST_LENGTH),
  ],
  ["a host past every budget", "h".repeat(50_000)],
];

// The operator's own config path is unbounded too, so it is varied on the same
// axis: an over-long one must spend its own link and nothing else.
const CONFIG_PATHS: Array<[string, string]> = [
  ["an ordinary config path", ORDINARY_CONFIG_PATH],
  ["a config path past its budget", `/${"d".repeat(50_000)}/psilink.yaml`],
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
  for (const [hostLabel, host] of HOSTS)
    for (const [pathLabel, configPath] of CONFIG_PATHS)
      test(`the non-interactive refusal (${modeLabel}) renders its recovery whole under ${hostLabel} and ${pathLabel}`, async () => {
        const { links, error, connection, probeCalls } = await refuse({
          persistence: persistenceFor(configPath),
          host,
        });

        // Whole links, not prefixes: the summary and the recovery each hold a
        // budget nobody else can spend.
        expect(links[0]).toBe(NON_INTERACTIVE_SUMMARY);
        expect(links[1]).toBe(RECOVERY_WITH_CONFIG);
        // Each unbounded fragment sits alone behind its own first-party label.
        expect(links[2]?.startsWith(CONFIG_LABEL)).toBe(true);
        expect(links[2]).toContain(configPath.slice(0, 32));
        expect(links[3]?.startsWith(HOST_LABEL)).toBe(true);
        expect(links[3]).toContain(host.slice(0, 16));
        // Enforcement is untouched: still a UsageError (exit 64), still no
        // probe, still nothing pinned.
        expect(error).toBeInstanceOf(UsageError);
        expect(probeCalls).toBe(0);
        if (connection.channel === "sftp")
          expect(connection.server.hostKeyFingerprint).toBeUndefined();
      });

for (const [hostLabel, host] of HOSTS)
  test(`the non-interactive refusal (ephemeral) renders its recovery whole under ${hostLabel}`, async () => {
    const { links, error, connection, probeCalls } = await refuse({
      persistence: { mode: "ephemeral" },
      host,
    });

    expect(links[0]).toBe(NON_INTERACTIVE_SUMMARY);
    expect(links[1]).toBe(RECOVERY_WITHOUT_CONFIG);
    expect(links[2]?.startsWith(HOST_LABEL)).toBe(true);
    // Nothing to name, so nothing is named: the ephemeral shape interpolates no
    // path and grows no link for one.
    expect(links.some((link) => link.startsWith(CONFIG_LABEL))).toBe(false);
    expect(error).toBeInstanceOf(UsageError);
    expect(probeCalls).toBe(0);
    if (connection.channel === "sftp")
      expect(connection.server.hostKeyFingerprint).toBeUndefined();
  });

for (const [hostLabel, host] of HOSTS)
  test(`the declined-trust refusal renders whole under ${hostLabel}`, async () => {
    const { links, error, connection } = await refuse({
      persistence: { mode: "ephemeral" },
      host,
      interactive: true,
    });

    expect(links[0]).toBe(DECLINED_SUMMARY);
    expect(links[1]?.startsWith(HOST_LABEL)).toBe(true);
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

test("a control-laden host is escaped at the boundary and reaches no first-party link", async () => {
  // The host is composed raw (the display boundary escapes the rendered chain
  // once); a hostile one must neither break the flow nor spill an ANSI sequence
  // or a forged log line, and its own link is where it lands.
  const { rendered, links } = await refuse({
    persistence: { mode: "save-with-config", configPath: ORDINARY_CONFIG_PATH },
    host: "sftp\x1b[31m.example.org\nnot-an-error: forged",
  });

  expect(rendered).not.toContain("\x1b");
  expect(links[0]).toBe(NON_INTERACTIVE_SUMMARY);
  expect(links[1]).toBe(RECOVERY_WITH_CONFIG);
  expect(links[3]).toBe(
    `${HOST_LABEL}sftp\\x1b[31m.example.org\\x0anot-an-error: forged`,
  );
});
