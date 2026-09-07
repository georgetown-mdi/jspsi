import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { JobManager, JobSigningIdentityExposedError } from "@jobs/jobManager";
import {
  SIGNING_CERTIFICATE_FILE_NAME,
  SIGNING_IDENTITY_FILE_NAME,
  SigningIdentityLocationError,
  resolveSigningIdentityPath,
} from "@jobs/signingIdentity";
import { JOB_FILE_NAMES } from "@jobs/intentSchemas";

import { Route as FingerprintRoute } from "../../../src/routes/api/jobs/signing/fingerprint";
import { Route as JobsRoute } from "../../../src/routes/api/jobs/index";

import {
  STUB_CLI_PATH,
  TEST_HOST_KEY_FINGERPRINT,
  tempDataRoot,
  validIntent,
  validSftpIntent,
} from "../../utils/jobFixtures";

import type { JobCreateIntent } from "@jobs/intentSchemas";

// The signing identity's LOCATION as a console option: what the operator's
// picked mount locator resolves to, which directory the two refusals compare
// against once it is not the data root, and the one rule that makes a read-only
// secrets mount usable -- the console writes nothing into it, on any path.
//
// The default location's own behaviour is unchanged and asserted in
// jobManager.unit.test.ts and consoleReceipts.unit.test.ts; what is here is
// what the option adds.

/** The fingerprint the stub CLI prints (43 base64url characters). */
const OWN_FINGERPRINT = "B".repeat(42) + "A";

/** A canonical partner fingerprint to pin, as certificate mode requires. */
const PARTNER_FINGERPRINT = "C".repeat(42) + "A";

/** The identity file name an operator keeps in a mount of their own. */
const PICKED_IDENTITY_NAME = "psilink-signing-identity.json";

const roots: Array<string> = [];
const managers: Array<JobManager> = [];
/** Directories chmod-ed read-only, restored before removal so cleanup works. */
const lockedDirs: Array<string> = [];

beforeEach(() => {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of lockedDirs.splice(0))
    try {
      fs.chmodSync(dir, 0o700);
    } catch {
      // Already gone: the removal below is the only thing that needed the mode.
    }
  for (const manager of managers.splice(0)) manager.shutdown();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
  (globalThis as { jobManagerInstance?: unknown }).jobManagerInstance =
    undefined;
});

