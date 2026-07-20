import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  JOB_SFTP_SERVER_ENV,
  LEGACY_JOB_SFTP_REMOTES_ENV,
  loadSftpServer,
  loadSftpServerFromEnv,
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
  },
) {
  const dir = scratchDir();
  const dataRoot = options?.dataRoot ?? path.join(dir, "data-root");
  const filePath = writeServerFile(dir, serverYaml(entryLines));
  return loadSftpServer(filePath, dataRoot);
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
    expect(() =>
      loadSingle(
        [
          "host: sftp.example.org",
          `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
          `password: "@${path.join(dataRoot, "planted", "pw")}"`,
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
