import fs from "node:fs";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { JOB_FILE_MODE, WORKDIR_MODE } from "@jobs/workdir";
import {
  JOB_SFTP_CREDENTIAL_DIR_ENV,
  SFTP_CREDENTIAL_SCRATCH_DIR,
  materializeSftpCredential,
  removeSftpCredentialFile,
  resolveSftpCredentialScratchDir,
  setupSftpCredentialScratchDir,
} from "@jobs/sftpScratch";
import { JobApiConfigError } from "@jobs/gate";
import { bootSftpCredentialScratchDir } from "@jobs/index";
import { useJobRendezvousProvisioning } from "@jobs/jobRendezvous";

import { tempDataRoot } from "../../utils/jobFixtures";

// The pasted-credential scratch directory is the ONLY at-rest home a pasted SFTP
// credential ever has: a server-owned 0600 file at a container-internal path that
// is outside the data root and rendezvous mount, swept at boot, and delivered to
// the CLI only as an @path. These pin its containment, modes, and sweep.

const dirs: Array<string> = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

/** A created scratch/data/rendezvous sandbox, registered for cleanup. */
function sandbox(label: string): string {
  const dir = tempDataRoot(label);
  fs.mkdirSync(dir, { recursive: true });
  dirs.push(dir);
  return dir;
}

