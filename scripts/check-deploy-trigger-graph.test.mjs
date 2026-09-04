import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  BUILD_OUTPUT,
  DEPLOY_WORKFLOW,
  RECORD_ENV,
  REQUIRED_GRAPH_ROOTS,
  classifyGraph,
  collectGraph,
  compileFilter,
  moduleIdToPath,
  readTriggerPaths,
  sourceMapPaths,
  toRepoPath,
  unreachedRoots,
} from "./check-deploy-trigger-graph.mjs";
import { parseWorkflow, workflowDocument } from "./lib/workflows.mjs";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const readRepo = (path) => readFileSync(resolve(repoRoot, path), "utf8");

const scratchDirs = [];
function scratchRepo() {
  const root = mkdtempSync(join(tmpdir(), "deploy-graph-test-"));
  scratchDirs.push(root);
  return root;
}
function writeFile(root, path, contents) {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
  return absolute;
}

afterEach(() => {
  while (scratchDirs.length > 0) {
    rmSync(scratchDirs.pop(), { recursive: true, force: true });
  }
});

describe("reading the deploy trigger", () => {
  // Reads the real workflow, so dropping the push path filter -- or restructuring
  // the trigger out from under the check -- fails here rather than at the next
  // build-driven run.
  it("reads the push path filter out of the real deploy workflow", () => {
    const paths = readTriggerPaths(workflowDocument(repoRoot, DEPLOY_WORKFLOW));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toEqual(
      workflowDocument(repoRoot, DEPLOY_WORKFLOW).on.push.paths,
    );
  });

  it("throws when the push trigger carries no paths list", () => {
    expect(() =>
      readTriggerPaths(
        parseWorkflow("fixture.yaml", "on:\n  push:\n    branches: [main]\n"),
      ),
    ).toThrow(/declares no on.push.paths/);
  });
});

describe("compiling a path filter", () => {
  // The fail-closed half of the check: every pattern in the shipped filter is a
  // shape the matcher reads, so a pattern added in a shape it cannot model stops
  // the change instead of silently mismatching.
  it("compiles every pattern the real deploy workflow declares", () => {
    const filter = compileFilter(
      readTriggerPaths(workflowDocument(repoRoot, DEPLOY_WORKFLOW)),
    );
    expect(filter.patterns.length).toBeGreaterThan(0);
  });

  it("matches a literal pattern only as a whole path", () => {
    const filter = compileFilter(["package-lock.json"]);
    expect(filter.matches("package-lock.json")).toBe(true);
    expect(filter.matches("apps/web/package-lock.json")).toBe(false);
    expect(filter.matches("package-lock.jsonc")).toBe(false);
  });

  it("matches a trailing /** against paths under the prefix", () => {
    const filter = compileFilter(["apps/web/src/**"]);
    expect(filter.matches("apps/web/src/main.tsx")).toBe(true);
    expect(filter.matches("apps/web/src/psi/deep/nested.ts")).toBe(true);
    expect(filter.matches("apps/web/src")).toBe(false);
    // The prefix is a path segment, not a string prefix.
    expect(filter.matches("apps/web/srcs/main.tsx")).toBe(false);
  });

  it.each(["apps/web/*.ts", "!apps/web/test/**", "apps/*/src/**", "**"])(
    "throws on the unsupported pattern %s",
    (pattern) => {
      expect(() => compileFilter([pattern])).toThrow(
        /glob shape .* does not read/,
      );
    },
  );
});

describe("normalizing what a build reports", () => {
  it("strips a query suffix from a module id", () => {
    expect(moduleIdToPath("/repo/apps/web/src/a.worker.ts?worker")).toBe(
      "/repo/apps/web/src/a.worker.ts",
    );
  });

  it.each(["\0virtual:routes", "vite/preload-helper", ""])(
    "reports no file for the module id %j",
    (id) => {
      expect(moduleIdToPath(id)).toBeNull();
    },
  );

  it("resolves sourcemap sources against the directory holding the map", () => {
    expect(
      sourceMapPaths(
        { sources: ["../../../src/httpServer.ts", "assets/routes-abc123.js"] },
        "/repo/apps/web/.output/server/chunks",
      ),
    ).toEqual([
      "/repo/apps/web/src/httpServer.ts",
      "/repo/apps/web/.output/server/chunks/assets/routes-abc123.js",
    ]);
  });

  it("reports no sources for a map that declares none", () => {
    expect(sourceMapPaths({}, "/repo")).toEqual([]);
  });

  it("keeps a path inside the repository and drops the rest", () => {
    expect(toRepoPath("/repo/apps/web/src/a.ts", "/repo")).toBe(
      "apps/web/src/a.ts",
    );
    expect(toRepoPath("/repo/node_modules/dep/index.js", "/repo")).toBeNull();
    expect(
      toRepoPath("/repo/apps/web/node_modules/dep/index.js", "/repo"),
    ).toBeNull();
    expect(toRepoPath("/elsewhere/a.ts", "/repo")).toBeNull();
  });
});

