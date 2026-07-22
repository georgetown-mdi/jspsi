import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  JOB_SFTP_SERVER_ENV,
  LEGACY_JOB_SFTP_REMOTES_ENV,
  loadSftpServer,
  loadSftpServerFromEnv,
  validateAuthoredSftpServer,
} from "@jobs/sftpServer";
import { JobApiConfigError } from "@jobs/gate";
import { useSftpServer } from "@jobs/index";

import { TEST_HOST_KEY_FINGERPRINT, tempDataRoot } from "../utils/jobFixtures";

// The loader is the boot-time gate between an operator's SFTP server file and the
// connection block the appliance later composes into CLI configs. These pin its
// strictness: only the allowlisted fields, only @path credentials outside the
// data root, only literal canonical fingerprints, a single server block.

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A scratch directory holding the server file and any referenced secrets. */
function scratchDir(): string {
  const dir = tempDataRoot("sftp-server");
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/** Write an sftp server YAML document to disk, returning its path. */
function writeServerFile(dir: string, content: string): string {
  const filePath = path.join(dir, "sftp-server.yaml");
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Write a secret file the @path references can point at, returning its path. */
function writeSecretFile(dir: string): string {
  const filePath = path.join(dir, "server-password");
  fs.writeFileSync(filePath, "not-read-by-the-loader\n");
  return filePath;
}

/** Compose a server document from YAML body lines. */
function serverYaml(entryLines: Array<string>): string {
  return ["server:", ...entryLines.map((line) => `  ${line}`), ""].join("\n");
}

function loadSingle(
  entryLines: Array<string>,
  options?: {
    dataRoot?: string;
    rendezvousDir?: string;
  },
) {
  const dir = scratchDir();
  const dataRoot = options?.dataRoot ?? path.join(dir, "data-root");
  const filePath = writeServerFile(dir, serverYaml(entryLines));
  return loadSftpServer(filePath, dataRoot, options?.rendezvousDir);
}

describe("loadSftpServer happy path", () => {
  test("loads a full entry, camelizing fields", () => {
    const dir = scratchDir();
    const secretPath = writeSecretFile(dir);
    const dataRoot = path.join(dir, "data-root");
    const filePath = writeServerFile(
      dir,
      serverYaml([
        "host: sftp.example.org",
        "port: 2222",
        "username: linkage",
        "path: /exchange",
        `password: "@${secretPath}"`,
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        "keyboard_interactive: true",
      ]),
    );

    const entry = loadSftpServer(filePath, dataRoot);
    expect(entry.host).toBe("sftp.example.org");
    expect(entry.port).toBe(2222);
    expect(entry.username).toBe("linkage");
    expect(entry.path).toBe("/exchange");
    expect(entry.password).toBe(`@${secretPath}`);
    expect(entry.hostKeyFingerprint).toBe(TEST_HOST_KEY_FINGERPRINT);
    expect(entry.keyboardInteractive).toBe(true);
  });

  test("loads a minimal entry (host plus mandatory fingerprint)", () => {
    const entry = loadSingle([
      "host: sftp.example.org",
      `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
    ]);
    expect(entry.host).toBe("sftp.example.org");
    expect(entry.port).toBeUndefined();
    expect(entry.path).toBeUndefined();
  });
});

describe("loadSftpServer rejects unknown and disallowed keys", () => {
  test("provision is rejected, named in the error", () => {
    expect(() =>
      loadSingle([
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        "provision:",
        "  host: wake.example.org",
        "  auth:",
        "    bearer: inline-bearer-credential",
      ]),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("provision") as string,
      }) as Error,
    );
  });

  test("a provision rejection never echoes the inline credential", () => {
    let caught: Error | null = null;
    try {
      loadSingle([
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        "provision:",
        "  auth:",
        "    bearer: inline-bearer-credential",
      ]);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).not.toContain("inline-bearer-credential");
  });

  test("a typo'd credential key (pasword) is rejected", () => {
    expect(() =>
      loadSingle([
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        'pasword: "@/etc/psilink/pw"',
      ]),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("pasword") as string,
      }) as Error,
    );
  });

  test("inbound_path and outbound_path are rejected", () => {
    for (const key of ["inbound_path", "outbound_path"]) {
      expect(() =>
        loadSingle([
          "host: sftp.example.org",
          `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
          `${key}: /split`,
        ]),
      ).toThrow(JobApiConfigError);
    }
  });

  test("certificate and known_hosts are rejected", () => {
    for (const key of ["certificate", "known_hosts"]) {
      expect(() =>
        loadSingle([
          "host: sftp.example.org",
          `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
          `${key}: /some/file`,
        ]),
      ).toThrow(JobApiConfigError);
    }
  });
});

describe("loadSftpServer credential reference rules", () => {
  test("an inline (non-@) credential is rejected without echoing the value", () => {
    let caught: Error | null = null;
    try {
      loadSingle([
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        "password: hunter2-inline-secret",
      ]);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).toContain("server.password");
    expect(caught?.message).not.toContain("hunter2-inline-secret");
  });

  test("a relative @path is rejected", () => {
    expect(() =>
      loadSingle([
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        'password: "@secrets/pw"',
      ]),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("absolute") as string,
      }) as Error,
    );
  });

  test("an @path under the data root is rejected", () => {
    const dir = scratchDir();
    const dataRoot = path.join(dir, "data-root");
    let caught: Error | null = null;
    try {
      loadSingle(
        [
          "host: sftp.example.org",
          `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
          `password: "@${path.join(dataRoot, "planted", "pw")}"`,
        ],
        { dataRoot },
      );
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).toContain("data root");
    // The boot path carries no authoring remediation: a deploy-time file editor
    // does not paste and cannot set JOB_SECRETS_DIR from the console.
    expect(caught?.message).not.toContain("JOB_SECRETS_DIR");
  });

  test("a dot-dot @path that normalizes back under the data root is rejected", () => {
    const dir = scratchDir();
    const dataRoot = path.join(dir, "data-root");
    const rootName = path.basename(dataRoot);
    // Built by concatenation, NOT path.join (which would pre-normalize the
    // ".." away before the loader ever saw it).
    const sneaky = `${dataRoot}/../${rootName}/planted/pw`;
    expect(() =>
      loadSingle(
        [
          "host: sftp.example.org",
          `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
          `password: "@${sneaky}"`,
        ],
        { dataRoot },
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("data root") as string,
      }) as Error,
    );
  });

  test("a sibling ..-prefixed name outside the data root is NOT confused as inside", () => {
    // /x/..sibling escapes nothing -- but /x-sibling relative to /x starts with
    // ".."; the check must be segment-aware, so a legitimate file next to the
    // data root still loads.
    const dir = scratchDir();
    const dataRoot = path.join(dir, "data-root");
    const secretPath = path.join(dir, "data-root-secrets", "pw");
    fs.mkdirSync(path.dirname(secretPath), { recursive: true });
    fs.writeFileSync(secretPath, "x");
    const entry = loadSingle(
      [
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        `password: "@${secretPath}"`,
      ],
      { dataRoot },
    );
    expect(entry.password).toBe(`@${secretPath}`);
  });

  test("a reference to a missing file is rejected without echoing the path value", () => {
    const dir = scratchDir();
    const missing = path.join(dir, "never-created", "pw");
    let caught: Error | null = null;
    try {
      loadSingle([
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        `password: "@${missing}"`,
      ]);
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).toContain("server.password");
    expect(caught?.message).not.toContain(missing);
  });

  test("privateKey and privateKeyPassphrase follow the same @path rules", () => {
    const dir = scratchDir();
    const keyPath = writeSecretFile(dir);
    expect(() =>
      loadSingle([
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        `private_key: "@${keyPath}"`,
        "private_key_passphrase: inline-passphrase",
      ]),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining(
          "server.privateKeyPassphrase",
        ) as string,
      }) as Error,
    );
  });

  test("an @path under a distinct rendezvous dir is rejected", () => {
    const dir = scratchDir();
    const dataRoot = path.join(dir, "data-root");
    const rendezvousDir = path.join(dir, "rendezvous");
    fs.mkdirSync(path.join(rendezvousDir, "planted"), { recursive: true });
    fs.writeFileSync(path.join(rendezvousDir, "planted", "pw"), "x");
    expect(() =>
      loadSingle(
        [
          "host: sftp.example.org",
          `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
          `password: "@${path.join(rendezvousDir, "planted", "pw")}"`,
        ],
        { dataRoot, rendezvousDir },
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("rendezvous") as string,
      }) as Error,
    );
  });

  test("a symlink that resolves back under the data root is rejected", () => {
    // The ref path is lexically OUTSIDE the data root, but a symlink in the chain
    // resolves it back inside; the realpath re-confinement catches it.
    const dir = scratchDir();
    const dataRoot = path.join(dir, "data-root");
    fs.mkdirSync(path.join(dataRoot, "planted"), { recursive: true });
    fs.writeFileSync(path.join(dataRoot, "planted", "pw"), "x");
    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside, { recursive: true });
    // outside/link -> data-root/planted; outside/link/pw realpaths inside.
    fs.symlinkSync(path.join(dataRoot, "planted"), path.join(outside, "link"));
    expect(() =>
      loadSingle(
        [
          "host: sftp.example.org",
          `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
          `password: "@${path.join(outside, "link", "pw")}"`,
        ],
        { dataRoot },
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("data root") as string,
      }) as Error,
    );
  });
});

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

  test("a credential ref under the data root is rejected with an authoring next step", () => {
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
    // Names the credential field, keeps the base "data root" phrase the boot and
    // integration tests key on, and appends the operator's next step.
    expect(caught?.message).toContain("server.password");
    expect(caught?.message).toContain("data root");
    expect(caught?.message).toContain("JOB_SECRETS_DIR");
    // Never echoes the submitted @path or the secret it points at.
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

  test("a resolved mountRef still runs the data-root exclusion", () => {
    // The secrets mount is (mis)configured INSIDE the data root: the resolved
    // @path lands under the data root, so assertCredentialRef still rejects it --
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
    // The value materializes, then the (bad) fingerprint fails validateServerEntry;
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

describe("loadSftpServer fingerprint rules", () => {
  test("a missing fingerprint is rejected", () => {
    expect(() => loadSingle(["host: sftp.example.org"])).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("hostKeyFingerprint") as string,
      }) as Error,
    );
  });

  test("an @-file fingerprint reference is rejected", () => {
    expect(() =>
      loadSingle([
        "host: sftp.example.org",
        'host_key_fingerprint: "@/etc/psilink/fingerprint"',
      ]),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("literal") as string,
      }) as Error,
    );
  });

  test("a malformed fingerprint is rejected", () => {
    expect(() =>
      loadSingle([
        "host: sftp.example.org",
        "host_key_fingerprint: SHA256:not-canonical",
      ]),
    ).toThrow(JobApiConfigError);
  });

  test("a list entry is validated per element, index in the path", () => {
    expect(() =>
      loadSingle([
        "host: sftp.example.org",
        "host_key_fingerprint:",
        `  - ${TEST_HOST_KEY_FINGERPRINT}`,
        '  - "@/etc/psilink/fingerprint"',
      ]),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("hostKeyFingerprint.1") as string,
      }) as Error,
    );
  });

  test("an empty fingerprint list is rejected", () => {
    expect(() =>
      loadSingle(["host: sftp.example.org", "host_key_fingerprint: []"]),
    ).toThrow(JobApiConfigError);
  });
});

describe("loadSftpServer document shape rules", () => {
  test("a document without the server key is rejected", () => {
    const dir = scratchDir();
    const filePath = writeServerFile(dir, "servers: {}\n");
    expect(() => loadSftpServer(filePath, path.join(dir, "data-root"))).toThrow(
      JobApiConfigError,
    );
  });

  test("a document with a second top-level key is rejected", () => {
    const dir = scratchDir();
    const filePath = writeServerFile(
      dir,
      [
        "server:",
        "  host: sftp.example.org",
        `  host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        "remotes: {}",
        "",
      ].join("\n"),
    );
    expect(() =>
      loadSftpServer(filePath, path.join(dir, "data-root")),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("remotes") as string,
      }) as Error,
    );
  });

  test("a server key mapping to a non-mapping is rejected", () => {
    const dir = scratchDir();
    const filePath = writeServerFile(dir, "server: not-a-mapping\n");
    expect(() => loadSftpServer(filePath, path.join(dir, "data-root"))).toThrow(
      JobApiConfigError,
    );
  });

  test("unparseable YAML is a config error that never echoes the source", () => {
    const dir = scratchDir();
    const filePath = writeServerFile(dir, "server: {inline-looking-secret: [");
    let caught: Error | null = null;
    try {
      loadSftpServer(filePath, path.join(dir, "data-root"));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).not.toContain("inline-looking-secret");
  });

  test("a missing server file is a config error", () => {
    const dir = scratchDir();
    expect(() =>
      loadSftpServer(
        path.join(dir, "no-such-file.yaml"),
        path.join(dir, "data-root"),
      ),
    ).toThrow(JobApiConfigError);
  });
});

