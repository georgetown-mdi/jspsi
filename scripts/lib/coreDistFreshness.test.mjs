import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import requireFreshCoreDist, {
  ALLOW_STALE_ENV,
  CORE_BUILD_COMMAND,
  CORE_DIR,
  coreDistEntries,
  describeCoreDistStaleness,
  formatCoreDistStaleness,
} from "./coreDistFreshness.mjs";

// A fixture package standing in for packages/core: the same exports shape, with
// every mtime set explicitly so the comparison is driven rather than raced.

const BUILT_AT = new Date("2026-01-02T00:00:00Z");
const BEFORE_BUILD = new Date("2026-01-01T00:00:00Z");
const AFTER_BUILD = new Date("2026-01-03T00:00:00Z");

let coreDir;

function write(relPath, mtime) {
  const path = join(coreDir, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `// ${relPath}\n`);
  utimesSync(path, mtime, mtime);
}

beforeEach(() => {
  coreDir = mkdtempSync(join(tmpdir(), "psilink-core-dist-"));
  writeFileSync(
    join(coreDir, "package.json"),
    JSON.stringify({
      name: "@psilink/core",
      exports: {
        ".": {
          import: "./dist/core.esm.js",
          require: "./dist/core.cjs",
          types: "./dist/index.d.ts",
        },
        "./testing": { import: "./dist/testing.esm.js" },
      },
    }),
  );
  write("src/main.ts", BEFORE_BUILD);
  write("src/config/connection.ts", BEFORE_BUILD);
  write("rollup.config.ts", BEFORE_BUILD);
  for (const entry of [
    "dist/core.esm.js",
    "dist/core.cjs",
    "dist/index.d.ts",
    "dist/testing.esm.js",
  ]) {
    write(entry, BUILT_AT);
  }
});

afterEach(() => {
  rmSync(coreDir, { recursive: true, force: true });
});

describe("coreDistEntries", () => {
  test("takes every dist path the exports map publishes", () => {
    expect(coreDistEntries(coreDir)).toEqual([
      "dist/core.cjs",
      "dist/core.esm.js",
      "dist/index.d.ts",
      "dist/testing.esm.js",
    ]);
  });

  test("reads the real packages/core manifest, which the guard runs against", () => {
    const entries = coreDistEntries(CORE_DIR);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) expect(entry.startsWith("dist/")).toBe(true);
  });
});

describe("describeCoreDistStaleness", () => {
  test("a dist built after every source is fresh", () => {
    expect(describeCoreDistStaleness(coreDir)).toBeNull();
  });

  test("a source written at the same instant as the dist is fresh", () => {
    write("src/main.ts", BUILT_AT);
    expect(describeCoreDistStaleness(coreDir)).toBeNull();
  });

  test("a source newer than the dist is stale, naming both files", () => {
    write("src/config/connection.ts", AFTER_BUILD);
    expect(describeCoreDistStaleness(coreDir)).toEqual({
      kind: "stale",
      source: {
        path: "src/config/connection.ts",
        mtimeMs: AFTER_BUILD.getTime(),
      },
      dist: expect.objectContaining({ mtimeMs: BUILT_AT.getTime() }),
    });
  });

  test("the build config counts as a source", () => {
    write("rollup.config.ts", AFTER_BUILD);
    expect(describeCoreDistStaleness(coreDir)).toMatchObject({
      kind: "stale",
      source: { path: "rollup.config.ts" },
    });
  });

  test("a half-written dist is missing, not stale", () => {
    rmSync(join(coreDir, "dist/core.cjs"));
    rmSync(join(coreDir, "dist/testing.esm.js"));
    expect(describeCoreDistStaleness(coreDir)).toEqual({
      kind: "missing",
      missing: ["dist/core.cjs", "dist/testing.esm.js"],
    });
  });

  // A build that stops emitting an artifact leaves the old copy behind. Judging
  // freshness by the exports map rather than by whatever sits in dist/ keeps
  // that leftover from reporting staleness no rebuild can clear.
  test("a leftover artifact the exports map does not publish is ignored", () => {
    write("dist/core.umd.js", BEFORE_BUILD);
    expect(describeCoreDistStaleness(coreDir)).toBeNull();
  });
});

describe("requireFreshCoreDist", () => {
  test("passes a fresh dist through", () => {
    expect(() => requireFreshCoreDist({ coreDir, env: {} })).not.toThrow();
  });

  test("names the rebuild when the dist is stale", () => {
    write("src/main.ts", AFTER_BUILD);
    expect(() => requireFreshCoreDist({ coreDir, env: {} })).toThrow(
      CORE_BUILD_COMMAND,
    );
    expect(() => requireFreshCoreDist({ coreDir, env: {} })).toThrow(
      /older than its sources/,
    );
  });

  test("names the rebuild when the dist was never built", () => {
    rmSync(join(coreDir, "dist"), { recursive: true });
    expect(() => requireFreshCoreDist({ coreDir, env: {} })).toThrow(
      CORE_BUILD_COMMAND,
    );
  });

  test("the opt-out runs against the dist as it stands", () => {
    write("src/main.ts", AFTER_BUILD);
    expect(() =>
      requireFreshCoreDist({ coreDir, env: { [ALLOW_STALE_ENV]: "1" } }),
    ).not.toThrow();
  });

  test("only the exact opt-out value opts out", () => {
    write("src/main.ts", AFTER_BUILD);
    expect(() =>
      requireFreshCoreDist({ coreDir, env: { [ALLOW_STALE_ENV]: "yes" } }),
    ).toThrow(CORE_BUILD_COMMAND);
  });
});

describe("formatCoreDistStaleness", () => {
  test("locates each file from the directory the run was started in", () => {
    write("src/main.ts", AFTER_BUILD);
    const message = formatCoreDistStaleness(
      describeCoreDistStaleness(coreDir),
      "/repo/packages/core",
      "/repo/apps/cli",
    );
    expect(message).toContain("../../packages/core/src/main.ts");
    expect(message).toContain("../../packages/core/dist/");
    expect(message).toContain(ALLOW_STALE_ENV);
  });

  test("names every missing artifact", () => {
    rmSync(join(coreDir, "dist/index.d.ts"));
    const message = formatCoreDistStaleness(
      describeCoreDistStaleness(coreDir),
      "/repo/packages/core",
      "/repo",
    );
    expect(message).toContain("packages/core/dist/index.d.ts");
    expect(message).toContain(CORE_BUILD_COMMAND);
  });
});
