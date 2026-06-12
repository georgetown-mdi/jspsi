import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";

import { UsageError, parseExchangeSpec } from "@psilink/core";
import type {
  ExchangeSpec,
  SFTPConnectionConfig,
  WebRTCConnectionConfig,
} from "@psilink/core";

import {
  resolveAtSignRef,
  resolveAtSignRefs,
  resolveConnectionCredentials,
  resolveExchangeSpecRefs,
} from "../../src/util/atSignRefs";

let dir: string;
let prevHome: string | undefined;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-atsign-"));
  // Saved/restored around every test so the ~-expansion case can repoint HOME
  // without leaking into other tests.
  prevHome = process.env.HOME;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("returns a literal (non-@) value unchanged", () => {
  expect(resolveAtSignRefs("plain")).toBe("plain");
});

test("reads an @file reference and trims surrounding whitespace", () => {
  const p = path.join(dir, "secret.txt");
  fs.writeFileSync(p, "  s3cret\n");
  expect(resolveAtSignRefs(`@${p}`)).toBe("s3cret");
});

test("expands a leading ~ in an @file reference", () => {
  if (process.platform === "win32") return; // os.homedir() ignores $HOME here
  process.env.HOME = dir;
  fs.writeFileSync(path.join(dir, "id_rsa"), "KEYDATA\n");
  expect(resolveAtSignRefs("@~/id_rsa")).toBe("KEYDATA");
});

test("recurses into objects and arrays", () => {
  const p = path.join(dir, "v.txt");
  fs.writeFileSync(p, "V");
  expect(resolveAtSignRefs({ a: `@${p}`, b: ["x", `@${p}`] })).toEqual({
    a: "V",
    b: ["x", "V"],
  });
});

test("a missing @file reference is a UsageError naming the reference", () => {
  const missing = `@${path.join(dir, "absent")}`;
  expect(() => resolveAtSignRef(missing)).toThrow(UsageError);
  expect(() => resolveAtSignRef(missing)).toThrow(missing);
});

test("an empty (or whitespace-only) @file reference is a UsageError", () => {
  const ref = `@${path.join(dir, "blank")}`;
  fs.writeFileSync(path.join(dir, "blank"), "   \n");
  expect(() => resolveAtSignRef(ref)).toThrow(UsageError);
  expect(() => resolveAtSignRef(ref)).toThrow(ref);
});

// --- resolveConnectionCredentials --------------------------------------------

function sftpConn(
  server: SFTPConnectionConfig["server"],
): SFTPConnectionConfig {
  return { channel: "sftp", server };
}

test("resolveConnectionCredentials resolves an @path password and private key", () => {
  const pwFile = path.join(dir, "pw");
  const keyFile = path.join(dir, "id_rsa");
  fs.writeFileSync(pwFile, "s3cret\n");
  fs.writeFileSync(keyFile, "KEYDATA\n");
  const resolved = resolveConnectionCredentials(
    sftpConn({
      host: "h",
      password: `@${pwFile}`,
      privateKey: `@${keyFile}`,
    }),
  ) as SFTPConnectionConfig;
  expect(resolved.server.password).toBe("s3cret");
  expect(resolved.server.privateKey).toBe("KEYDATA");
});

test("resolveConnectionCredentials leaves a literal credential unchanged", () => {
  const resolved = resolveConnectionCredentials(
    sftpConn({ host: "h", password: "literal-pw" }),
  ) as SFTPConnectionConfig;
  expect(resolved.server.password).toBe("literal-pw");
});

test("resolveConnectionCredentials does not mutate its input (the @path survives for persistence)", () => {
  const pwFile = path.join(dir, "pw2");
  fs.writeFileSync(pwFile, "s3cret\n");
  const original = sftpConn({ host: "h", password: `@${pwFile}` });
  const resolved = resolveConnectionCredentials(
    original,
  ) as SFTPConnectionConfig;
  expect(original.server.password).toBe(`@${pwFile}`);
  expect(resolved.server.password).toBe("s3cret");
});

