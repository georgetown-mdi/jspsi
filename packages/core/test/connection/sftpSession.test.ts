import { expect, test } from "vitest";

import { SftpSession } from "../../src/connection/sftpSession";
import { FileSyncConnection } from "../../src/connection/fileSyncConnection";
import type { FileTransportClient } from "../../src/connection/fileSyncConnection";
import type { SFTPConnectionConfig } from "../../src/config/connection";
import { DEFAULT_SERVER_CONNECT_TIMEOUT_MS } from "../../src/config/connection";
import { MAX_ENDPOINT_HOST_LENGTH } from "../../src/config/invitation";
import type { getLoggerForVerbosity } from "../../src/utils/logger";
import { computeHostKeyFingerprint } from "../../src/utils/sshHostKey";
import {
  MAX_ERROR_CAUSE_DEPTH,
  sanitizeErrorForDisplay,
} from "../../src/utils/sanitizeErrorForDisplay";
import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
} from "../../src/utils/sanitizeForDisplay";

// The connect-option tests never dial, and construction only needs a
// FileTransportClient reference, so an inert stub suffices. The probe behavior
// is covered in fileSyncConnection.test.ts; the refusal tests below dial a stub
// that fires the installed verifier, so they render what an operator actually
// sees rather than a message this file re-assembles.
const inertClient: FileTransportClient = {
  connect: async () => {},
  end: async () => {},
  list: async () => [],
  get: async () => Buffer.alloc(0) as Buffer<ArrayBufferLike>,
  put: async () => undefined,
  delete: async () => {},
  safeDelete: async () => {},
  rename: async () => {},
  createExclusive: async () => {},
  exists: async () => false,
};

function makeSession(): { session: SftpSession; warnings: string[] } {
  const warnings: string[] = [];
  const log = {
    warn: (msg: string) => warnings.push(msg),
    debug: () => {},
    info: () => {},
    trace: () => {},
    error: () => {},
  } as unknown as ReturnType<typeof getLoggerForVerbosity>;
  const session = new SftpSession({
    log: () => log,
    role: () => "tester",
    rawClient: inertClient,
  });
  return { session, warnings };
}

test("buildConnectOptions keeps an allowlisted providerOptions key and drops a non-allowlisted one with a warning", () => {
  const { session, warnings } = makeSession();
  const config: SFTPConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    // keepaliveInterval is on the transport-tuning allowlist; sock is a
    // connection-redirect vector the default-deny allowlist must drop.
    providerOptions: { keepaliveInterval: 5000, sock: "redirect" },
  };
  const opts = session.buildConnectOptions(config, {
    includeCredentials: true,
  });
  expect(opts["keepaliveInterval"]).toBe(5000);
  expect(opts["sock"]).toBeUndefined();
  expect(warnings.some((w) => w.includes("providerOptions.sock"))).toBe(true);
});

test("buildConnectOptions filters algorithms to the tunable sub-keys and drops serverHostKey", () => {
  const { session, warnings } = makeSession();
  const config: SFTPConnectionConfig = {
    channel: "sftp",
    server: { host: "sftp.example.org" },
    providerOptions: {
      algorithms: {
        cipher: ["aes256-gcm@openssh.com"],
        hmac: ["hmac-sha2-256"],
        kex: ["curve25519-sha256"],
        compress: ["none"],
        // serverHostKey constrains host-key-type negotiation, so it must be
        // dropped even though the `algorithms` object itself is allowlisted.
        serverHostKey: ["ssh-rsa"],
      },
    },
  };
  const opts = session.buildConnectOptions(config, {
    includeCredentials: true,
  });
  const algorithms = opts["algorithms"] as Record<string, unknown>;
  expect(algorithms).toBeDefined();
  expect(Object.keys(algorithms).sort()).toEqual([
    "cipher",
    "compress",
    "hmac",
    "kex",
  ]);
  expect(algorithms["serverHostKey"]).toBeUndefined();
  expect(warnings.some((w) => w.includes("algorithms.serverHostKey"))).toBe(
    true,
  );
});