describe("setupSftpCredentialScratchDir containment", () => {
  test("creates the scratch dir owner-only outside the data root", () => {
    const base = sandbox("scratch-ok");
    const scratchDir = path.join(base, "scratch");
    const dataRoot = path.join(base, "data-root");
    const resolved = setupSftpCredentialScratchDir(scratchDir, dataRoot, []);
    expect(resolved).toBe(path.resolve(scratchDir));
    expect(fs.statSync(resolved).mode & 0o777).toBe(WORKDIR_MODE);
  });

  test("refuses to boot when the scratch dir is inside the data root", () => {
    const base = sandbox("scratch-in-root");
    const dataRoot = path.join(base, "data-root");
    fs.mkdirSync(dataRoot, { recursive: true });
    const scratchDir = path.join(dataRoot, "sftp-credentials");
    expect(() =>
      setupSftpCredentialScratchDir(scratchDir, dataRoot, []),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("data root") as string,
      }) as Error,
    );
  });

  test("refuses to boot when the data root is inside the scratch dir", () => {
    // Sweeping the scratch dir would delete the data root: reject either nesting.
    const base = sandbox("root-in-scratch");
    const scratchDir = path.join(base, "scratch");
    const dataRoot = path.join(scratchDir, "data-root");
    expect(() =>
      setupSftpCredentialScratchDir(scratchDir, dataRoot, []),
    ).toThrow(JobApiConfigError);
  });

  test("refuses to boot when the scratch dir is inside the rendezvous dir", () => {
    const base = sandbox("scratch-in-rvz");
    const dataRoot = path.join(base, "data-root");
    const rendezvousDir = path.join(base, "rendezvous");
    fs.mkdirSync(rendezvousDir, { recursive: true });
    const scratchDir = path.join(rendezvousDir, "sftp-credentials");
    expect(() =>
      setupSftpCredentialScratchDir(scratchDir, dataRoot, [rendezvousDir]),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("rendezvous") as string,
      }) as Error,
    );
  });

  test("refuses to boot when the scratch dir is inside the OUTBOUND leg", () => {
    // The second leg of a split rendezvous is a partner-synced folder exactly as
    // the first is, so a scratch dir nested in it would expose every pasted
    // credential through the sync -- refused at boot, not warned about.
    const base = sandbox("scratch-in-outbound");
    const dataRoot = path.join(base, "data-root");
    const inbound = path.join(base, "from-partner");
    const outbound = path.join(base, "to-partner");
    fs.mkdirSync(outbound, { recursive: true });
    const scratchDir = path.join(outbound, "sftp-credentials");
    expect(() =>
      setupSftpCredentialScratchDir(scratchDir, dataRoot, [inbound, outbound]),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("rendezvous") as string,
      }) as Error,
    );
  });

  test("refuses a scratch dir a symlink resolves back into the data root", () => {
    const base = sandbox("scratch-symlink");
    const dataRoot = path.join(base, "data-root");
    fs.mkdirSync(path.join(dataRoot, "inside"), { recursive: true });
    // scratch is lexically outside, but a symlink resolves it into the data root.
    const scratchDir = path.join(base, "scratch-link");
    fs.symlinkSync(path.join(dataRoot, "inside"), scratchDir);
    expect(() =>
      setupSftpCredentialScratchDir(scratchDir, dataRoot, []),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("data root") as string,
      }) as Error,
    );
  });

  test("refuses a symlinked scratch before re-moding or filling the data root", () => {
    const base = sandbox("scratch-symlink-noop");
    const dataRoot = path.join(base, "data-root");
    const inside = path.join(dataRoot, "inside");
    fs.mkdirSync(inside, { recursive: true });
    // A mode distinct from WORKDIR_MODE, so a stray chmod-through-symlink shows.
    fs.chmodSync(inside, 0o755);
    const scratchDir = path.join(base, "scratch-link");
    fs.symlinkSync(inside, scratchDir);
    expect(() =>
      setupSftpCredentialScratchDir(scratchDir, dataRoot, []),
    ).toThrow(JobApiConfigError);
    // The realpath check ran before any side effect: the target keeps its mode
    // and nothing was created inside it.
    expect(fs.statSync(inside).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(inside)).toEqual([]);
  });

  test("re-asserts containment before the sweep when a symlink is swapped in", () => {
    // A symlink swapped into the scratch path AFTER the pre-creation asserts but
    // BEFORE the destructive sweep must be caught by the post-mkdir re-assert, so
    // the sweep never recurses through the link into the data root and deletes it.
    const base = sandbox("scratch-swap-before-sweep");
    const dataRoot = path.join(base, "data-root");
    const inside = path.join(dataRoot, "inside");
    fs.mkdirSync(inside, { recursive: true });
    const survivor = path.join(inside, "operator-file");
    fs.writeFileSync(survivor, "do-not-delete\n");
    // A mode distinct from WORKDIR_MODE, so a stray chmod-through-symlink shows.
    fs.chmodSync(inside, 0o755);
    const scratchDir = path.join(base, "scratch");
    // Simulate the TOCTOU race: the chmod that follows mkdir is the injection
    // point, replacing the freshly created scratch dir with a symlink into the
    // data root before the sweep runs.
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementationOnce(() => {
      fs.rmSync(scratchDir, { recursive: true, force: true });
      fs.symlinkSync(inside, scratchDir);
    });
    try {
      expect(() =>
        setupSftpCredentialScratchDir(scratchDir, dataRoot, []),
      ).toThrowError(
        expect.objectContaining({
          name: "JobApiConfigError",
          message: expect.stringContaining("data root") as string,
        }) as Error,
      );
    } finally {
      chmodSpy.mockRestore();
    }
    // The re-assert refused before the sweep ran: the mount keeps its file and mode.
    expect(fs.readFileSync(survivor, "utf8")).toBe("do-not-delete\n");
    expect(fs.statSync(inside).mode & 0o777).toBe(0o755);
  });

  test("refuses to boot when the scratch dir equals the secrets mount", () => {
    const base = sandbox("scratch-eq-secrets");
    const dataRoot = path.join(base, "data-root");
    const secretsDir = path.join(base, "secrets");
    fs.mkdirSync(secretsDir, { recursive: true });
    expect(() =>
      setupSftpCredentialScratchDir(
        secretsDir,
        dataRoot,
        [],
        secretsDir,
        undefined,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("secrets") as string,
      }) as Error,
    );
  });

  test("refuses to boot when the scratch dir is a parent of the secrets mount", () => {
    const base = sandbox("scratch-parent-secrets");
    const dataRoot = path.join(base, "data-root");
    const scratchDir = path.join(base, "scratch");
    const secretsDir = path.join(scratchDir, "secrets");
    expect(() =>
      setupSftpCredentialScratchDir(
        scratchDir,
        dataRoot,
        [],
        secretsDir,
        undefined,
      ),
    ).toThrow(JobApiConfigError);
  });

  test("refuses to boot when the scratch dir is inside the work-input mount", () => {
    const base = sandbox("scratch-in-input");
    const dataRoot = path.join(base, "data-root");
    const inputDir = path.join(base, "input");
    fs.mkdirSync(inputDir, { recursive: true });
    const scratchDir = path.join(inputDir, "sftp-credentials");
    expect(() =>
      setupSftpCredentialScratchDir(
        scratchDir,
        dataRoot,
        [],
        undefined,
        inputDir,
      ),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("work-input") as string,
      }) as Error,
    );
  });

  test("refuses to boot when the scratch basename starts with .. inside the data root", () => {
    // A genuine child whose basename starts with ".." (relative "..creds") must
    // be treated as WITHIN the data root, not misclassified as an outside sibling.
    const base = sandbox("scratch-dotdot-child");
    const dataRoot = path.join(base, "data-root");
    fs.mkdirSync(dataRoot, { recursive: true });
    const scratchDir = path.join(dataRoot, "..creds");
    expect(() =>
      setupSftpCredentialScratchDir(scratchDir, dataRoot, []),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("data root") as string,
      }) as Error,
    );
  });
});

