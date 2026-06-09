import { expect, test, vi } from "vitest";
import type { Arguments } from "yargs";
import { getLogger, SHARED_SECRET_REGEX, UsageError } from "@psilink/core";
import type { ConnectionEndpoint } from "@psilink/core";

import {
  buildDataSpec,
  connectionFromEndpoint,
  connectionFromURL,
  generateSharedSecret,
  looksLikeUrl,
  parseCommonBootstrapArgs,
  redactUrlCredentials,
  runOrExit,
} from "../../src/commands/bootstrap";

// runOrExit creates its error logger by name; silence that name so the
// error-path tests below don't print to the console.
getLogger("bootstrap-test").setLevel("silent");

// --- looksLikeUrl ------------------------------------------------------------

test("looksLikeUrl: supported transport schemes are URLs", () => {
  expect(looksLikeUrl("sftp://host/path")).toBe(true);
  expect(looksLikeUrl("ssh://host/path")).toBe(true);
  expect(looksLikeUrl("ws://host/path")).toBe(true);
  expect(looksLikeUrl("wss://host/path")).toBe(true);
  expect(looksLikeUrl("file:///mnt/share")).toBe(true);
});

test("looksLikeUrl: files, invitations, and other schemes are not URLs", () => {
  expect(looksLikeUrl("input.csv")).toBe(false);
  expect(looksLikeUrl("./data/input.csv")).toBe(false);
  expect(looksLikeUrl("@invitation.txt")).toBe(false);
  // A base64url invitation, including one beginning with '-'.
  expect(looksLikeUrl("-eyJ2ZXJzaW9uIjoiMSJ9abc")).toBe(false);
  // A Windows drive path must not be mistaken for a URL with scheme "c:".
  expect(looksLikeUrl("C:\\data\\input.csv")).toBe(false);
  expect(looksLikeUrl("https://example.org")).toBe(false);
});

// --- connectionFromURL -------------------------------------------------------

test("connectionFromURL: sftp URL maps to an sftp connection", () => {
  const conn = connectionFromURL(new URL("sftp://alice@host:2222/drop"), {});
  expect(conn.channel).toBe("sftp");
  if (conn.channel !== "sftp") return;
  expect(conn.server.host).toBe("host");
  expect(conn.server.port).toBe(2222);
  expect(conn.server.username).toBe("alice");
});

test("connectionFromURL: file URL maps to a filedrop connection", () => {
  const conn = connectionFromURL(new URL("file:///mnt/share/drop"), {});
  expect(conn.channel).toBe("filedrop");
  if (conn.channel !== "filedrop") return;
  expect(conn.path).toBe("/mnt/share/drop");
});

test("connectionFromURL: a webrtc (ws) URL is a usage error", () => {
  expect(() => connectionFromURL(new URL("ws://host/path"), {})).toThrow(
    UsageError,
  );
  expect(() => connectionFromURL(new URL("ws://host/path"), {})).toThrow(
    "not yet supported",
  );
});

test("connectionFromURL: a bare-host sftp URL leaves the path unset", () => {
  for (const raw of ["sftp://host", "sftp://host/"]) {
    const conn = connectionFromURL(new URL(raw), {});
    expect(conn.channel).toBe("sftp");
    if (conn.channel !== "sftp") return;
    // A trailing "/" must not be pinned as the remote path; the server's default
    // working directory is used instead.
    expect(conn.server.path).toBeUndefined();
  }
});

test("connectionFromURL: an sftp URL with no host is a usage error", () => {
  expect(() => connectionFromURL(new URL("sftp:///drop"), {})).toThrow(
    UsageError,
  );
  expect(() => connectionFromURL(new URL("sftp:///drop"), {})).toThrow(
    /must include a host/,
  );
});

// --- redactUrlCredentials ----------------------------------------------------