test("buildConnectOptions omits credentials when includeCredentials is false and includes them when true", () => {
  const { session } = makeSession();
  const config: SFTPConnectionConfig = {
    channel: "sftp",
    server: {
      host: "sftp.example.org",
      username: "roberts",
      password: "secret",
      privateKey: "PRIVATE",
      privateKeyPassphrase: "PASS",
      keyboardInteractive: true,
    },
  };

  const withoutCreds = session.buildConnectOptions(config, {
    includeCredentials: false,
  });
  // The non-secret fields the probe still needs stay present.
  expect(withoutCreds["host"]).toBe("sftp.example.org");
  expect(withoutCreds["username"]).toBe("roberts");
  // No credential -- and no keyboard-interactive opt-in -- rides the probe.
  expect(withoutCreds["password"]).toBeUndefined();
  expect(withoutCreds["privateKey"]).toBeUndefined();
  expect(withoutCreds["passphrase"]).toBeUndefined();
  expect(withoutCreds["tryKeyboard"]).toBeUndefined();

  const withCreds = session.buildConnectOptions(config, {
    includeCredentials: true,
  });
  expect(withCreds["password"]).toBe("secret");
  expect(withCreds["privateKey"]).toBe("PRIVATE");
  expect(withCreds["passphrase"]).toBe("PASS");
  expect(withCreds["tryKeyboard"]).toBe(true);
});