test("resolveConnectionCredentials is a no-op on a filedrop connection", () => {
  const conn = { channel: "filedrop", path: "/mnt/share" } as const;
  expect(resolveConnectionCredentials(conn)).toBe(conn);
});

test("resolveConnectionCredentials surfaces a missing @path file as a UsageError", () => {
  const conn = sftpConn({ host: "h", password: `@${path.join(dir, "gone")}` });
  expect(() => resolveConnectionCredentials(conn)).toThrow(UsageError);
});

// --- resolveExchangeSpecRefs -------------------------------------------------

// Minimal linkage terms (snake_case, as a config file is authored) so each test
// can parse a real ExchangeSpec and exercise parse + resolution together.
const BASE_LINKAGE = {
  version: "1.0.0",
  identity: "Test Party",
  date: "2025-01-01",
  algorithm: "psi",
  output: { expects_output: true, share_with_partner: false },
  deduplicate: false,
  linkage_fields: [{ name: "ssn", type: "ssn" }],
  linkage_keys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

/** Parse a raw config into a spec, supplying the minimal linkage terms. */
function parseSpec(raw: Record<string, unknown>): ExchangeSpec {
  return parseExchangeSpec({ linkage_terms: BASE_LINKAGE, ...raw });
}

/** Write a secret file under the test dir and return its `@path` reference. */
function atFile(name: string, contents: string): string {
  fs.writeFileSync(path.join(dir, name), contents);
  return `@${path.join(dir, name)}`;
}

test("resolveExchangeSpecRefs resolves @path credential and opaque fields on an sftp connection", () => {
  const spec = parseSpec({
    connection: {
      channel: "sftp",
      server: {
        host: "h",
        password: atFile("pw", "s3cret\n"),
        provision: { host: "prov", auth: { bearer: atFile("tok", "BEAR\n") } },
      },
      proxy: {
        host: "proxy",
        auth: { username: "u", password: atFile("pp", "PROXYPW\n") },
      },
      provider_options: { nested: { secret: atFile("po", "OPAQUE\n") } },
    },
  });
  const conn = resolveExchangeSpecRefs(spec).connection as SFTPConnectionConfig;
  expect(conn.server.password).toBe("s3cret");
  expect(conn.server.provision?.auth?.bearer).toBe("BEAR");
  expect(conn.proxy?.auth?.password).toBe("PROXYPW");
  expect((conn.providerOptions?.nested as { secret: string }).secret).toBe(
    "OPAQUE",
  );
});

test("resolveExchangeSpecRefs expands a leading ~ in an @path private key", () => {
  if (process.platform === "win32") return; // os.homedir() ignores $HOME here
  process.env.HOME = dir;
  fs.writeFileSync(path.join(dir, "id_rsa"), "KEYDATA\n");
  const spec = parseSpec({
    connection: {
      channel: "sftp",
      server: { host: "h", private_key: "@~/id_rsa" },
    },
  });
  const conn = resolveExchangeSpecRefs(spec).connection as SFTPConnectionConfig;
  expect(conn.server.privateKey).toBe("KEYDATA");
});

test("resolveExchangeSpecRefs resolves @path turn credentials and provision auth on a webrtc connection", () => {
  const spec = parseSpec({
    connection: {
      channel: "webrtc",
      server: {
        host: "peer",
        provision: {
          host: "prov",
          auth: { bearer: atFile("wtok", "WBEAR\n") },
        },
      },
      turn: [
        {
          url: "turn:relay:3478",
          username: "u",
          credential: atFile("cred", "TURNPW\n"),
        },
      ],
      provider_options: { key: atFile("wpo", "WOPAQUE\n") },
    },
  });
  const conn = resolveExchangeSpecRefs(spec)
    .connection as WebRTCConnectionConfig;
  expect(conn.turn?.[0].credential).toBe("TURNPW");
  expect(conn.server.provision?.auth?.bearer).toBe("WBEAR");
  expect(conn.providerOptions?.key).toBe("WOPAQUE");
});

test("resolveExchangeSpecRefs resolves @path auth on a webrtc iceProvision endpoint", () => {
  const spec = parseSpec({
    connection: {
      channel: "webrtc",
      server: { host: "peer" },
      ice_provision: {
        host: "ice",
        auth: { username: "u", password: atFile("ipw", "ICEPW\n") },
      },
    },
  });
  const conn = resolveExchangeSpecRefs(spec)
    .connection as WebRTCConnectionConfig;
  expect(conn.iceProvision?.auth?.password).toBe("ICEPW");
});

test("resolveExchangeSpecRefs leaves a free-text field with a literal leading @ unchanged", () => {
  // A literal leading @ would have errored at load under the old blanket
  // recursion (read as the file path `home`); it now survives parse + resolution
  // verbatim, so it lands in the self-attested exchange record as written.
  const spec = parseSpec({
    linkage_terms: { ...BASE_LINKAGE, identity: "@home" },
    connection: { channel: "sftp", server: { host: "h" } },
    retention_disposition: "@retain-elsewhere",
  });
  const resolved = resolveExchangeSpecRefs(spec);
  expect(resolved.linkageTerms.identity).toBe("@home");
  expect(resolved.retentionDisposition).toBe("@retain-elsewhere");
});

test("resolveExchangeSpecRefs does not read a free-text leading-@ value even when the path exists", () => {
  // The closed foot-gun: a free-text value whose @path happens to resolve to a
  // real file must NOT pull that file's contents into the record.
  const ref = atFile("on-disk", "EXFILTRATED");
  const spec = parseSpec({
    connection: { channel: "sftp", server: { host: "h" } },
    retention_disposition: ref,
  });
  const resolved = resolveExchangeSpecRefs(spec);
  expect(resolved.retentionDisposition).toBe(ref);
  expect(resolved.retentionDisposition).not.toBe("EXFILTRATED");
});

test("resolveExchangeSpecRefs leaves signing path fields with a literal leading @ unchanged", () => {
  // signing.identity_file / receipt_output are local paths their consumer opens,
  // not credential values; resolving them to file contents would corrupt them,
  // so they are excluded from the allowlist even when the path exists on disk.
  const idRef = atFile("signing.pem", "PEMDATA");
  const outRef = atFile("receipts", "RECEIPTS");
  const spec = parseSpec({
    connection: { channel: "sftp", server: { host: "h" } },
    signing: {
      mode: "certificate",
      identity_file: idRef,
      receipt_output: outRef,
    },
  });
  const resolved = resolveExchangeSpecRefs(spec);
  expect(resolved.signing?.identityFile).toBe(idRef);
  expect(resolved.signing?.receiptOutput).toBe(outRef);
});

test("resolveExchangeSpecRefs does not mutate its input (the @path survives)", () => {
  const ref = atFile("pw2", "s3cret\n");
  const spec = parseSpec({
    connection: { channel: "sftp", server: { host: "h", password: ref } },
  });
  const resolved = resolveExchangeSpecRefs(spec);
  expect((spec.connection as SFTPConnectionConfig).server.password).toBe(ref);
  expect((resolved.connection as SFTPConnectionConfig).server.password).toBe(
    "s3cret",
  );
});

test("resolveExchangeSpecRefs surfaces a missing @path credential file as a UsageError", () => {
  const spec = parseSpec({
    connection: {
      channel: "sftp",
      server: { host: "h", password: `@${path.join(dir, "gone")}` },
    },
  });
  expect(() => resolveExchangeSpecRefs(spec)).toThrow(UsageError);
});

test("resolveExchangeSpecRefs rejects an @path turn credential that resolves to an empty file", () => {
  // Resolution runs after parse, so turn.credential's min(1) validated the
  // non-empty "@path" literal; the empty-file guard catches the "" the file
  // resolves to rather than letting it reach TURN auth.
  const ref = atFile("empty-cred", "\n");
  const spec = parseSpec({
    connection: {
      channel: "webrtc",
      server: { host: "peer" },
      turn: [{ url: "turn:relay:3478", username: "u", credential: ref }],
    },
  });
  expect(() => resolveExchangeSpecRefs(spec)).toThrow(UsageError);
});
