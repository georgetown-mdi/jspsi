import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUILDER_STAGE,
  WEB_CONFIG,
  WEB_TEST_TREE,
  builderStageCopies,
  checkWebConfigImageLoad,
  firstTestModule,
  replicateCopies,
  workspaceDirectories,
} from "./check-web-config-image-load.mjs";
import { CHECKS } from "./run-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// The real web config is NOT loaded here. Its home is `npm run
// check:web-config-image-load`, which replicates the image's file subset and
// loads the config in it on every pull request; doing that a second time from
// inside this suite would copy the tree again and pull the app's plugin graph
// into a worker running beside the repo-wide checks. What is driven for real is
// the Dockerfile reading and the replication -- the parts that decide which tree
// the load measures -- against synthetic fixtures. The check's own branching is
// driven through an injected load.

/** A Dockerfile with a builder stage, a second stage, and the COPY shapes the
 * real one is written in. */
const DOCKERFILE_SOURCE = `ARG PROFILE=console

FROM node:26-alpine AS builder
WORKDIR /build
# A comment between instructions.
COPY package.json ./
COPY apps/web/*.config.ts apps/web/tsconfig.json apps/web/
COPY apps/web/src apps/web/src/
RUN npm ci \\
  --omit=dev

FROM node:26-alpine
COPY --from=builder /build/apps/web/.output apps/web/.output
`;

describe("reading the builder stage's copies", () => {
  it("takes the builder stage's COPY instructions and nothing else", () => {
    expect(builderStageCopies(DOCKERFILE_SOURCE)).toEqual([
      { line: 6, sources: ["package.json"], destination: "./" },
      {
        line: 7,
        sources: ["apps/web/*.config.ts", "apps/web/tsconfig.json"],
        destination: "apps/web/",
      },
      { line: 8, sources: ["apps/web/src"], destination: "apps/web/src/" },
    ]);
  });

  it("refuses a COPY it cannot replay rather than approximating it", () => {
    const flagged = DOCKERFILE_SOURCE.replace(
      "COPY package.json ./",
      "COPY --chown=node:node package.json ./",
    );
    expect(() => builderStageCopies(flagged)).toThrow(/--chown=node:node/);
    const jsonForm = DOCKERFILE_SOURCE.replace(
      "COPY package.json ./",
      'COPY ["package.json", "./"]',
    );
    expect(() => builderStageCopies(jsonForm)).toThrow(/JSON-array/);
    const truncated = DOCKERFILE_SOURCE.replace(
      "COPY package.json ./",
      "COPY package.json",
    );
    expect(() => builderStageCopies(truncated)).toThrow(
      /source and a destination/,
    );
  });

  it("finds no copies when no stage is named the builder", () => {
    expect(
      builderStageCopies("FROM node:26-alpine\nCOPY package.json ./\n"),
    ).toEqual([]);
  });
});

describe("replicating the copies", () => {
  let root;
  let into;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "image-subset-root-"));
    into = mkdtempSync(join(tmpdir(), "image-subset-into-"));
    mkdirSync(join(root, "apps/web/src/psi"), { recursive: true });
    mkdirSync(join(root, "apps/web/test"), { recursive: true });
    writeFileSync(join(root, "package.json"), '{ "name": "fixture" }\n');
    writeFileSync(
      join(root, "apps/web/vite.config.ts"),
      "export default {};\n",
    );
    writeFileSync(
      join(root, "apps/web/nitro.config.ts"),
      "export default {};\n",
    );
    writeFileSync(join(root, "apps/web/tsconfig.json"), "{}\n");
    writeFileSync(
      join(root, "apps/web/src/psi/run.ts"),
      "export const run = 1;\n",
    );
    writeFileSync(
      join(root, "apps/web/test/leg.ts"),
      "export const leg = 1;\n",
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(into, { recursive: true, force: true });
  });

  it("lands a directory's contents under the destination and files by name", () => {
    const replicated = replicateCopies(
      root,
      into,
      builderStageCopies(DOCKERFILE_SOURCE),
    );
    expect(readdirSync(join(into, "apps/web")).sort()).toEqual([
      "nitro.config.ts",
      "src",
      "tsconfig.json",
      "vite.config.ts",
    ]);
    expect(existsSync(join(into, "apps/web/src/psi/run.ts"))).toBe(true);
    expect(existsSync(join(into, "package.json"))).toBe(true);
    // The whole point of the subset: the test tree is not in it.
    expect(existsSync(join(into, WEB_TEST_TREE))).toBe(false);
    expect(replicated).toContain(WEB_CONFIG);
  });

  it("refuses a source that names nothing in the checkout", () => {
    const copies = [
      { line: 3, sources: ["apps/web/absent.ts"], destination: "apps/web/" },
    ];
    expect(() => replicateCopies(root, into, copies)).toThrow(
      /not in this checkout/,
    );
    const empty = [
      { line: 3, sources: ["apps/web/*.absent"], destination: "apps/web/" },
    ];
    expect(() => replicateCopies(root, into, empty)).toThrow(/matches nothing/);
  });

  it("refuses a rename onto a file destination", () => {
    const copies = [
      {
        line: 3,
        sources: ["apps/web/tsconfig.json"],
        destination: "apps/web/tsconfig.build.json",
      },
    ];
    expect(() => replicateCopies(root, into, copies)).toThrow(/renames/);
  });
});