// A raw OpenSSH host-key blob: a uint32 length prefix, the key-type string, and
// the key bytes. Nothing bounds what a server puts in the type field, so it is
// written here exactly as sent and keyTypeFromBlob decides what is composed.
function hostKeyBlob(keyType: string): Buffer<ArrayBuffer> {
  const type = Buffer.from(keyType, "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(type.length, 0);
  return Buffer.concat([header, type, Buffer.alloc(32, 7)]);
}

// A transport whose connect() presents `keyBlob` to whatever hostVerifier was
// installed and then rejects the way ssh2 does on a refusal, so open() reaches
// its host-key catch and composes the refusal exactly as production does.
function hostKeyMockClient(keyBlob: Buffer): FileTransportClient {
  return {
    ...inertClient,
    connect: (options: Record<string, unknown>) =>
      new Promise<void>((resolve, reject) => {
        const hostVerifier = options["hostVerifier"] as (
          blob: Buffer,
          verify: (permitted: boolean) => void,
        ) => void;
        hostVerifier(keyBlob, (permitted: boolean) => {
          if (permitted) resolve();
          else reject(new Error("Host denied (verification failed)"));
        });
      }),
  };
}

// A blob no reader can view: the byteLength runs past the underlying
// ArrayBuffer, so hostKeyBlob's Uint8Array view throws before any fingerprint is
// computed. This is the way into each verifier's catch branch, which composes a
// refusal of its own from an error text nobody first-party chose.
const UNREADABLE_BLOB = {
  buffer: new ArrayBuffer(4),
  byteOffset: 0,
  byteLength: 64,
} as unknown as Buffer;

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

// Refuse a connection through the REAL open() path and render what the operator
// sees: sanitizeErrorForDisplay over the whole ConnectionError cause chain,
// which is the boundary every consumer shows this at. Driving open() rather than
// the verifier alone is what puts the partition itself under test -- the summary
// and the per-fragment cause links are composed by the connect catch, not here.
async function renderRefusal(
  config: SFTPConnectionConfig,
  keyType: string,
): Promise<string> {
  return renderRefusalFromBlob(config, hostKeyBlob(keyType));
}

async function renderRefusalFromBlob(
  config: SFTPConnectionConfig,
  keyBlob: Buffer,
): Promise<string> {
  const conn = new FileSyncConnection(hostKeyMockClient(keyBlob), {
    verbose: -1,
  });
  const err: unknown = await conn.open(config).catch((e: unknown) => e);
  return sanitizeErrorForDisplay(err);
}

const PIN = `SHA256:${"A".repeat(43)}`;
const OTHER_PIN = `SHA256:${"B".repeat(43)}`;

const renderMismatch = (
  keyType: string,
  pins: string | string[] = PIN,
): Promise<string> =>
  renderRefusal(
    {
      channel: "sftp",
      server: { host: "sftp.example.org", hostKeyFingerprint: pins },
    },
    keyType,
  );

const renderNoPinRefusal = (
  keyType: string,
  host = "sftp.example.org",
): Promise<string> =>
  renderRefusal({ channel: "sftp", server: { host } }, keyType);

// A benign type and a hostile one, so the whole presented fingerprint and the
// instruction stay asserted under both. keyTypeFromBlob replaces a type it does
// not recognize with a bounded placeholder before it is composed, and under the
// provenance partition neither shares a link with first-party text, so neither
// can reach what the operator has to act on. The placeholder itself, over every
// rejected shape, is driven by REJECTED_KEY_TYPES below.
const SERVER_CHOSEN_KEY_TYPES: Array<[string, string]> = [
  ["a benign key type", "ssh-ed25519"],
  ["a key type carrying a PEM BEGIN marker", "-----BEGIN RSA PRIVATE KEY-----"],
];

for (const [label, keyType] of SERVER_CHOSEN_KEY_TYPES) {
  test(`the no-pin refusal renders the whole fingerprint and the pin instruction under ${label}`, async () => {
    const presented = await computeHostKeyFingerprint(hostKeyBlob(keyType));
    const rendered = await renderNoPinRefusal(keyType);

    // The whole fingerprint, not a prefix: the operator compares all of it
    // against what the server administrator gives them out-of-band.
    expect(rendered).toContain(presented);
    expect(rendered).toContain(
      "set connection.server.host_key_fingerprint to pin it",
    );
  });

  test(`the pinned-mismatch refusal renders the whole fingerprint, the warning and the re-pin step under ${label}`, async () => {
    const presented = await computeHostKeyFingerprint(hostKeyBlob(keyType));
    const rendered = await renderMismatch(keyType);

    expect(rendered).toContain(presented);
    expect(rendered).toContain("which does not match the pinned fingerprint");
    expect(rendered).toContain("A changed key is never auto-accepted.");
    expect(rendered).toContain(
      "This may be a legitimate key rotation or an active attack",
    );
    expect(rendered).toContain(
      "add it to connection.server.host_key_fingerprint",
    );
    expect(rendered).toContain(
      "re-run interactively to re-establish trust on first use",
    );
    // The pinned set is disclosed too, on the link of its own that keeps a
    // many-pin config from eating the instruction above.
    expect(rendered).toContain(`pinned fingerprint: ${PIN}`);
  });
}

// The configured host is the OTHER adversary-reachable fragment on the no-pin
// refusal: on the acceptor route it is copied verbatim from the partner's
// invitation endpoint, and the operator-config schema bounds it in neither
// length nor format, so MAX_ENDPOINT_HOST_LENGTH is a floor on what can arrive,
// not a ceiling. A host at that floor sits on its own link and is delivered
// whole; past the link budget, the cap falls on that link and no other.
test("a partner-supplied host at its schema's full length reaches the operator whole", async () => {
  const keyType = "ssh-ed25519";
  const presented = await computeHostKeyFingerprint(hostKeyBlob(keyType));
  const host = "h".repeat(MAX_ENDPOINT_HOST_LENGTH);
  const rendered = await renderNoPinRefusal(keyType, host);

  expect(rendered).toContain(presented);
  expect(rendered).toContain(
    "set connection.server.host_key_fingerprint to pin it",
  );
  expect(linksOf(rendered)).toContain(`configured host: ${host}`);
  expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
});

test("a partner-supplied host past the link budget spends only its own link", async () => {
  const keyType = "ssh-ed25519";
  const presented = await computeHostKeyFingerprint(hostKeyBlob(keyType));
  const host = "h".repeat(COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH + 100);
  const rendered = await renderNoPinRefusal(keyType, host);

  expect(rendered).toContain(presented);
  expect(rendered).toContain(
    "set connection.server.host_key_fingerprint to pin it",
  );
  const hostLink = linksOf(rendered).find((link) =>
    link.startsWith("configured host: "),
  );
  expect(hostLink).toBeDefined();
  expect(hostLink).toContain(DISPLAY_TRUNCATION_MARKER);
  // The cap fell on the host's own bytes and nowhere else.
  expect(
    linksOf(rendered).filter((link) =>
      link.includes(DISPLAY_TRUNCATION_MARKER),
    ),
  ).toEqual([hostLink]);
});

// Every fragment can be flooded at once and each link still truncates on its
// own budget, so the whole output stays inside the renderer's depth bound times
// that budget -- and the flood must not disturb any fragment still unbounded
// here. Both refusal branches are exercised: the partner-chosen host on the
// no-pin branch, the operator-chosen pin set on the mismatch branch, and the
// server-chosen key type (already bounded before composition) on both.
const FLOODED_REFUSALS: Array<[string, () => Promise<string>, string]> = [
  [
    "the no-pin refusal",
    () => renderNoPinRefusal("X".repeat(100_000), "h".repeat(100_000)),
    "set connection.server.host_key_fingerprint to pin it",
  ],
  [
    "the pinned-mismatch refusal",
    () =>
      renderMismatch(
        "X".repeat(100_000),
        Array.from({ length: 500 }, () => PIN),
      ),
    "re-run interactively to re-establish trust on first use",
  ],
];

for (const [label, render, recovery] of FLOODED_REFUSALS) {
  test(`${label} truncates per link and stays bounded overall when flooded`, async () => {
    const rendered = await render();
    const links = linksOf(rendered);

    for (const link of links)
      expect(link.length).toBeLessThanOrEqual(MAX_RENDERED_LINK_LENGTH);
    expect(links.length).toBeLessThanOrEqual(MAX_ERROR_CAUSE_DEPTH);
    expect(rendered.length).toBeLessThanOrEqual(
      MAX_ERROR_CAUSE_DEPTH *
        (MAX_RENDERED_LINK_LENGTH + CAUSE_SEPARATOR.length),
    );
    // Flooding the fragments still leaves this branch's recovery step whole.
    expect(rendered).toContain(recovery);
  });
}

// Each verifier refuses from a catch of its own when the presented key cannot
// be read at all: these refusals partition the same way as the two above, so
// the underlying error text -- a fragment nobody first-party chose -- takes a
// link of its own and can consume nothing else. UNREADABLE_BLOB_ERROR reads the
// platform's own thrown text rather than hardcoding it, so the detail link is
// asserted exactly and cannot pass if first-party guidance leaks behind it.
const UNREADABLE_BLOB_ERROR = (() => {
  try {
    new Uint8Array(
      UNREADABLE_BLOB.buffer,
      UNREADABLE_BLOB.byteOffset,
      UNREADABLE_BLOB.byteLength,
    );
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("UNREADABLE_BLOB must not be viewable");
})();

const UNREADABLE_KEY_REFUSALS: Array<
  [string, SFTPConnectionConfig, string, string]
> = [
  [
    "the no-pin branch",
    { channel: "sftp", server: { host: "sftp.example.org" } },
    "no host_key_fingerprint is pinned and the presented host key could not " +
      "be read, so the connection is refused.",
    "host key read error",
  ],
  [
    "the pinned branch",
    {
      channel: "sftp",
      server: { host: "sftp.example.org", hostKeyFingerprint: PIN },
    },
    "the server's host key could not be verified, so the connection is refused.",
    "host key verification error",
  ],
];

for (const [label, config, summary, detailLabel] of UNREADABLE_KEY_REFUSALS) {
  test(`an unreadable host key refuses on ${label} with the error text on its own link`, async () => {
    const rendered = await renderRefusalFromBlob(config, UNREADABLE_BLOB);
    const links = linksOf(rendered);

    // The refusal reaches the operator whole, on the message's own link.
    expect(links[0]).toBe(`SFTP host-key verification failed: ${summary}`);
    // Whole link, not a prefix: the branch's own label, then the error text,
    // and nothing behind it for the fragment to consume. The label is matched
    // per branch, so swapping the two labels fails here.
    expect(links[1]).toBe(`${detailLabel}: ${UNREADABLE_BLOB_ERROR}`);
    // Still fail-closed, and still ahead of the transport error ssh2 rejected
    // with, so the depth bound cannot drop the detail in its favour.
    expect(links[links.length - 1]).toContain("Host denied");
  });
}

// A first-party link fits its own budget by measurement, not by construction:
// nothing stops the fixed copy growing past the cap, and then the cap is back on
// the operator's text. That is the partition's one residual, so it is a check
// rather than a caveat. With every variable fragment at its ordinary size no
// link truncates at all, so growing any of the fixed copy past its budget fails
// here -- including growth after the phrase another assertion happens to read.
test("no link of either refusal truncates when no fragment overruns", async () => {
  for (const rendered of [
    await renderNoPinRefusal("ssh-ed25519"),
    await renderMismatch("ssh-ed25519"),
    await renderMismatch("ssh-ed25519", [PIN, OTHER_PIN]),
  ])
    expect(rendered).not.toContain(DISPLAY_TRUNCATION_MARKER);
});

// The detail links are composed AHEAD of the transport error, so the renderer's
// depth bound can never drop a detail in favour of ssh2's opaque "Host denied".
// Asserted rather than reasoned about: the transport error still renders, which
// is only possible while the whole chain fits inside the bound.
test("the refusal's detail links sit ahead of the transport error, inside the depth bound", async () => {
  const rendered = await renderMismatch("ssh-ed25519", [PIN, OTHER_PIN]);
  const links = linksOf(rendered);

  expect(links.length).toBeLessThan(MAX_ERROR_CAUSE_DEPTH);
  expect(links[links.length - 1]).toContain("Host denied");
  expect(links.some((link) => link.startsWith("pinned fingerprints: "))).toBe(
    true,
  );
  expect(
    links.some((link) => link.startsWith("presented host key type: ")),
  ).toBe(true);
  // The pin count adapts to the set, which is a number rather than a value, so
  // it stays on the summary link.
  expect(rendered).toContain("does not match any of the 2 pinned fingerprints");
});

// The key type is the one fragment on these refusals that is bounded before it
// is composed: keyTypeFromBlob returns a type outside its charset or length bound
// as a placeholder encoding the leading bytes, so what the operator reads is
// first-party framing whatever the server put in the type field. The whole link
// is read, so a composition that appended the server's bytes behind the
// placeholder -- or a widened bound that let them through -- fails here.
const TYPE_LINK_PREFIX = "presented host key type: ";
const PLACEHOLDER_TYPE_LINK =
  /^presented host key type: \(unknown:[0-9a-f]+\)$/;

const typeLinkOf = (rendered: string): string | undefined =>
  linksOf(rendered).find((link) => link.startsWith(TYPE_LINK_PREFIX));

// A rejected type and the fragments of it no refusal may render: an ANSI/CRLF
// injection, a whole private key sliced into the type field, and a type inside
// the charset but one byte past the length bound.
const REJECTED_KEY_TYPES: Array<[string, string, string[]]> = [
  ["a control-laden type", "ssh-\x1b[31mevil\r\nINJECTED", ["INJECTED"]],
  [
    "a type carrying a sliced private key",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nc2gtcnNhAAAAAwEAAQ==\nQ1n3QqzB2rN",
    ["BEGIN OPENSSH", "c2gtcnNhAAAAAwEAAQ", "Q1n3QqzB2rN"],
  ],
  [
    "a conforming type one byte past the length bound",
    "X".repeat(65),
    ["XXXXXXXX"],
  ],
];

// Each branch composes the type link itself, so both are driven with the same
// types; the first-party text asserted alongside is the step that branch's
// operator has to act on.
const REFUSAL_BRANCHES: Array<
  [string, (keyType: string) => Promise<string>, string]
> = [
  [
    "the no-pin refusal",
    renderNoPinRefusal,
    "set connection.server.host_key_fingerprint to pin it",
  ],
  [
    "the pinned-mismatch refusal",
    renderMismatch,
    "which does not match the pinned fingerprint",
  ],
];

for (const [branch, render, firstPartyStep] of REFUSAL_BRANCHES) {
  for (const [label, keyType, fragments] of REJECTED_KEY_TYPES) {
    test(`${branch} names a placeholder rather than ${label}`, async () => {
      const rendered = await render(keyType);

      expect(typeLinkOf(rendered)).toMatch(PLACEHOLDER_TYPE_LINK);
      for (const fragment of fragments)
        expect(rendered).not.toContain(fragment);
      expect(rendered).toContain(firstPartyStep);
    });
  }

  test(`${branch} names a conforming key type verbatim`, async () => {
    // A long real-world certificate type. Nothing about a legitimate key type
    // changes on the way to the operator: the bound only replaces what falls
    // outside it.
    const keyType = "ecdsa-sha2-nistp521-cert-v01@openssh.com";
    const rendered = await render(keyType);

    expect(typeLinkOf(rendered)).toBe(`${TYPE_LINK_PREFIX}${keyType}`);
    expect(rendered).toContain(firstPartyStep);
  });
}

// Redaction at the composition site is a convention over every server- and
// partner-controlled fragment, kept whether or not the partition already
// contains the fragment's reach. The configured host is where a sliced key can
// still arrive on these refusals -- on the acceptor route it is copied verbatim
// out of the partner's invitation endpoint -- and no armor of it ever renders.
test("a sliced key in the configured host does not suppress the no-pin refusal", async () => {
  const rendered = await renderNoPinRefusal(
    "ssh-ed25519",
    "-----BEGIN OPENSSH PRIVATE KEY-----\nc2gtcnNhAAAAAwEAAQ==\nQ1n3QqzB2rN",
  );

  expect(rendered).toContain("[redacted private key]");
  expect(rendered).not.toContain("c2gtcnNhAAAAAwEAAQ==");
  expect(rendered).toContain("It presented fingerprint SHA256:");
});

test("buildConnectOptions always sets readyTimeout: the default when unset, the configured value otherwise", () => {
  const { session } = makeSession();

  const defaulted = session.buildConnectOptions(
    { channel: "sftp", server: { host: "sftp.example.org" } },
    { includeCredentials: true },
  );
  expect(defaulted["readyTimeout"]).toBe(DEFAULT_SERVER_CONNECT_TIMEOUT_MS);

  const configured = session.buildConnectOptions(
    {
      channel: "sftp",
      server: { host: "sftp.example.org" },
      options: { serverConnectTimeoutMs: 12345 },
    },
    { includeCredentials: true },
  );
  expect(configured["readyTimeout"]).toBe(12345);
});
