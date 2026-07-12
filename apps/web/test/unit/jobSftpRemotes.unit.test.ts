import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  JOB_SFTP_REMOTES_ENV,
  SFTP_REMOTE_NAME_REGEX,
  loadSftpRemotesFromEnv,
  loadSftpRemotesTable,
} from "@jobs/sftpRemotes";
import { JobApiConfigError } from "@jobs/gate";
import { useSftpRemotesTable } from "@jobs/index";

import { TEST_HOST_KEY_FINGERPRINT, tempDataRoot } from "../utils/jobFixtures";

// The loader is the boot-time gate between an operator's remotes file and the
// connection block the appliance later composes into CLI configs. These pin its
// strictness: only the allowlisted fields, only @path credentials outside the
// data root, only literal canonical fingerprints, names kept verbatim.

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A scratch directory holding the remotes file and any referenced secrets. */
function scratchDir(): string {
  const dir = tempDataRoot("remotes");
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

/** Write a remotes YAML document to disk, returning its path. */
function writeRemotesFile(dir: string, content: string): string {
  const filePath = path.join(dir, "remotes.yaml");
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** Write a secret file the @path references can point at, returning its path. */
function writeSecretFile(dir: string): string {
  const filePath = path.join(dir, "server-password");
  fs.writeFileSync(filePath, "not-read-by-the-loader\n");
  return filePath;
}

/** Compose a remotes document with one named entry from YAML body lines. */
function remotesYaml(name: string, entryLines: Array<string>): string {
  return [
    "remotes:",
    `  ${name}:`,
    ...entryLines.map((line) => `    ${line}`),
    "",
  ].join("\n");
}

function loadSingle(
  entryLines: Array<string>,
  options?: {
    name?: string;
    dataRoot?: string;
  },
) {
  const dir = scratchDir();
  const dataRoot = options?.dataRoot ?? path.join(dir, "data-root");
  const filePath = writeRemotesFile(
    dir,
    remotesYaml(options?.name ?? "prod_east", entryLines),
  );
  return loadSftpRemotesTable(filePath, dataRoot);
}

describe("loadSftpRemotesTable happy path", () => {
  test("loads a full entry, camelizing fields but never the name", () => {
    const dir = scratchDir();
    const secretPath = writeSecretFile(dir);
    const dataRoot = path.join(dir, "data-root");
    const filePath = writeRemotesFile(
      dir,
      remotesYaml("prod_east", [
        "host: sftp.example.org",
        "port: 2222",
        "username: linkage",
        "path: /exchange",
        `password: "@${secretPath}"`,
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        "keyboard_interactive: true",
      ]),
    );

    const table = loadSftpRemotesTable(filePath, dataRoot);
    expect([...table.keys()]).toEqual(["prod_east"]);
    const entry = table.get("prod_east")!;
    expect(entry.host).toBe("sftp.example.org");
    expect(entry.port).toBe(2222);
    expect(entry.username).toBe("linkage");
    expect(entry.path).toBe("/exchange");
    expect(entry.password).toBe(`@${secretPath}`);
    expect(entry.hostKeyFingerprint).toBe(TEST_HOST_KEY_FINGERPRINT);
    expect(entry.keyboardInteractive).toBe(true);
  });

  test("a snake_case name is retrievable verbatim and nothing else", () => {
    const table = loadSingle([
      "host: sftp.example.org",
      `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
    ]);
    expect(table.get("prod_east")).toBeDefined();
    expect(table.get("prodEast")).toBeUndefined();
    expect(table.get("PROD_EAST")).toBeUndefined();
  });

  test("an empty remotes mapping loads as an empty table", () => {
    const dir = scratchDir();
    const filePath = writeRemotesFile(dir, "remotes: {}\n");
    const table = loadSftpRemotesTable(filePath, path.join(dir, "data-root"));
    expect(table.size).toBe(0);
  });
});

describe("loadSftpRemotesTable rejects unknown and disallowed keys", () => {
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

describe("loadSftpRemotesTable credential reference rules", () => {
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
    expect(caught?.message).toContain("remotes.prod_east.password");
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
    const table = loadSingle(
      [
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        `password: "@${secretPath}"`,
      ],
      { dataRoot },
    );
    expect(table.get("prod_east")?.password).toBe(`@${secretPath}`);
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
    expect(caught?.message).toContain("remotes.prod_east.password");
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
          "remotes.prod_east.privateKeyPassphrase",
        ) as string,
      }) as Error,
    );
  });
});

describe("loadSftpRemotesTable fingerprint rules", () => {
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

describe("loadSftpRemotesTable name and document shape rules", () => {
  test("a name outside the charset is rejected", () => {
    for (const name of ["-leading-dash", "has space", "a/b"]) {
      const dir = scratchDir();
      const filePath = writeRemotesFile(
        dir,
        remotesYaml(JSON.stringify(name), [
          "host: sftp.example.org",
          `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        ]),
      );
      expect(() =>
        loadSftpRemotesTable(filePath, path.join(dir, "data-root")),
      ).toThrow(JobApiConfigError);
      expect(SFTP_REMOTE_NAME_REGEX.test(name)).toBe(false);
    }
  });

  test("a name longer than 64 characters is rejected", () => {
    expect(() =>
      loadSingle(
        [
          "host: sftp.example.org",
          `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
        ],
        { name: "a".repeat(65) },
      ),
    ).toThrow(JobApiConfigError);
  });

  test("a document without the remotes key is rejected", () => {
    const dir = scratchDir();
    const filePath = writeRemotesFile(dir, "servers: {}\n");
    expect(() =>
      loadSftpRemotesTable(filePath, path.join(dir, "data-root")),
    ).toThrow(JobApiConfigError);
  });

  test("unparseable YAML is a config error that never echoes the source", () => {
    const dir = scratchDir();
    const filePath = writeRemotesFile(
      dir,
      "remotes: {inline-looking-secret: [",
    );
    let caught: Error | null = null;
    try {
      loadSftpRemotesTable(filePath, path.join(dir, "data-root"));
    } catch (error) {
      caught = error as Error;
    }
    expect(caught).toBeInstanceOf(JobApiConfigError);
    expect(caught?.message).not.toContain("inline-looking-secret");
  });

  test("a missing remotes file is a config error", () => {
    const dir = scratchDir();
    expect(() =>
      loadSftpRemotesTable(
        path.join(dir, "no-such-file.yaml"),
        path.join(dir, "data-root"),
      ),
    ).toThrow(JobApiConfigError);
  });
});

describe("loadSftpRemotesTable runs core's cross-field refines at boot", () => {
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

describe("loadSftpRemotesFromEnv startup posture", () => {
  test("unset JOB_SFTP_REMOTES loads no table", () => {
    expect(loadSftpRemotesFromEnv({})).toBeUndefined();
    expect(
      loadSftpRemotesFromEnv({ [JOB_SFTP_REMOTES_ENV]: "  " }),
    ).toBeUndefined();
  });

  test("JOB_SFTP_REMOTES without JOB_DATA_ROOT is a config error", () => {
    expect(() =>
      loadSftpRemotesFromEnv({ [JOB_SFTP_REMOTES_ENV]: "/etc/remotes.yaml" }),
    ).toThrow(JobApiConfigError);
  });

  test("an invalid remotes file fails the load, not just the first request", () => {
    const dir = scratchDir();
    const filePath = writeRemotesFile(
      dir,
      remotesYaml("prod_east", ["host: sftp.example.org"]),
    );
    expect(() =>
      loadSftpRemotesFromEnv({
        [JOB_SFTP_REMOTES_ENV]: filePath,
        JOB_DATA_ROOT: path.join(dir, "data-root"),
      }),
    ).toThrow(JobApiConfigError);
  });

  test("a valid file loads through the env reader", () => {
    const dir = scratchDir();
    const filePath = writeRemotesFile(
      dir,
      remotesYaml("prod_east", [
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
      ]),
    );
    const table = loadSftpRemotesFromEnv({
      [JOB_SFTP_REMOTES_ENV]: filePath,
      JOB_DATA_ROOT: path.join(dir, "data-root"),
    });
    expect(table?.get("prod_east")?.host).toBe("sftp.example.org");
  });
});

describe("useSftpRemotesTable (the call the server entry makes at boot)", () => {
  afterEach(() => {
    (globalThis as { jobSftpRemotesTable?: unknown }).jobSftpRemotesTable =
      undefined;
  });

  test("propagates the config error so a bad table refuses the boot", () => {
    expect(() =>
      useSftpRemotesTable({ [JOB_SFTP_REMOTES_ENV]: "/etc/remotes.yaml" }),
    ).toThrow(JobApiConfigError);
  });

  test("memoizes the loaded table for the lazy manager construction", () => {
    const dir = scratchDir();
    const filePath = writeRemotesFile(
      dir,
      remotesYaml("prod_east", [
        "host: sftp.example.org",
        `host_key_fingerprint: ${TEST_HOST_KEY_FINGERPRINT}`,
      ]),
    );
    const env = {
      [JOB_SFTP_REMOTES_ENV]: filePath,
      JOB_DATA_ROOT: path.join(dir, "data-root"),
    };
    const first = useSftpRemotesTable(env);
    expect(first?.get("prod_east")).toBeDefined();
    expect(useSftpRemotesTable(env)).toBe(first);
  });
});