/** A created directory registered for cleanup. */
function directory(label: string): string {
  const dir = tempDataRoot(label);
  roots.push(dir);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Put a signing identity document at a path. Only its presence and its
 * loadability by the stub CLI matter here, so these bytes stand in for the
 * document the real command writes. */
function writeIdentity(filePath: string): void {
  fs.writeFileSync(filePath, "{}\n", "utf8");
}

/** Make a directory read-only (owner may still read and traverse), registered so
 * the cleanup can restore it. */
function makeReadOnly(dir: string): void {
  fs.chmodSync(dir, 0o500);
  lockedDirs.push(dir);
}

/** Whether an already-read-only directory refuses this process a write. Root
 * ignores the mode, so a test resting on the refusal states what it found
 * rather than passing vacuously. */
function refusesWrites(dir: string): boolean {
  const probe = path.join(dir, ".write-probe");
  try {
    fs.writeFileSync(probe, "");
  } catch {
    return true;
  }
  fs.rmSync(probe, { force: true });
  return false;
}

/** Every path under a directory, sorted, as the "nothing was written" witness. */
function treeOf(dir: string): Array<string> {
  return fs
    .readdirSync(dir, { recursive: true, encoding: "utf8" })
    .map((entry) => String(entry))
    .sort();
}

function makeManager(options: {
  dataRoot: string;
  jobSecretsDir?: string;
  jobRendezvousDir?: string;
  delayMs?: number;
}): JobManager {
  const manager = new JobManager({
    dataRoot: options.dataRoot,
    binaryPath: STUB_CLI_PATH,
    childEnv: {
      STUB_FD3_EVENTS: "[]",
      STUB_FINGERPRINT_STDOUT: `${OWN_FINGERPRINT}\n`,
      ...(options.delayMs !== undefined
        ? { STUB_DELAY_MS: String(options.delayMs) }
        : {}),
    },
    jobRendezvousDir: options.jobRendezvousDir ?? options.dataRoot,
    ...(options.jobSecretsDir !== undefined
      ? { jobSecretsDir: options.jobSecretsDir }
      : {}),
  });
  managers.push(manager);
  return manager;
}

/** The `signing` block of a job's composed psilink.yaml. */
function composedSigning(workdir: string): Record<string, unknown> {
  const text = fs.readFileSync(
    path.join(workdir, JOB_FILE_NAMES.config),
    "utf8",
  );
  const parsed = parseYaml(text) as { signing?: Record<string, unknown> };
  if (parsed.signing === undefined)
    throw new Error("composed psilink.yaml has no signing block");
  return parsed.signing;
}

/** A certificate-mode filedrop intent pointed at a picked location, or at the
 * console default when `subPath` is undefined. */
function signedIntent(subPath: Array<string> | undefined): JobCreateIntent {
  return validIntent({
    signing: {
      mode: "certificate",
      partnerFingerprint: PARTNER_FINGERPRINT,
      ...(subPath !== undefined
        ? { identityLocation: { mount: "secrets" as const, subPath } }
        : {}),
    },
  });
}

describe("resolveSigningIdentityPath", () => {
  test("an absent location is the console's default in the data root", () => {
    const root = directory("location-default");
    expect(
      resolveSigningIdentityPath({
        dataRoot: root,
        secretsDir: directory("location-default-secrets"),
        location: undefined,
      }),
    ).toBe(path.join(root, SIGNING_IDENTITY_FILE_NAME));
  });

  test("a picked location resolves under the secrets mount", () => {
    const root = directory("location-picked");
    const secrets = directory("location-picked-secrets");
    fs.mkdirSync(path.join(secrets, "signing"));
    expect(
      resolveSigningIdentityPath({
        dataRoot: root,
        secretsDir: secrets,
        location: {
          mount: "secrets",
          subPath: ["signing", PICKED_IDENTITY_NAME],
        },
      }),
    ).toBe(
      path.join(fs.realpathSync(secrets), "signing", PICKED_IDENTITY_NAME),
    );
  });

  test("a picked location resolves even where no file is there yet", () => {
    // The console reads a picked location rather than creating one, so
    // resolution cannot depend on the file existing: absence is an ANSWER, and
    // an answer needs the path resolved first.
    const secrets = directory("location-missing-secrets");
    expect(
      resolveSigningIdentityPath({
        dataRoot: directory("location-missing"),
        secretsDir: secrets,
        location: { mount: "secrets", subPath: [PICKED_IDENTITY_NAME] },
      }),
    ).toBe(path.join(fs.realpathSync(secrets), PICKED_IDENTITY_NAME));
  });

  test.each([
    {
      label: "a traversal segment",
      subPath: ["..", "escaped.json"],
    },
    {
      label: "a separator inside a segment",
      subPath: ["../escaped.json"],
    },
    {
      label: "a directory that is not there",
      subPath: ["missing-dir", PICKED_IDENTITY_NAME],
    },
  ])("$label does not resolve", ({ subPath }) => {
    expect(() =>
      resolveSigningIdentityPath({
        dataRoot: directory("location-escape"),
        secretsDir: directory("location-escape-secrets"),
        location: { mount: "secrets", subPath },
      }),
    ).toThrow(SigningIdentityLocationError);
  });

  test("a symlink out of the mount does not resolve", () => {
    const secrets = directory("location-symlink-secrets");
    const outside = directory("location-symlink-outside");
    writeIdentity(path.join(outside, PICKED_IDENTITY_NAME));
    fs.symlinkSync(outside, path.join(secrets, "away"));
    expect(() =>
      resolveSigningIdentityPath({
        dataRoot: directory("location-symlink"),
        secretsDir: secrets,
        location: { mount: "secrets", subPath: ["away", PICKED_IDENTITY_NAME] },
      }),
    ).toThrow(SigningIdentityLocationError);
  });

  test("a console with no secrets mount refuses a picked location", () => {
    expect(() =>
      resolveSigningIdentityPath({
        dataRoot: directory("location-unmounted"),
        secretsDir: undefined,
        location: { mount: "secrets", subPath: [PICKED_IDENTITY_NAME] },
      }),
    ).toThrow(SigningIdentityLocationError);
  });
});

describe("the job resolves the identity through the option", () => {
  test("a picked location is what the composed signing block names", async () => {
    const root = directory("job-picked");
    const secrets = directory("job-picked-secrets");
    writeIdentity(path.join(secrets, PICKED_IDENTITY_NAME));
    const manager = makeManager({
      dataRoot: root,
      jobSecretsDir: secrets,
      jobRendezvousDir: directory("job-picked-rvz"),
    });
    const id = await manager.createJob(signedIntent([PICKED_IDENTITY_NAME]));
    expect(composedSigning(path.join(root, id))).toMatchObject({
      identity_file: path.join(fs.realpathSync(secrets), PICKED_IDENTITY_NAME),
    });
  });

  test("no location keeps the data root's default in the composed block", async () => {
    const root = directory("job-default");
    writeIdentity(path.join(root, SIGNING_IDENTITY_FILE_NAME));
    const manager = makeManager({
      dataRoot: root,
      jobRendezvousDir: directory("job-default-rvz"),
    });
    const id = await manager.createJob(signedIntent(undefined));
    expect(composedSigning(path.join(root, id))).toMatchObject({
      identity_file: path.join(root, SIGNING_IDENTITY_FILE_NAME),
    });
  });

  test("a location naming nothing in the mount is refused before a workdir exists", async () => {
    const root = directory("job-unresolvable");
    const manager = makeManager({
      dataRoot: root,
      jobSecretsDir: directory("job-unresolvable-secrets"),
      jobRendezvousDir: directory("job-unresolvable-rvz"),
    });
    await expect(
      manager.createJob(signedIntent(["missing-dir", PICKED_IDENTITY_NAME])),
    ).rejects.toBeInstanceOf(SigningIdentityLocationError);
    expect(fs.readdirSync(root)).toEqual([]);
  });
});

describe("the file-sync refusal follows the configured identity", () => {
  test("a rendezvous leg holding the picked identity's folder refuses the run", async () => {
    // The comparison is against the directory the identity is IN, whichever
    // that is: pointing the option at a folder the partner syncs is the same
    // layout the default location's refusal is about.
    const root = directory("refusal-picked");
    const secrets = directory("refusal-picked-secrets");
    writeIdentity(path.join(secrets, PICKED_IDENTITY_NAME));
    const manager = makeManager({
      dataRoot: root,
      jobSecretsDir: secrets,
      jobRendezvousDir: secrets,
    });
    await expect(
      manager.createJob(signedIntent([PICKED_IDENTITY_NAME])),
    ).rejects.toBeInstanceOf(JobSigningIdentityExposedError);
  });

  test("a picked identity outside every leg admits the run the default would refuse", async () => {
    // The remedy the advisory names: the single-mount console still syncs the
    // data root, but the key is not in it.
    const root = directory("refusal-moved");
    const secrets = directory("refusal-moved-secrets");
    writeIdentity(path.join(secrets, PICKED_IDENTITY_NAME));
    const manager = makeManager({ dataRoot: root, jobSecretsDir: secrets });
    await expect(
      manager.createJob(signedIntent([PICKED_IDENTITY_NAME])),
    ).resolves.toEqual(expect.any(String));
  });

  test("a key left at the default path still refuses, whatever this run loads", async () => {
    // Moving the option does not move the file: a key the operator left in the
    // synced folder is a key the partner reads, and the run that syncs it is
    // the one refused.
    const root = directory("refusal-leftover");
    const secrets = directory("refusal-leftover-secrets");
    writeIdentity(path.join(secrets, PICKED_IDENTITY_NAME));
    writeIdentity(path.join(root, SIGNING_IDENTITY_FILE_NAME));
    const manager = makeManager({ dataRoot: root, jobSecretsDir: secrets });
    await expect(
      manager.createJob(signedIntent([PICKED_IDENTITY_NAME])),
    ).rejects.toBeInstanceOf(JobSigningIdentityExposedError);
  });

  test("an unsigned run over the same mounts is unaffected by the option", async () => {
    // A run that signs nothing loads no identity, so only the default path is
    // in question -- and with nothing there, nothing is published.
    const root = directory("refusal-unsigned");
    const manager = makeManager({ dataRoot: root });
    await expect(manager.createJob(validIntent())).resolves.toEqual(
      expect.any(String),
    );
  });
});

describe("a picked location is read, never created", () => {
  test("nothing at the picked path is reported absent, and no file appears", async () => {
    const root = directory("read-absent");
    const secrets = directory("read-absent-secrets");
    const manager = makeManager({ dataRoot: root, jobSecretsDir: secrets });
    await expect(
      manager.resolveSigningFingerprint({
        identityLabel: "Agency A",
        exportCertificate: false,
        identityLocation: { mount: "secrets", subPath: [PICKED_IDENTITY_NAME] },
      }),
    ).resolves.toEqual({ kind: "absent" });
    expect(treeOf(secrets)).toEqual([]);
    expect(treeOf(root)).toEqual([]);
  });

  test("an identity already there is read and its fingerprint returned", async () => {
    const root = directory("read-present");
    const secrets = directory("read-present-secrets");
    writeIdentity(path.join(secrets, PICKED_IDENTITY_NAME));
    const manager = makeManager({ dataRoot: root, jobSecretsDir: secrets });
    await expect(
      manager.resolveSigningFingerprint({
        identityLabel: "Agency A",
        exportCertificate: false,
        identityLocation: { mount: "secrets", subPath: [PICKED_IDENTITY_NAME] },
      }),
    ).resolves.toEqual({
      kind: "ok",
      fingerprint: OWN_FINGERPRINT,
      created: false,
      certificateExported: false,
    });
  });

  test("a live shared-folder run does not withhold a read of a picked identity", async () => {
    // The syncing answer is about a CREATE landing in a synced folder, and a
    // picked location is never created -- so the gate has nothing to hold.
    const root = directory("read-live-run");
    const secrets = directory("read-live-run-secrets");
    writeIdentity(path.join(secrets, PICKED_IDENTITY_NAME));
    const manager = makeManager({
      dataRoot: root,
      jobSecretsDir: secrets,
      delayMs: 800,
    });
    await manager.createJob(validIntent());
    await expect(
      manager.resolveSigningFingerprint({
        identityLabel: "Agency A",
        exportCertificate: false,
        identityLocation: { mount: "secrets", subPath: [PICKED_IDENTITY_NAME] },
      }),
    ).resolves.toMatchObject({ kind: "ok", created: false });
  });
});

describe("no console path writes into the secrets mount", () => {
  test("the fingerprint request, the export, and the run leave a read-only mount untouched", async () => {
    const root = directory("readonly-mount");
    const secrets = directory("readonly-mount-secrets");
    writeIdentity(path.join(secrets, PICKED_IDENTITY_NAME));
    const before = treeOf(secrets);
    makeReadOnly(secrets);
    // The mount's mode is the second witness, not the first: the assertions
    // below hold on the tree either way, and this states whether the mode was
    // in force for this run.
    const modeEnforced = refusesWrites(secrets);

    const manager = makeManager({
      dataRoot: root,
      jobSecretsDir: secrets,
      jobRendezvousDir: directory("readonly-mount-rvz"),
    });
    const location = {
      mount: "secrets" as const,
      subPath: [PICKED_IDENTITY_NAME],
    };

    // A fingerprint read, with and without the certificate export.
    await expect(
      manager.resolveSigningFingerprint({
        identityLabel: "Agency A",
        exportCertificate: false,
        identityLocation: location,
      }),
    ).resolves.toMatchObject({ kind: "ok", created: false });
    await expect(
      manager.resolveSigningFingerprint({
        identityLabel: "Agency A",
        exportCertificate: true,
        identityLocation: location,
      }),
    ).resolves.toMatchObject({ kind: "ok", certificateExported: true });

    // And a signed exchange loading the same identity.
    await manager.createJob(signedIntent([PICKED_IDENTITY_NAME]));

    expect(treeOf(secrets)).toEqual(before);
    expect(modeEnforced || process.getuid?.() === 0).toBe(true);
    // The export lands in the writable data root instead, never beside the key.
    expect(fs.existsSync(path.join(root, SIGNING_CERTIFICATE_FILE_NAME))).toBe(
      true,
    );
  });

  test("the identity file itself is not rewritten by a read", async () => {
    const root = directory("readonly-bytes");
    const secrets = directory("readonly-bytes-secrets");
    const identityPath = path.join(secrets, PICKED_IDENTITY_NAME);
    writeIdentity(identityPath);
    const before = fs.statSync(identityPath).mtimeMs;
    const manager = makeManager({ dataRoot: root, jobSecretsDir: secrets });
    await manager.resolveSigningFingerprint({
      identityLabel: "Agency A",
      exportCertificate: false,
      identityLocation: { mount: "secrets", subPath: [PICKED_IDENTITY_NAME] },
    });
    expect(fs.statSync(identityPath).mtimeMs).toBe(before);
  });
});

describe("the boundary shows no container path", () => {
  type Handlers = Record<
    string,
    (ctx: { request: Request; params: Record<string, string> }) => unknown
  >;

  function handlersOf(route: {
    options: { server?: { handlers?: unknown } };
  }): Handlers {
    const handlers = route.options.server?.handlers;
    if (typeof handlers !== "object" || handlers === null)
      throw new Error("route exposes no plain handlers object");
    return handlers as Handlers;
  }

  function jobRequest(url: string, body: unknown): Request {
    return new Request(url, {
      method: "POST",
      headers: { host: "localhost", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  /** Seed the global manager the routes read, pointed at the stub CLI. */
  function seed(options: {
    jobRendezvousDir?: string;
    identityIn?: "secrets" | "none";
  }): { root: string; secrets: string } {
    const root = directory("route-location");
    const secrets = directory("route-location-secrets");
    if (options.identityIn === "secrets")
      writeIdentity(path.join(secrets, PICKED_IDENTITY_NAME));
    vi.stubEnv("JOB_DATA_ROOT", root);
    vi.stubEnv("JOB_CLI_BINARY", STUB_CLI_PATH);
    const manager = makeManager({
      dataRoot: root,
      jobSecretsDir: secrets,
      ...(options.jobRendezvousDir !== undefined
        ? { jobRendezvousDir: options.jobRendezvousDir }
        : {}),
    });
    (globalThis as { jobManagerInstance?: JobManager }).jobManagerInstance =
      manager;
    return { root, secrets };
  }

  test("a resolved read answers with the picked file's name and no path", async () => {
    const { root, secrets } = seed({ identityIn: "secrets" });
    const response = (await handlersOf(FingerprintRoute).POST({
      request: jobRequest("http://localhost/api/jobs/signing/fingerprint", {
        identity: "Agency A",
        identityLocation: { mount: "secrets", subPath: [PICKED_IDENTITY_NAME] },
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      status: "ok",
      fingerprint: OWN_FINGERPRINT,
      created: false,
      identityFileName: PICKED_IDENTITY_NAME,
    });
    expect(text).not.toContain(secrets);
    expect(text).not.toContain(root);
  });

  test("an unresolvable location is a 400 naming the field and no path", async () => {
    const { root, secrets } = seed({ identityIn: "none" });
    const response = (await handlersOf(FingerprintRoute).POST({
      request: jobRequest("http://localhost/api/jobs/signing/fingerprint", {
        identity: "Agency A",
        identityLocation: {
          mount: "secrets",
          subPath: ["missing-dir", PICKED_IDENTITY_NAME],
        },
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("identityLocation");
    expect(text).not.toContain(secrets);
    expect(text).not.toContain(root);
    expect(text).not.toContain("missing-dir");
  });

  test("nothing at the picked path answers absent, with no other field", async () => {
    seed({ identityIn: "none" });
    const response = (await handlersOf(FingerprintRoute).POST({
      request: jobRequest("http://localhost/api/jobs/signing/fingerprint", {
        identity: "Agency A",
        identityLocation: { mount: "secrets", subPath: [PICKED_IDENTITY_NAME] },
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "absent" });
  });

  test("a job create with an unresolvable location is an empty-bodied 400", async () => {
    seed({
      identityIn: "none",
      jobRendezvousDir: directory("route-location-rvz"),
    });
    const response = (await handlersOf(JobsRoute).POST({
      request: jobRequest(
        "http://localhost/api/jobs",
        signedIntent(["missing-dir", PICKED_IDENTITY_NAME]),
      ),
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
    expect(await response.text()).toBe("");
  });

  test("an unmodeled path field beside the location is a 400", async () => {
    seed({ identityIn: "secrets" });
    const response = (await handlersOf(FingerprintRoute).POST({
      request: jobRequest("http://localhost/api/jobs/signing/fingerprint", {
        identity: "Agency A",
        identityFile: "/etc/shadow",
        identityLocation: { mount: "secrets", subPath: [PICKED_IDENTITY_NAME] },
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain("shadow");
  });

  test("an unknown mount id is a 400", async () => {
    seed({ identityIn: "secrets" });
    const response = (await handlersOf(FingerprintRoute).POST({
      request: jobRequest("http://localhost/api/jobs/signing/fingerprint", {
        identity: "Agency A",
        identityLocation: { mount: "data", subPath: [PICKED_IDENTITY_NAME] },
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(400);
  });
});

describe("the intent schema bounds the location", () => {
  test("an sftp run resolves the option the same way", async () => {
    const root = directory("sftp-location");
    const secrets = directory("sftp-location-secrets");
    writeIdentity(path.join(secrets, PICKED_IDENTITY_NAME));
    const manager = makeManager({ dataRoot: root, jobSecretsDir: secrets });
    const credentialDir = directory("sftp-location-cred");
    const credentialPath = path.join(credentialDir, "password");
    fs.writeFileSync(credentialPath, "s3cret\n");
    manager.authorSftpServer({
      host: "sftp.example.org",
      username: "linkage",
      path: "/exchange",
      hostKeyFingerprint: TEST_HOST_KEY_FINGERPRINT,
      credential: {
        kind: "ref",
        ref: `@${credentialPath}`,
        credType: "password",
      },
    });
    const id = await manager.createJob(
      validSftpIntent({
        signing: {
          mode: "certificate",
          partnerFingerprint: PARTNER_FINGERPRINT,
          identityLocation: {
            mount: "secrets",
            subPath: [PICKED_IDENTITY_NAME],
          },
        },
      }),
    );
    expect(composedSigning(path.join(root, id))).toMatchObject({
      identity_file: path.join(fs.realpathSync(secrets), PICKED_IDENTITY_NAME),
    });
  });
});
