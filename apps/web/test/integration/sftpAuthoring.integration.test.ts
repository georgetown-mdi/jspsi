import { dirname, join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  getFreePort,
  spawnProdServer,
  stopProdServer,
  waitForRoot,
} from "./prodServer.js";

import type { ChildProcess } from "node:child_process";

// The server-side of authoring an SFTP connection, demonstrated once against the
// REAL built server: the operator browses a mounted secrets directory, then PUTs
// a file-reference credential that composes into the effective connection -- all
// with no UI. The job API runs only in a console build, so the server env sets
// VITE_DEPLOYMENT_PROFILE=console alongside the data root; the secrets mount is a
// separate directory (JOB_SECRETS_DIR has no data-root fallback).
//
// Build-gated exactly like jobWorkInput: the production entry exists only after
// `npm run build -w apps/web`. CI builds the web app before the integration step.
const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../..");
const prodEntry = resolve(webRoot, ".output/server/index.mjs");
const hasBuild = existsSync(prodEntry);
const stubCli = resolve(webRoot, "test/utils/stubCli.mjs");

const READY_TIMEOUT_MS = 30_000;
const FINGERPRINT = `SHA256:${"A".repeat(43)}`;

describe.skipIf(!hasBuild)("SFTP connection authoring (server side)", () => {
  let child: ChildProcess | undefined;
  let dataRoot: string | undefined;
  let rendezvousDir: string | undefined;
  let secretsDir: string | undefined;
  let scratchDir: string | undefined;
  let port = 0;

  beforeAll(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "psilink-auth-data-"));
    rendezvousDir = mkdtempSync(join(tmpdir(), "psilink-auth-rdv-"));
    secretsDir = mkdtempSync(join(tmpdir(), "psilink-auth-secrets-"));
    // The built server runs as an ordinary user here, so relocate the
    // pasted-credential scratch dir off the root-owned default it uses in-image.
    scratchDir = mkdtempSync(join(tmpdir(), "psilink-auth-cred-"));
    writeFileSync(join(secretsDir, "partner-password"), "s3cret\n");
    mkdirSync(join(secretsDir, ".ssh"));
    writeFileSync(join(secretsDir, ".ssh", "id_ed25519"), "PRIVATE\n");

    port = await getFreePort();
    const { child: proc, getLaunchError } = await spawnProdServer(
      prodEntry,
      webRoot,
      port,
      {
        VITE_DEPLOYMENT_PROFILE: "console",
        JOB_DATA_ROOT: dataRoot,
        JOB_RENDEZVOUS_DIR: rendezvousDir,
        JOB_SECRETS_DIR: secretsDir,
        JOB_SFTP_CREDENTIAL_DIR: scratchDir,
        JOB_CLI_BINARY: stubCli,
      },
    );
    child = proc;
    await waitForRoot(`http://127.0.0.1:${port}/`, proc, getLaunchError);
  }, READY_TIMEOUT_MS + 10_000);

  afterAll(async () => {
    await stopProdServer(child);
    for (const dir of [dataRoot, rendezvousDir, secretsDir, scratchDir])
      if (dir) rmSync(dir, { recursive: true, force: true });
  });

  test("browse the secrets mount, then author and clear a connection", async () => {
    if (secretsDir === undefined) throw new Error("fixtures not initialized");
    const base = `http://127.0.0.1:${port}/api/jobs`;

    // No connection yet.
    expect(await (await fetch(`${base}/sftp`)).json()).toEqual({
      configured: false,
    });

    // Browse the mount root: a loose file and a dot-prefixed key directory.
    const root = (await (
      await fetch(`${base}/mounts/secrets/entries`)
    ).json()) as { configured: boolean; entries: Array<unknown> };
    expect(root.configured).toBe(true);
    expect(root.entries).toEqual([
      { name: ".ssh", kind: "dir" },
      { name: "partner-password", kind: "file" },
    ]);

    // Navigate into the dot directory with a repeated subPath parameter.
    const ssh = (await (
      await fetch(`${base}/mounts/secrets/entries?subPath=.ssh`)
    ).json()) as { entries: Array<unknown> };
    expect(ssh.entries).toEqual([{ name: "id_ed25519", kind: "file" }]);

    // Author a connection whose credential references the browsed file.
    const put = await fetch(`${base}/sftp`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: "authored.partner.example",
        port: 2022,
        path: "/drop",
        hostKeyFingerprint: FINGERPRINT,
        credential: {
          kind: "ref",
          ref: `@${join(secretsDir, "partner-password")}`,
          credType: "password",
        },
      }),
    });
    expect(put.status).toBe(200);

    // GET now reflects the authored connection, credential-free.
    const projection = await (await fetch(`${base}/sftp`)).text();
    expect(projection).not.toContain("@");
    expect(projection).not.toContain("SHA256");
    expect(JSON.parse(projection)).toEqual({
      configured: true,
      host: "authored.partner.example",
      port: 2022,
      path: "/drop",
      // The credential lives in the separate secrets mount, so no warning.
      credentialWarnings: [],
    });

    // DELETE forgets it.
    expect((await fetch(`${base}/sftp`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect(await (await fetch(`${base}/sftp`)).json()).toEqual({
      configured: false,
    });
  });

  test("author from a mountRef locator the operator picked in the browse", async () => {
    const base = `http://127.0.0.1:${port}/api/jobs`;

    // A mountRef carries only the picked path segments; the server resolves them
    // against JOB_SECRETS_DIR to an absolute @path -- no absolute path from the
    // browser.
    const put = await fetch(`${base}/sftp`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: "picked.partner.example",
        username: "linkage",
        hostKeyFingerprint: FINGERPRINT,
        credential: {
          kind: "mountRef",
          mount: "secrets",
          subPath: [".ssh", "id_ed25519"],
          credType: "private_key",
        },
      }),
    });
    expect(put.status).toBe(200);

    const projection = await (await fetch(`${base}/sftp`)).text();
    expect(projection).not.toContain("@");
    expect(JSON.parse(projection)).toEqual({
      configured: true,
      host: "picked.partner.example",
      credentialWarnings: [],
    });

    expect((await fetch(`${base}/sftp`, { method: "DELETE" })).status).toBe(
      204,
    );
  });

  test("a pasted value materializes to the scratch dir and projects credential-free", async () => {
    if (scratchDir === undefined) throw new Error("fixtures not initialized");
    const base = `http://127.0.0.1:${port}/api/jobs`;

    const put = await fetch(`${base}/sftp`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: "pasted.partner.example",
        hostKeyFingerprint: FINGERPRINT,
        credential: {
          kind: "raw",
          value: "s3cret-pasted-password",
          credType: "password",
        },
      }),
    });
    expect(put.status).toBe(200);
    const projection = await put.text();
    // Neither the pasted value nor an @path rides the response.
    expect(projection).not.toContain("s3cret-pasted-password");
    expect(projection).not.toContain("@");
    expect(JSON.parse(projection)).toEqual({
      configured: true,
      host: "pasted.partner.example",
      credentialWarnings: [],
    });

    // The value exists at rest ONLY as the scratch file, outside the data root.
    const files = readdirSync(scratchDir);
    expect(files).toHaveLength(1);
    expect(readFileSync(join(scratchDir, files[0]), "utf8")).toBe(
      "s3cret-pasted-password",
    );

    // DELETE forgets the connection and sweeps the materialized secret.
    expect((await fetch(`${base}/sftp`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect(readdirSync(scratchDir)).toEqual([]);
  });

  test("probe the host key over the route, statelessly (round-trip against the stub CLI)", async () => {
    const base = `http://127.0.0.1:${port}/api/jobs`;
    // No connection authored before the probe.
    expect(await (await fetch(`${base}/sftp`)).json()).toEqual({
      configured: false,
    });

    // The route spawns the CLI probe subcommand, discards its stderr, and
    // reconciles the outcome to the typed envelope. The stub CLI emits its default
    // valid line, so the round-trip lands `ok` deterministically.
    const probe = await fetch(`${base}/sftp/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host: "sftp.partner.example", port: 2222 }),
    });
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({
      status: "ok",
      fingerprint: FINGERPRINT,
      keyType: "ssh-ed25519",
    });

    // The probe authored nothing: the connection state is unchanged.
    expect(await (await fetch(`${base}/sftp`)).json()).toEqual({
      configured: false,
    });

    // A credential-shaped field is rejected by the strict body (no such field).
    const bad = await fetch(`${base}/sftp/probe`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: "sftp.partner.example",
        password: "@/etc/shadow",
      }),
    });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("shadow");
  });

  test("a mountRef escaping the secrets mount is refused without echoing a path", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/sftp`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: "picked.partner.example",
        hostKeyFingerprint: FINGERPRINT,
        credential: {
          kind: "mountRef",
          mount: "secrets",
          subPath: [".."],
          credType: "password",
        },
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("connection.credential");
  });

  test("a host carrying userinfo and a path is refused, naming the field only", async () => {
    if (secretsDir === undefined) throw new Error("fixtures not initialized");
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/sftp`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: "sftp://user:pw@partner.example/drop",
        hostKeyFingerprint: FINGERPRINT,
        credential: {
          kind: "ref",
          ref: `@${join(secretsDir, "partner-password")}`,
          credType: "password",
        },
      }),
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("server.host");
    // The rejection never echoes the smuggled userinfo.
    expect(text).not.toContain("user:pw");
  });

  test("a credential ref inside the data root warns but authors, never echoing it", async () => {
    if (dataRoot === undefined) throw new Error("fixtures not initialized");
    mkdirSync(join(dataRoot, "planted"), { recursive: true });
    const ref = join(dataRoot, "planted", "pw");
    writeFileSync(ref, "s3cret\n");
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/sftp`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: "authored.partner.example",
        hostKeyFingerprint: FINGERPRINT,
        credential: { kind: "ref", ref: `@${ref}`, credType: "password" },
      }),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    // The warning names the field and the directory only, never the reference.
    expect(text).not.toContain("@");
    expect(text).not.toContain(ref);
    const parsed = JSON.parse(text) as { credentialWarnings?: Array<string> };
    expect(parsed.credentialWarnings).toHaveLength(1);
    expect(parsed.credentialWarnings?.[0]).toContain("data root");
    // Clean up so the connection does not leak into a later test.
    await fetch(`http://127.0.0.1:${port}/api/jobs/sftp`, { method: "DELETE" });
  });
});