describe("setupSftpCredentialScratchDir refusal", () => {
  test("names the override, the path and the errno when the create fails", () => {
    // The shape a console boots into when it runs as an account other than
    // the one the image built the default directory for: the default sits under
    // root-owned /run and cannot be created, every operator mount is excluded,
    // and the path and errno alone leave the operator with nowhere to point it.
    const base = sandbox("scratch-create-refused");
    const scratchDir = path.join(base, "scratch");
    const dataRoot = path.join(base, "data-root");
    const mkdirSpy = vi.spyOn(fs, "mkdirSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    });
    let refusal: unknown;
    try {
      expect(() => {
        try {
          setupSftpCredentialScratchDir(scratchDir, dataRoot, []);
        } catch (error) {
          refusal = error;
          throw error;
        }
      }).toThrow(JobApiConfigError);
    } finally {
      mkdirSpy.mockRestore();
    }
    const message = (refusal as Error).message;
    expect(message).toContain(JOB_SFTP_CREDENTIAL_DIR_ENV);
    expect(message).toContain(path.resolve(scratchDir));
    expect(message).toContain("EACCES");
  });
});

describe("setupSftpCredentialScratchDir sweep", () => {
  test("wipes a credential a prior run orphaned", () => {
    const base = sandbox("scratch-sweep");
    const scratchDir = path.join(base, "scratch");
    fs.mkdirSync(scratchDir, { recursive: true });
    const orphan = path.join(scratchDir, "orphaned-secret");
    fs.writeFileSync(orphan, "left-over-password\n");
    setupSftpCredentialScratchDir(scratchDir, path.join(base, "data-root"), []);
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.readdirSync(scratchDir)).toEqual([]);
  });
});