describe("loadSftpServer runs core's cross-field refines at boot", () => {
  test("password and privateKey together are rejected", () => {
    const dir = scratchDir();
    const secretPath = writeSecretFile(dir);
    expect(() =>
      loadSingle([
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        `password: "@${secretPath}"`,
        `private_key: "@${secretPath}"`,
      ]),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining(
          "one primary authentication method",
        ) as string,
      }) as Error,
    );
  });

  test("keyboard_interactive without password is rejected", () => {
    expect(() =>
      loadSingle([
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        "keyboard_interactive: true",
      ]),
    ).toThrow(JobApiConfigError);
  });
});

describe("loadSftpServerFromEnv startup posture", () => {
  test("unset JOB_SFTP_SERVER loads no server", () => {
    expect(loadSftpServerFromEnv({})).toBeUndefined();
    expect(
      loadSftpServerFromEnv({ [JOB_SFTP_SERVER_ENV]: "  " }),
    ).toBeUndefined();
  });

  test("JOB_SFTP_SERVER without JOB_DATA_ROOT is a config error", () => {
    expect(() =>
      loadSftpServerFromEnv({ [JOB_SFTP_SERVER_ENV]: "/etc/sftp-server.yaml" }),
    ).toThrow(JobApiConfigError);
  });

  test("the superseded JOB_SFTP_REMOTES variable refuses the boot with a migration message", () => {
    let caught: Error | null = null;
    try {
      loadSftpServerFromEnv({
        [LEGACY_JOB_SFTP_REMOTES_ENV]: "/etc/remotes.yaml",
        JOB_DATA_ROOT: "/srv/data",
      });
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    // The message names the new variable and the single-server shape so an
    // operator migrating a table knows what to set instead.
    expect(caught?.message).toContain(LEGACY_JOB_SFTP_REMOTES_ENV);
    expect(caught?.message).toContain(JOB_SFTP_SERVER_ENV);
    expect(caught?.message).toContain("server");
  });

  test("an invalid server file fails the load, not just the first request", () => {
    const dir = scratchDir();
    const filePath = writeServerFile(
      dir,
      serverYaml(["host: sftp.example.org"]),
    );
    expect(() =>
      loadSftpServerFromEnv({
        [JOB_SFTP_SERVER_ENV]: filePath,
        JOB_DATA_ROOT: path.join(dir, "data-root"),
      }),
    ).toThrow(JobApiConfigError);
  });

  test("a valid file loads through the env reader", () => {
    const dir = scratchDir();
    const filePath = writeServerFile(
      dir,
      serverYaml([
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
      ]),
    );
    const entry = loadSftpServerFromEnv({
      [JOB_SFTP_SERVER_ENV]: filePath,
      JOB_DATA_ROOT: path.join(dir, "data-root"),
    });
    expect(entry?.host).toBe("sftp.example.org");
  });
});

describe("useSftpServer (the call the server entry makes at boot)", () => {
  afterEach(() => {
    (globalThis as { jobSftpServer?: unknown }).jobSftpServer = undefined;
  });

  test("propagates the config error so a bad server file refuses the boot", () => {
    expect(() =>
      useSftpServer({ [JOB_SFTP_SERVER_ENV]: "/etc/sftp-server.yaml" }),
    ).toThrow(JobApiConfigError);
  });

  test("memoizes the loaded entry for the lazy manager construction", () => {
    const dir = scratchDir();
    const filePath = writeServerFile(
      dir,
      serverYaml([
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
      ]),
    );
    const env = {
      [JOB_SFTP_SERVER_ENV]: filePath,
      JOB_DATA_ROOT: path.join(dir, "data-root"),
    };
    const first = useSftpServer(env);
    expect(first?.host).toBe("sftp.example.org");
    expect(useSftpServer(env)).toBe(first);
  });
});