describe("collecting the graph from a build", () => {
  // The recorded module ids and the sourcemap sources cover different passes of
  // the same build -- rolldown's environments and Nitro's server rollup -- so a
  // collection that lost either half would read as a smaller, still-passing
  // graph. This drives the union over a prepared tree with the build injected.
  function prepare(root) {
    writeFile(root, "apps/web/src/peerServer.ts", "");
    writeFile(root, "apps/web/server/custom-entry.ts", "");
    writeFile(root, "node_modules/dep/index.js", "");
    writeFile(
      root,
      `${BUILD_OUTPUT}/server/index.mjs.map`,
      JSON.stringify({
        sources: [
          "../../server/custom-entry.ts",
          "../../assets/routes-abc123.js",
        ],
      }),
    );
  }

  it("unions the recorded module ids with the sourcemap sources", () => {
    const root = scratchRepo();
    prepare(root);
    const graph = collectGraph(root, {
      build: (_root, recordPath) =>
        writeFileSync(
          recordPath,
          JSON.stringify([
            join(root, "apps/web/src/peerServer.ts?worker"),
            join(root, "node_modules/dep/index.js"),
            "\0virtual:entry",
          ]),
        ),
    });
    expect(graph).toEqual([
      "apps/web/server/custom-entry.ts",
      "apps/web/src/peerServer.ts",
    ]);
  });

  it("throws when the build records no module ids", () => {
    const root = scratchRepo();
    prepare(root);
    expect(() => collectGraph(root, { build: () => {} })).toThrow(
      new RegExp(RECORD_ENV),
    );
  });

  it("throws when the build leaves no output directory", () => {
    const root = scratchRepo();
    expect(() =>
      collectGraph(root, {
        build: (_root, recordPath) => writeFileSync(recordPath, "[]"),
      }),
    ).toThrow(new RegExp(BUILD_OUTPUT.replaceAll(".", "\\.")));
  });
});

describe("holding the graph against the filter", () => {
  const filter = compileFilter([
    "apps/web/src/**",
    "packages/peerjs-broker/src/contrib/**",
    "packages/core/src/**",
  ]);
  const tracked = new Set([
    "apps/web/src/peerServer.ts",
    "packages/peerjs-broker/src/contrib/index.ts",
    "packages/peerjs-broker/src/standalone.ts",
    "packages/core/src/main.ts",
  ]);

  it("passes a graph the filter covers", () => {
    expect(
      classifyGraph({
        graph: [
          "apps/web/src/peerServer.ts",
          "packages/peerjs-broker/src/contrib/index.ts",
        ],
        filter,
        tracked,
      }),
    ).toEqual({ uncovered: [], undeclared: [], productGaps: [] });
  });

  // The premise the deploy filter's broker entry rests on: the local `npm start`
  // entry beside src/contrib is in no deployed import graph. If it ever enters
  // one, edits to it stop triggering a deploy.
  it("reports a tracked source the filter does not match", () => {
    const { uncovered } = classifyGraph({
      graph: [
        "packages/peerjs-broker/src/contrib/index.ts",
        "packages/peerjs-broker/src/standalone.ts",
      ],
      filter,
      tracked,
    });
    expect(uncovered).toEqual(["packages/peerjs-broker/src/standalone.ts"]);
  });

  it("accepts a declared build product in place of its sources", () => {
    expect(
      classifyGraph({
        graph: ["packages/core/dist/core.esm.js"],
        filter,
        tracked,
      }),
    ).toEqual({ uncovered: [], undeclared: [], productGaps: [] });
  });

  // A build product stands in for the tree it is built from, so the filter
  // losing that tree is caught even though its sources never appear in a graph.
  it("reports a build product whose source tree the filter dropped", () => {
    const { productGaps } = classifyGraph({
      graph: ["packages/core/dist/core.esm.js"],
      filter: compileFilter(["apps/web/src/**"]),
      tracked,
    });
    expect(productGaps).toHaveLength(1);
    expect(productGaps[0].missed).toEqual(["packages/core/src/main.ts"]);
  });

  it("reports an untracked graph entry under no declared build product", () => {
    const { undeclared } = classifyGraph({
      graph: ["apps/web/.generated/routes.ts"],
      filter,
      tracked,
    });
    expect(undeclared).toEqual(["apps/web/.generated/routes.ts"]);
  });
});

describe("proving the collection halves are alive", () => {
  it("reports every required root the graph does not reach", () => {
    expect(unreachedRoots(["apps/web/src/a.ts"]).map((r) => r.prefix)).toEqual([
      "apps/web/server/",
      "packages/peerjs-broker/src/",
    ]);
  });

  it("reports none when every root is reached", () => {
    expect(
      unreachedRoots(REQUIRED_GRAPH_ROOTS.map((r) => `${r.prefix}file.ts`)),
    ).toEqual([]);
  });
});

describe("wiring", () => {
  // A text scan, not a build: it asserts the two ends of the recorder handshake
  // name the same variable, which is the drift that would leave the record empty.
  it("names the record variable in the build config the recorder lives in", () => {
    expect(readRepo("apps/web/vite.config.ts")).toContain(RECORD_ENV);
  });

  it("runs the check from the workflow that builds the deployed server", () => {
    const workflow = workflowDocument(
      repoRoot,
      ".github/workflows/eb_build_and_test.yaml",
    );
    const steps = workflow.jobs["build-and-test"].steps.map(
      (step) => step.run ?? "",
    );
    expect(
      steps.some((run) => run.includes("check:deploy-trigger-graph")),
    ).toBe(true);
  });

  // The check reads the deploy filter, so a pull request editing only that file
  // has to reach the workflow that runs the check.
  it("triggers that workflow on a change to the deploy filter itself", () => {
    const workflow = workflowDocument(
      repoRoot,
      ".github/workflows/eb_build_and_test.yaml",
    );
    const filter = compileFilter(workflow.on.pull_request.paths);
    expect(filter.matches(DEPLOY_WORKFLOW)).toBe(true);
  });
});