describe("materializeSftpCredential", () => {
  test("writes the value to a 0600 file with a server-generated name", () => {
    const scratchDir = sandbox("materialize");
    const filePath = materializeSftpCredential(
      scratchDir,
      "hunter2-the-secret",
    );
    expect(path.dirname(filePath)).toBe(scratchDir);
    // A server-generated name, not derived from any submitted value.
    expect(path.basename(filePath)).not.toContain("hunter2");
    expect(fs.statSync(filePath).mode & 0o777).toBe(JOB_FILE_MODE);
    expect(fs.readFileSync(filePath, "utf8")).toBe("hunter2-the-secret");
  });

  test("each call writes a distinct file", () => {
    const scratchDir = sandbox("materialize-distinct");
    const first = materializeSftpCredential(scratchDir, "a");
    const second = materializeSftpCredential(scratchDir, "b");
    expect(first).not.toBe(second);
    expect(fs.readdirSync(scratchDir)).toHaveLength(2);
  });

  test("removes the file and rethrows when chmod fails after the write", () => {
    const scratchDir = sandbox("materialize-fail");
    const chmodSpy = vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw new Error("chmod refused");
    });
    try {
      expect(() =>
        materializeSftpCredential(scratchDir, "unwritable-secret"),
      ).toThrow("chmod refused");
    } finally {
      chmodSpy.mockRestore();
    }
    // The partial file was cleaned up: a post-create failure leaves nothing at rest.
    expect(fs.readdirSync(scratchDir)).toEqual([]);
  });
});

describe("removeSftpCredentialFile", () => {
  test("deletes a materialized file and is idempotent", () => {
    const scratchDir = sandbox("remove");
    const filePath = materializeSftpCredential(scratchDir, "secret");
    removeSftpCredentialFile(filePath);
    expect(fs.existsSync(filePath)).toBe(false);
    // A second removal of a now-missing file does not throw.
    expect(() => removeSftpCredentialFile(filePath)).not.toThrow();
  });
});

describe("resolveSftpCredentialScratchDir", () => {
  test("defaults to the fixed container-internal path", () => {
    expect(resolveSftpCredentialScratchDir({})).toBe(
      SFTP_CREDENTIAL_SCRATCH_DIR,
    );
    expect(
      resolveSftpCredentialScratchDir({ [JOB_SFTP_CREDENTIAL_DIR_ENV]: "  " }),
    ).toBe(SFTP_CREDENTIAL_SCRATCH_DIR);
  });

  test("honors a server-side override", () => {
    expect(
      resolveSftpCredentialScratchDir({
        [JOB_SFTP_CREDENTIAL_DIR_ENV]: "/mnt/tmpfs/creds",
      }),
    ).toBe("/mnt/tmpfs/creds");
  });
});

