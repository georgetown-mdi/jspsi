import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  NITRO_CONFIG,
  checkNitroWebsocketUnset,
  loadNitroConfig,
  websocketEnabled,
} from "./check-nitro-websocket-unset.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SCRIPT = resolve(here, "check-nitro-websocket-unset.mjs");

describe("websocketEnabled", () => {
  it("is false for a config with no experimental section", () => {
    expect(websocketEnabled({})).toBe(false);
    expect(websocketEnabled({ preset: "node_server" })).toBe(false);
  });

  it("is false when experimental.websocket is unset or false", () => {
    expect(websocketEnabled({ experimental: {} })).toBe(false);
    expect(websocketEnabled({ experimental: { websocket: false } })).toBe(
      false,
    );
  });

  it("is true when experimental.websocket is truthy", () => {
    expect(websocketEnabled({ experimental: { websocket: true } })).toBe(true);
  });
});

describe("checkNitroWebsocketUnset against an injected load", () => {
  it("passes a config with no experimental.websocket", async () => {
    const result = await checkNitroWebsocketUnset({
      root: "unused",
      load: async () => ({ preset: "node_server" }),
    });
    expect(result).toEqual({
      ok: true,
      message: `${NITRO_CONFIG} sets no experimental.websocket.`,
    });
  });

  it("fails a config that turns experimental.websocket on, naming the collision", async () => {
    const result = await checkNitroWebsocketUnset({
      root: "unused",
      load: async () => ({ experimental: { websocket: true } }),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/mis-route/);
    expect(result.message).toMatch(/custom-entry\.ts/);
  });
});

describe("loadNitroConfig against the real repository config", () => {
  it("loads apps/web/nitro.config.ts and it sets no experimental.websocket today", async () => {
    const config = await loadNitroConfig(repoRoot);
    expect(websocketEnabled(config)).toBe(false);
  });
});

describe("the CLI entry, driven against a fixture tree", () => {
  const roots = [];

  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  /** A minimal tree holding only apps/web/nitro.config.ts, as a bare object
   * export -- no nitropack import, so the fixture resolves with no dependency
   * on this repository's node_modules. */
  function fixtureTree(configBody) {
    const root = mkdtempSync(join(tmpdir(), "psilink-nitro-websocket-unset-"));
    roots.push(root);
    const serverDirectory = join(root, "apps", "web");
    mkdirSync(serverDirectory, { recursive: true });
    writeFileSync(
      join(serverDirectory, "nitro.config.ts"),
      `export default ${configBody};\n`,
    );
    return root;
  }

  function runCheck(root) {
    try {
      const stdout = execFileSync(process.execPath, [SCRIPT, "--root", root], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      return { status: 0, stdout, stderr: "" };
    } catch (error) {
      return {
        status: error.status,
        stdout: error.stdout,
        stderr: error.stderr,
      };
    }
  }

  it("exits 0 for a fixture config with no experimental.websocket", () => {
    const root = fixtureTree('{ preset: "node_server" }');
    const result = runCheck(root);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/passed/);
  });

  it("exits 1 for a fixture config that turns experimental.websocket on", () => {
    const root = fixtureTree("{ experimental: { websocket: true } }");
    const result = runCheck(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/mis-route/);
  });
});
