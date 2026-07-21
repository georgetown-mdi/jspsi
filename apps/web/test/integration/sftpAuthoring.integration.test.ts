import { dirname, join, resolve } from "node:path";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  let port = 0;

  beforeAll(async () => {
    dataRoot = mkdtempSync(join(tmpdir(), "psilink-auth-data-"));
    rendezvousDir = mkdtempSync(join(tmpdir(), "psilink-auth-rdv-"));
    secretsDir = mkdtempSync(join(tmpdir(), "psilink-auth-secrets-"));
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
        JOB_CLI_BINARY: stubCli,
      },
    );
    child = proc;
    await waitForRoot(`http://127.0.0.1:${port}/`, proc, getLaunchError);
  }, READY_TIMEOUT_MS + 10_000);

  afterAll(async () => {
    await stopProdServer(child);
    for (const dir of [dataRoot, rendezvousDir, secretsDir])
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
    });

    // DELETE forgets it.
    expect((await fetch(`${base}/sftp`, { method: "DELETE" })).status).toBe(
      204,
    );
    expect(await (await fetch(`${base}/sftp`)).json()).toEqual({
      configured: false,
    });
  });

  test("a credential ref under the data root is refused without echoing it", async () => {
    if (dataRoot === undefined) throw new Error("fixtures not initialized");
    const ref = join(dataRoot, "planted", "pw");
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/sftp`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        host: "authored.partner.example",
        hostKeyFingerprint: FINGERPRINT,
        credential: { kind: "ref", ref: `@${ref}`, credType: "password" },
      }),
    });
    expect(response.status).toBe(400);
    const text = await response.text();
    expect(text).toContain("data root");
    expect(text).not.toContain(ref);
  });
});