describe("the repository's own shape", () => {
  it("names each workspace directory beside the root", () => {
    const directories = workspaceDirectories(repoRoot);
    expect(directories).toContain("");
    expect(directories).toContain("apps/web");
    expect(directories).toContain("packages/core");
  });

  it("finds a control import in the web test tree", () => {
    const specifier = firstTestModule(repoRoot);
    expect(specifier).toMatch(/^\.\/test\/.+\.tsx?$/);
    expect(
      existsSync(resolve(repoRoot, "apps/web", specifier.replace("./", ""))),
    ).toBe(true);
  });
});

describe("the check, driven through an injected load", () => {
  let root;

  /** Record every load, and answer each from `outcomes` by call order. */
  function loader(outcomes) {
    const calls = [];
    const load = (configFile, cwd) => {
      calls.push({ configFile, cwd });
      return outcomes[calls.length - 1] ?? { ok: true, output: "" };
    };
    return { calls, load };
  }

  /** The control's refusal: unresolved, and naming the import it could not
   * resolve, which is what calibrates the check. */
  const refusedControl = {
    ok: false,
    output: "Could not resolve './test/leg.ts' in apps/web/control.ts",
  };
  const loaded = { ok: true, output: "" };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "image-subset-check-"));
    mkdirSync(join(root, "apps/web/src"), { recursive: true });
    mkdirSync(join(root, "apps/web/test"), { recursive: true });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", workspaces: ["apps/*"] }),
    );
    writeFileSync(join(root, "Dockerfile"), DOCKERFILE_SOURCE);
    writeFileSync(
      join(root, "apps/web/vite.config.ts"),
      "export default {};\n",
    );
    writeFileSync(
      join(root, "apps/web/nitro.config.ts"),
      "export default {};\n",
    );
    writeFileSync(join(root, "apps/web/tsconfig.json"), "{}\n");
    writeFileSync(
      join(root, "apps/web/src/main.ts"),
      "export const main = 1;\n",
    );
    writeFileSync(
      join(root, "apps/web/test/leg.ts"),
      "export const leg = 1;\n",
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes when the config loads from the replicated subset", () => {
    const { calls, load } = loader([refusedControl, loaded]);
    const result = checkWebConfigImageLoad({ root, load });
    expect(result).toMatchObject({ ok: true, status: "loads" });
    // The control first, then the replicated config -- never the working tree's.
    expect(calls).toHaveLength(2);
    expect(calls[1].configFile).not.toBe(resolve(root, WEB_CONFIG));
    expect(calls[1].configFile.endsWith(WEB_CONFIG)).toBe(true);
    expect(result.message).toContain(BUILDER_STAGE);
  });

  it("reports the config as refused, with the loader's own output", () => {
    const { load } = loader([
      refusedControl,
      { ok: false, output: "Could not resolve './test/liveWebrtc/x.ts'" },
    ]);
    const result = checkWebConfigImageLoad({ root, load });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("refused");
    expect(result.message).toContain("./test/liveWebrtc/x.ts");
    expect(result.message).toContain("built at runtime");
  });

  it("fails closed, without loading the config, when the control loads", () => {
    const { calls, load } = loader([loaded]);
    const result = checkWebConfigImageLoad({ root, load });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("control-loaded");
    expect(calls).toHaveLength(1);
  });

  it("fails closed when the control is refused for some other reason", () => {
    const { calls, load } = loader([
      { ok: false, output: "Cannot find module 'vite'" },
    ]);
    const result = checkWebConfigImageLoad({ root, load });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("control-failed-otherwise");
    expect(result.message).toContain("Cannot find module 'vite'");
    expect(calls).toHaveLength(1);
  });

  it("fails closed when the builder stage copies the test tree", () => {
    writeFileSync(
      join(root, "Dockerfile"),
      DOCKERFILE_SOURCE.replace(
        "COPY apps/web/src apps/web/src/",
        "COPY apps/web/src apps/web/src/\nCOPY apps/web/test apps/web/test/",
      ),
    );
    const { calls, load } = loader([]);
    const result = checkWebConfigImageLoad({ root, load });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("test-tree-copied");
    expect(calls).toHaveLength(0);
  });

  it("fails without replicating anything when the config is absent", () => {
    rmSync(join(root, WEB_CONFIG));
    const { calls, load } = loader([]);
    const result = checkWebConfigImageLoad({ root, load });
    expect(result).toMatchObject({ ok: false, status: "missing" });
    expect(calls).toHaveLength(0);
  });

  it("names the install when there is none to lend", () => {
    rmSync(join(root, "node_modules"), { recursive: true });
    const result = checkWebConfigImageLoad({ root, load: loader([]).load });
    expect(result).toMatchObject({ ok: false, status: "uninstalled" });
  });

  it("fails when the test tree the control is built from is empty", () => {
    rmSync(join(root, "apps/web/test"), { recursive: true });
    const result = checkWebConfigImageLoad({ root, load: loader([]).load });
    expect(result).toMatchObject({ ok: false, status: "no-test-tree" });
  });
});

describe("wiring", () => {
  const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");

  it("is a root npm script", () => {
    expect(
      JSON.parse(read("package.json")).scripts["check:web-config-image-load"],
    ).toBe("node scripts/check-web-config-image-load.mjs");
  });

  it("runs on every pull request", () => {
    expect(CHECKS.map((check) => check.script)).toContain(
      "check:web-config-image-load",
    );
  });

  it("is the command apps/web/README.md hands a contributor", () => {
    expect(read("apps/web/README.md")).toContain(
      "npm run check:web-config-image-load",
    );
  });
});