test("redactUrlCredentials: strips an embedded password and username", () => {
  const redacted = redactUrlCredentials(
    new URL("sftp://alice:s3cr3t@host:2222/drop"),
  );
  expect(redacted).not.toContain("s3cr3t");
  expect(redacted).not.toContain("alice");
  expect(redacted).toContain("host");
  expect(redacted).toContain("2222");
  expect(redacted).toContain("/drop");
});

test("redactUrlCredentials: a credential-free URL is unchanged", () => {
  const redacted = redactUrlCredentials(new URL("sftp://host:2222/drop"));
  expect(redacted).toBe("sftp://host:2222/drop");
});

// --- runOrExit ---------------------------------------------------------------

test("runOrExit: a UsageError exits 64", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  await runOrExit("bootstrap-test", async () => {
    throw new UsageError("bad usage");
  });
  expect(exit).toHaveBeenCalledWith(64);
  exit.mockRestore();
});

test("runOrExit: a non-UsageError preserves its own exitCode (not collapsed to 69)", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  await runOrExit("bootstrap-test", async () => {
    // A distinctive code (not 69) proves the `?? exitCode` rung is preserved,
    // so a missing input file keeps its own exit code instead of becoming 69.
    throw Object.assign(new Error("input file not found"), { exitCode: 66 });
  });
  expect(exit).toHaveBeenCalledWith(66);
  exit.mockRestore();
});

test("runOrExit: an error without an exitCode defaults to 69", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  await runOrExit("bootstrap-test", async () => {
    throw new Error("transport failure");
  });
  expect(exit).toHaveBeenCalledWith(69);
  exit.mockRestore();
});

test("runOrExit: a rejected body (e.g. a stdin/prompt error) exits cleanly, never throwing", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  // A readline rejection mid-prompt is just a rejected promise inside the body;
  // runOrExit maps it to an exit rather than letting it crash unhandled.
  await expect(
    runOrExit("bootstrap-test", async () => {
      await Promise.reject(new Error("stdin closed"));
    }),
  ).resolves.toBeUndefined();
  expect(exit).toHaveBeenCalledWith(69);
  exit.mockRestore();
});

test("parseCommonBootstrapArgs: an unrecognized log-level is a usage error", () => {
  // Routed through runOrExit by the handlers, so a UsageError exits 64 via the
  // consistent error path rather than yargs's noisier top-level catch.
  expect(() =>
    parseCommonBootstrapArgs({
      _: [],
      $0: "psilink",
      "log-level": "bogus",
    } as unknown as Arguments),
  ).toThrow(UsageError);
});

test("runOrExit: a successful body does not exit", async () => {
  const exit = vi
    .spyOn(process, "exit")
    .mockImplementation((() => undefined) as never);
  let ran = false;
  await runOrExit("bootstrap-test", async () => {
    ran = true;
  });
  expect(ran).toBe(true);
  expect(exit).not.toHaveBeenCalled();
  exit.mockRestore();
});

// --- connectionFromEndpoint --------------------------------------------------

test("connectionFromEndpoint: no endpoint yields a marked sftp placeholder", () => {
  const { connection, seeded } = connectionFromEndpoint(undefined);
  expect(seeded).toBe(false);
  expect(connection.channel).toBe("sftp");
  if (connection.channel !== "sftp") return;
  expect(connection.server.host).toMatch(/REPLACE_WITH/);
  expect(connection.server.username).toMatch(/REPLACE_WITH/);
});

test("connectionFromEndpoint: an sftp endpoint seeds the locator, marks credentials", () => {
  const endpoint: ConnectionEndpoint = {
    channel: "sftp",
    host: "sftp.example.org",
    port: 2222,
    path: "/exchanges/drop",
  };
  const { connection, seeded } = connectionFromEndpoint(endpoint);
  expect(seeded).toBe(true);
  expect(connection.channel).toBe("sftp");
  if (connection.channel !== "sftp") return;
  expect(connection.server.host).toBe("sftp.example.org");
  expect(connection.server.port).toBe(2222);
  expect(connection.server.path).toBe("/exchanges/drop");
  // The endpoint never carries credentials; the username is a fill-in marker.
  expect(connection.server.username).toMatch(/REPLACE_WITH/);
  expect(connection.server.password).toBeUndefined();
});

