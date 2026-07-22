import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { JobApiConfigError } from "@jobs/gate";
import { validateAuthoredSftpServer } from "@jobs/sftpServer";

import { TEST_HOST_KEY_FINGERPRINT, tempDataRoot } from "../utils/jobFixtures";

// validateAuthoredSftpServer is the gate between an operator's in-console
// authoring request and the connection block the appliance later composes into
// CLI configs. These pin its strictness: only the allowlisted fields, an @path
// credential that resolves, only literal canonical fingerprints, core's
// cross-field refines.

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A scratch directory holding referenced secrets. */
function scratchDir(): string {
  const dir = tempDataRoot("sftp-server");
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/** Write a secret file the @path references can point at, returning its path. */
function writeSecretFile(dir: string): string {
  const filePath = path.join(dir, "server-password");
  fs.writeFileSync(filePath, "not-read-by-validation\n");
  return filePath;
}

describe("validateAuthoredSftpServer (request-sourced authoring path)", () => {
  /** A minimal valid authoring body with a file-reference password credential. */
  function authoredBody(
    overrides: Record<string, unknown> = {},
    credential?: unknown,
  ) {
    return {
      host: "sftp.partner.example",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      credential: credential ?? {
        kind: "ref",
        ref: "@PLACEHOLDER",
        credType: "password",
      },
      ...overrides,
    };
  }

  test("validates a file-reference credential through the shared chain", () => {
    const dir = scratchDir();
    const secretPath = writeSecretFile(dir);
    const dataRoot = path.join(dir, "data-root");
    const { entry } = validateAuthoredSftpServer(
      authoredBody(
        { port: 2222, username: "linkage", path: "/exchange" },
        { kind: "ref", ref: `@${secretPath}`, credType: "password" },
      ),
      dataRoot,
      undefined,
    );
    expect(entry.host).toBe("sftp.partner.example");
    expect(entry.port).toBe(2222);
    expect(entry.username).toBe("linkage");
    expect(entry.path).toBe("/exchange");
    expect(entry.password).toBe(`@${secretPath}`);
    expect(entry.privateKey).toBeUndefined();
    expect(entry.hostKeyFingerprint).toBe(TEST_HOST_KEY_FINGERPRINT);
  });

  test("credType private_key maps the ref to the privateKey field", () => {
    const dir = scratchDir();
    const keyPath = writeSecretFile(dir);
    const dataRoot = path.join(dir, "data-root");
    const { entry } = validateAuthoredSftpServer(
      authoredBody(
        {},
        { kind: "ref", ref: `@${keyPath}`, credType: "private_key" },
      ),
      dataRoot,
      undefined,
    );
    expect(entry.privateKey).toBe(`@${keyPath}`);
    expect(entry.password).toBeUndefined();
  });

  test("a credential.kind other than ref is refused with a clear message", () => {
    const dir = scratchDir();
    expect(() =>
      validateAuthoredSftpServer(
        authoredBody(
          {},
          { kind: "inline", ref: "hunter2", credType: "password" },
        ),
        path.join(dir, "data-root"),
        undefined,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining('kind must be "ref"') as string,
      }) as Error,
    );
  });

  test("a host carrying userinfo, a scheme/path, or whitespace is rejected", () => {
    const dir = scratchDir();
    const secretPath = writeSecretFile(dir);
    const dataRoot = path.join(dir, "data-root");
    for (const host of ["sftp://user:pw@evil", "user:pw@evil", "sftp .evil"]) {
      let caught: Error | null = null;
      try {
        validateAuthoredSftpServer(
          authoredBody(
            { host },
            { kind: "ref", ref: `@${secretPath}`, credType: "password" },
          ),
          dataRoot,
          undefined,
        );
      } catch (error) {
        caught = error as Error;
      }
      expect(caught).toBeInstanceOf(JobApiConfigError);
      expect(caught?.message).toContain("server.host");
      // The rejection names the field, never the smuggled value.
      expect(caught?.message).not.toContain(host);
    }
  });

  test("a bare hostname, an IPv4, and a bracketed IPv6 host are accepted", () => {
    const dir = scratchDir();
    const secretPath = writeSecretFile(dir);
    const dataRoot = path.join(dir, "data-root");
    for (const host of ["sftp.partner.example", "10.0.0.5", "[2001:db8::1]"]) {
      const { entry } = validateAuthoredSftpServer(
        authoredBody(
          { host },
          { kind: "ref", ref: `@${secretPath}`, credType: "password" },
        ),
        dataRoot,
        undefined,
      );
      expect(entry.host).toBe(host);
    }
  });

  test("an unknown top-level field is rejected (strict body)", () => {
    const dir = scratchDir();
    expect(() =>
      validateAuthoredSftpServer(
        authoredBody({ remote: "prod_east" }),
        path.join(dir, "data-root"),
        undefined,
      ),
    ).toThrow(JobApiConfigError);
  });

  test("a missing fingerprint is rejected", () => {
    const dir = scratchDir();
    const secretPath = writeSecretFile(dir);
    expect(() =>
      validateAuthoredSftpServer(
        {
          host: "sftp.partner.example",
          credential: {
            kind: "ref",
            ref: `@${secretPath}`,
            credType: "password",
          },
        },
        path.join(dir, "data-root"),
        undefined,
      ),
    ).toThrow(JobApiConfigError);
  });

  test("an @-file fingerprint is rejected (literal pin required)", () => {
    const dir = scratchDir();
    const secretPath = writeSecretFile(dir);
    expect(() =>
      validateAuthoredSftpServer(
        authoredBody(
          { hostKeyFingerprint: "@/etc/psilink/fingerprint" },
          { kind: "ref", ref: `@${secretPath}`, credType: "password" },
        ),
        path.join(dir, "data-root"),
        undefined,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("literal") as string,
      }) as Error,
    );
  });

  test("a malformed fingerprint is rejected", () => {
    const dir = scratchDir();
    const secretPath = writeSecretFile(dir);
    expect(() =>
      validateAuthoredSftpServer(
        authoredBody(
          { hostKeyFingerprint: "SHA256:not-canonical" },
          { kind: "ref", ref: `@${secretPath}`, credType: "password" },
        ),
        path.join(dir, "data-root"),
        undefined,
      ),
    ).toThrow(JobApiConfigError);
  });

  test("a relative @path credential is rejected", () => {
    const dir = scratchDir();
    expect(() =>
      validateAuthoredSftpServer(
        authoredBody(
          {},
          { kind: "ref", ref: "@secrets/pw", credType: "password" },
        ),
        path.join(dir, "data-root"),
        undefined,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("absolute") as string,
      }) as Error,
    );
  });

  test("a credential ref to a missing file is rejected without echoing it", () => {
    const dir = scratchDir();
    const missing = path.join(dir, "never-created", "pw");
    let caught: Error | null = null;
    try {
      validateAuthoredSftpServer(
        authoredBody(
          {},
          { kind: "ref", ref: `@${missing}`, credType: "password" },
        ),
        path.join(dir, "data-root"),
        undefined,
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).toContain("server.password");
    expect(caught?.message).not.toContain(missing);
  });

  test("a credential ref under the data root is rejected without echoing it", () => {
    const dir = scratchDir();
    const dataRoot = path.join(dir, "data-root");
    const ref = path.join(dataRoot, "planted", "pw");
    let caught: Error | null = null;
    try {
      validateAuthoredSftpServer(
        authoredBody({}, { kind: "ref", ref: `@${ref}`, credType: "password" }),
        dataRoot,
        undefined,
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).toContain("data root");
    expect(caught?.message).not.toContain(ref);
  });

  test("a credential ref under a distinct rendezvous dir is rejected", () => {
    const dir = scratchDir();
    const dataRoot = path.join(dir, "data-root");
    const rendezvousDir = path.join(dir, "rendezvous");
    fs.mkdirSync(path.join(rendezvousDir, "planted"), { recursive: true });
    fs.writeFileSync(path.join(rendezvousDir, "planted", "pw"), "x");
    expect(() =>
      validateAuthoredSftpServer(
        authoredBody(
          {},
          {
            kind: "ref",
            ref: `@${path.join(rendezvousDir, "planted", "pw")}`,
            credType: "password",
          },
        ),
        dataRoot,
        rendezvousDir,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("rendezvous") as string,
      }) as Error,
    );
  });

  test("an inline (non-@) credential ref is rejected", () => {
    const dir = scratchDir();
    expect(() =>
      validateAuthoredSftpServer(
        authoredBody({}, { kind: "ref", ref: "hunter2", credType: "password" }),
        path.join(dir, "data-root"),
        undefined,
      ),
    ).toThrow(JobApiConfigError);
  });

  test("core's cross-field refine (keyboard_interactive needs password) holds", () => {
    const dir = scratchDir();
    const keyPath = writeSecretFile(dir);
    expect(() =>
      validateAuthoredSftpServer(
        authoredBody(
          { keyboardInteractive: true },
          { kind: "ref", ref: `@${keyPath}`, credType: "private_key" },
        ),
        path.join(dir, "data-root"),
        undefined,
      ),
    ).toThrow(JobApiConfigError);
  });
});