describe("bootSftpCredentialScratchDir", () => {
  afterEach(() => {
    const globals = globalThis as {
      jobSftpCredentialScratchDir?: unknown;
      jobSecretsDirConfig?: unknown;
      jobInputDirConfig?: unknown;
      jobRendezvousProvisioning?: unknown;
    };
    // The scratch memo and the secrets, input, and rendezvous memos are read once
    // per boot; clear all four so each test re-reads its own env.
    globals.jobSftpCredentialScratchDir = undefined;
    globals.jobSecretsDirConfig = undefined;
    globals.jobInputDirConfig = undefined;
    globals.jobRendezvousProvisioning = undefined;
  });

  test("is a no-op when the job API is disabled (no directory prepared)", () => {
    // No console profile: the API is disabled, so nothing is created or asserted.
    bootSftpCredentialScratchDir({ JOB_DATA_ROOT: "/srv/data" });
    expect(
      (globalThis as { jobSftpCredentialScratchDir?: unknown })
        .jobSftpCredentialScratchDir,
    ).toBeUndefined();
  });

  test("prepares and memoizes the override directory when enabled", () => {
    const base = sandbox("boot");
    const scratch = path.join(base, "scratch");
    const dataRoot = path.join(base, "data-root");
    const orphan = path.join(scratch, "left-over");
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(orphan, "stale-secret\n");
    bootSftpCredentialScratchDir({
      VITE_DEPLOYMENT_PROFILE: "console",
      JOB_DATA_ROOT: dataRoot,
      [JOB_SFTP_CREDENTIAL_DIR_ENV]: scratch,
    });
    expect(
      (globalThis as { jobSftpCredentialScratchDir?: unknown })
        .jobSftpCredentialScratchDir,
    ).toBe(path.resolve(scratch));
    // Boot swept the orphaned credential.
    expect(fs.existsSync(orphan)).toBe(false);
  });

  test("refuses the boot when the override resolves inside the data root", () => {
    const base = sandbox("boot-refuse");
    const dataRoot = path.join(base, "data-root");
    fs.mkdirSync(dataRoot, { recursive: true });
    expect(() =>
      bootSftpCredentialScratchDir({
        VITE_DEPLOYMENT_PROFILE: "console",
        JOB_DATA_ROOT: dataRoot,
        [JOB_SFTP_CREDENTIAL_DIR_ENV]: path.join(dataRoot, "creds"),
      }),
    ).toThrow(JobApiConfigError);
  });

  test("resolves the rendezvous mounts through the memoized entry", () => {
    // Each leg's real path is read where the provisioning is resolved, so a boot
    // that resolved it a second time would walk a split console's mounts twice.
    // The memo the boot leaves is what the warning log and the manager then read.
    const base = sandbox("boot-memo");
    const scratch = path.join(base, "scratch");
    const dataRoot = path.join(base, "data-root");
    const inbound = path.join(base, "from-partner");
    const outbound = path.join(base, "to-partner");
    fs.mkdirSync(inbound, { recursive: true });
    fs.mkdirSync(outbound, { recursive: true });
    bootSftpCredentialScratchDir({
      VITE_DEPLOYMENT_PROFILE: "console",
      JOB_DATA_ROOT: dataRoot,
      JOB_RENDEZVOUS_DIR: inbound,
      JOB_RENDEZVOUS_OUTBOUND_DIR: outbound,
      [JOB_SFTP_CREDENTIAL_DIR_ENV]: scratch,
    });
    // Read back through an EMPTY environment: what comes out is the boot's own
    // resolution, so nothing after the boot resolves the mounts again.
    expect(useJobRendezvousProvisioning({})).toEqual({
      dir: path.resolve(inbound),
      outboundDir: path.resolve(outbound),
      folderName: path.basename(inbound),
      outboundFolderName: path.basename(outbound),
      locator: path.basename(inbound),
      outboundLocator: path.basename(outbound),
    });
  });

  test("refuses the boot when a rendezvous leg contains the scratch dir", () => {
    // The exclusion set the boot asserts is drawn from that same provisioning, so
    // a scratch dir inside the OUTBOUND leg of a split refuses exactly as one
    // inside the data root does.
    const base = sandbox("boot-outbound");
    const dataRoot = path.join(base, "data-root");
    const inbound = path.join(base, "from-partner");
    const outbound = path.join(base, "to-partner");
    fs.mkdirSync(inbound, { recursive: true });
    fs.mkdirSync(outbound, { recursive: true });
    expect(() =>
      bootSftpCredentialScratchDir({
        VITE_DEPLOYMENT_PROFILE: "console",
        JOB_DATA_ROOT: dataRoot,
        JOB_RENDEZVOUS_DIR: inbound,
        JOB_RENDEZVOUS_OUTBOUND_DIR: outbound,
        [JOB_SFTP_CREDENTIAL_DIR_ENV]: path.join(outbound, "creds"),
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("rendezvous") as string,
      }) as Error,
    );
  });

  test("refuses the boot when the override coincides with the secrets mount", () => {
    // JOB_SECRETS_DIR is threaded into the boot exclusion set: a scratch dir that
    // equals the secrets mount refuses, so the sweep can never delete the operator's
    // credential files.
    const base = sandbox("boot-secrets");
    const dataRoot = path.join(base, "data-root");
    const secrets = path.join(base, "secrets");
    fs.mkdirSync(secrets, { recursive: true });
    expect(() =>
      bootSftpCredentialScratchDir({
        VITE_DEPLOYMENT_PROFILE: "console",
        JOB_DATA_ROOT: dataRoot,
        JOB_SECRETS_DIR: secrets,
        [JOB_SFTP_CREDENTIAL_DIR_ENV]: secrets,
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "JobApiConfigError",
        message: expect.stringContaining("secrets") as string,
      }) as Error,
    );
  });
});