test("connectionFromEndpoint: a filedrop endpoint seeds the shared path", () => {
  const endpoint: ConnectionEndpoint = {
    channel: "filedrop",
    path: "/mnt/share/drop",
  };
  const { connection, seeded } = connectionFromEndpoint(endpoint);
  expect(seeded).toBe(true);
  expect(connection.channel).toBe("filedrop");
  if (connection.channel !== "filedrop") return;
  expect(connection.path).toBe("/mnt/share/drop");
});

test("connectionFromEndpoint: a webrtc endpoint seeds the signaling locator", () => {
  const endpoint: ConnectionEndpoint = {
    channel: "webrtc",
    host: "peer.example.org",
    path: "/psi",
  };
  const { connection, seeded } = connectionFromEndpoint(endpoint);
  expect(seeded).toBe(true);
  expect(connection.channel).toBe("webrtc");
  if (connection.channel !== "webrtc") return;
  expect(connection.server.host).toBe("peer.example.org");
  expect(connection.server.path).toBe("/psi");
});

// --- generateSharedSecret -------------------------------------------------------

test("generateSharedSecret: matches the PAKE token format and is non-deterministic", () => {
  const a = generateSharedSecret();
  const b = generateSharedSecret();
  expect(a).toMatch(SHARED_SECRET_REGEX);
  expect(b).toMatch(SHARED_SECRET_REGEX);
  expect(a).not.toBe(b);
});

// --- buildDataSpec -----------------------------------------------------------

const COLUMNS = ["first_name", "last_name", "dob", "ssn"];
const ROWS = {
  rawRows: [
    {
      first_name: "Alice",
      last_name: "Smith",
      dob: "1990-01-02",
      ssn: "123456789",
    },
  ],
  columns: COLUMNS,
};

test("buildDataSpec: infers linkage terms, metadata, and standardization from input (invite)", () => {
  const { dataSpec, warnings } = buildDataSpec({
    identity: "Agency A",
    rows: ROWS,
  });
  expect(warnings).toEqual([]);
  expect(dataSpec.linkageTerms.identity).toBe("Agency A");
  expect(dataSpec.linkageTerms.linkageKeys.length).toBeGreaterThan(0);
  expect(dataSpec.metadata).toBeDefined();
  expect(dataSpec.standardization).toBeDefined();
});

test("buildDataSpec: without input rows, the spec is just the supplied terms (accept)", () => {
  const { dataSpec } = buildDataSpec({
    identity: "Agency B",
    rows: ROWS,
  });
  // Reuse the inferred terms as a stand-in for an invitation's terms.
  const { dataSpec: termsOnly } = buildDataSpec({
    terms: dataSpec.linkageTerms,
    identity: "Agency B",
  });
  expect(termsOnly.linkageTerms).toEqual(dataSpec.linkageTerms);
  expect(termsOnly.metadata).toBeUndefined();
  expect(termsOnly.standardization).toBeUndefined();
});

test("buildDataSpec: supplied terms plus input infer metadata and standardization (accept)", () => {
  const { dataSpec: inferred } = buildDataSpec({
    identity: "Agency C",
    rows: ROWS,
  });
  const { dataSpec, warnings } = buildDataSpec({
    terms: inferred.linkageTerms,
    identity: "Agency C",
    rows: ROWS,
  });
  expect(warnings).toEqual([]);
  expect(dataSpec.linkageTerms).toEqual(inferred.linkageTerms);
  expect(dataSpec.metadata).toBeDefined();
  expect(dataSpec.standardization).toBeDefined();
});