describe("validateAuthoredSftpServer mountRef credential path", () => {
  /** A secrets mount holding a loose credential file and a nested dotfile key. */
  function secretsMount(): string {
    const dir = scratchDir();
    fs.writeFileSync(path.join(dir, "partner-password"), "s3cret\n");
    fs.mkdirSync(path.join(dir, ".ssh"));
    fs.writeFileSync(path.join(dir, ".ssh", "id_ed25519"), "PRIVATE\n");
    return dir;
  }

  function mountBody(
    subPath: Array<string>,
    credType: "password" | "private_key" = "password",
  ) {
    return {
      host: "sftp.partner.example",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      credential: { kind: "mountRef", mount: "secrets", subPath, credType },
    };
  }

  test("resolves a picked file to an @path and validates it", () => {
    const dir = scratchDir();
    const secretsDir = secretsMount();
    const { entry } = validateAuthoredSftpServer(
      mountBody(["partner-password"]),
      path.join(dir, "data-root"),
      undefined,
      secretsDir,
    );
    expect(entry.password).toBe(
      `@${fs.realpathSync(path.join(secretsDir, "partner-password"))}`,
    );
  });

  test("resolves a nested dotfile key for a private_key credential", () => {
    const dir = scratchDir();
    const secretsDir = secretsMount();
    const { entry } = validateAuthoredSftpServer(
      mountBody([".ssh", "id_ed25519"], "private_key"),
      path.join(dir, "data-root"),
      undefined,
      secretsDir,
    );
    expect(entry.privateKey).toBe(
      `@${fs.realpathSync(path.join(secretsDir, ".ssh", "id_ed25519"))}`,
    );
    expect(entry.password).toBeUndefined();
  });

  test("a subPath that escapes the mount is refused, no path echoed", () => {
    const dir = scratchDir();
    const secretsDir = secretsMount();
    let caught: Error | null = null;
    try {
      validateAuthoredSftpServer(
        mountBody([".."]),
        path.join(dir, "data-root"),
        undefined,
        secretsDir,
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).toContain("connection.credential");
    expect(caught?.message).not.toContain(secretsDir);
  });

  test("a subPath naming no regular file is refused", () => {
    const dir = scratchDir();
    const secretsDir = secretsMount();
    expect(() =>
      validateAuthoredSftpServer(
        mountBody(["absent"]),
        path.join(dir, "data-root"),
        undefined,
        secretsDir,
      ),
    ).toThrow(JobApiConfigError);
  });

  test("a directory subPath is not a credential file", () => {
    const dir = scratchDir();
    const secretsDir = secretsMount();
    expect(() =>
      validateAuthoredSftpServer(
        mountBody([".ssh"]),
        path.join(dir, "data-root"),
        undefined,
        secretsDir,
      ),
    ).toThrow(JobApiConfigError);
  });

  test("an unset secrets mount refuses a mountRef, naming the field", () => {
    const dir = scratchDir();
    let caught: Error | null = null;
    try {
      validateAuthoredSftpServer(
        mountBody(["partner-password"]),
        path.join(dir, "data-root"),
        undefined,
        undefined,
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).toContain("connection.credential");
    expect(caught?.message).toContain("secrets mount");
  });

  test("an unknown mount id is rejected naming the field", () => {
    const dir = scratchDir();
    const secretsDir = secretsMount();
    let caught: Error | null = null;
    try {
      validateAuthoredSftpServer(
        {
          host: "sftp.partner.example",
          hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
          credential: {
            kind: "mountRef",
            mount: "inputs",
            subPath: ["partner-password"],
            credType: "password",
          },
        },
        path.join(dir, "data-root"),
        undefined,
        secretsDir,
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).toContain("connection.credential.mount");
  });

  test("a resolved mountRef under the data root is rejected", () => {
    // The secrets mount is (mis)configured INSIDE the data root: the resolved
    // @path lands under the data root, so the containment check still rejects it --
    // the picker path is held to the same containment as a typed ref.
    const dir = scratchDir();
    const dataRoot = path.join(dir, "data-root");
    const secretsDir = path.join(dataRoot, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, "pw"), "x");
    let caught: Error | null = null;
    try {
      validateAuthoredSftpServer(
        mountBody(["pw"]),
        dataRoot,
        undefined,
        secretsDir,
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).toContain("data root");
  });
});

describe("validateAuthoredSftpServer raw (pasted) credential path", () => {
  /** A created scratch directory the materialization writes into. */
  function credentialScratchDir(): string {
    const dir = tempDataRoot("sftp-scratch");
    fs.mkdirSync(dir, { recursive: true });
    dirs.push(dir);
    return dir;
  }

  function rawBody(
    value: unknown,
    credType: "password" | "private_key" = "password",
  ) {
    return {
      host: "sftp.partner.example",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      credential: { kind: "raw", value, credType },
    };
  }

  test("materializes a pasted value to a 0600 @path and validates it", () => {
    const dir = scratchDir();
    const scratch = credentialScratchDir();
    const result = validateAuthoredSftpServer(
      rawBody("s3cret-password"),
      path.join(dir, "data-root"),
      undefined,
      undefined,
      scratch,
    );
    const materialized = result.materializedCredentialPath!;
    expect(materialized).toBeDefined();
    expect(path.dirname(materialized)).toBe(scratch);
    // The entry carries the @path, never the value.
    expect(result.entry.password).toBe(`@${materialized}`);
    expect(result.entry.password).not.toContain("s3cret");
    expect(fs.statSync(materialized).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(materialized, "utf8")).toBe("s3cret-password");
  });

  test("a pasted private_key maps to the privateKey field", () => {
    const dir = scratchDir();
    const scratch = credentialScratchDir();
    const result = validateAuthoredSftpServer(
      rawBody("-----BEGIN KEY-----", "private_key"),
      path.join(dir, "data-root"),
      undefined,
      undefined,
      scratch,
    );
    expect(result.entry.privateKey).toBe(
      `@${result.materializedCredentialPath!}`,
    );
    expect(result.entry.password).toBeUndefined();
  });

  test("a raw credential with no scratch dir configured is refused", () => {
    const dir = scratchDir();
    let caught: Error | null = null;
    try {
      validateAuthoredSftpServer(
        rawBody("s3cret"),
        path.join(dir, "data-root"),
        undefined,
        undefined,
        undefined,
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).toContain("connection.credential");
    // The rejection never echoes the pasted value.
    expect(caught?.message).not.toContain("s3cret");
  });

  test("an empty pasted value is rejected without echoing it", () => {
    const dir = scratchDir();
    const scratch = credentialScratchDir();
    let caught: Error | null = null;
    try {
      validateAuthoredSftpServer(
        rawBody(""),
        path.join(dir, "data-root"),
        undefined,
        undefined,
        scratch,
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).toContain("connection.credential");
    // Nothing was materialized for a shape-invalid credential.
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  test("a non-string pasted value is rejected without echoing it", () => {
    const dir = scratchDir();
    const scratch = credentialScratchDir();
    let caught: Error | null = null;
    try {
      validateAuthoredSftpServer(
        rawBody({ nested: "leak-me" }),
        path.join(dir, "data-root"),
        undefined,
        undefined,
        scratch,
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).not.toContain("leak-me");
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  test("a validation failure after materialization deletes the scratch file", () => {
    // The value materializes, then the (bad) fingerprint fails validation;
    // the just-written secret must not linger at rest.
    const dir = scratchDir();
    const scratch = credentialScratchDir();
    let caught: Error | null = null;
    try {
      validateAuthoredSftpServer(
        {
          host: "sftp.partner.example",
          hostKeyFingerprint: "not-a-fingerprint",
          credential: { kind: "raw", value: "s3cret", credType: "password" },
        },
        path.join(dir, "data-root"),
        undefined,
        undefined,
        scratch,
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(fs.readdirSync(scratch)).toEqual([]);
  });

  test("a materialized value never lands under the data root", () => {
    const dir = scratchDir();
    const dataRoot = path.join(dir, "data-root");
    const scratch = credentialScratchDir();
    const result = validateAuthoredSftpServer(
      rawBody("s3cret"),
      dataRoot,
      undefined,
      undefined,
      scratch,
    );
    const materialized = result.materializedCredentialPath!;
    const relative = path.relative(path.resolve(dataRoot), materialized);
    expect(relative.startsWith("..") || path.isAbsolute(relative)).toBe(true);
  });
});
