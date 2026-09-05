import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LOADERS,
  REJECTION_CODE,
  WEB_CONFIG,
  checkWebConfigNativeLoad,
  loadInChildProcess,
  writeStripOnlyControl,
} from "./check-web-config-native-load.mjs";
import { CHECKS } from "./run-checks.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const webConfig = resolve(repoRoot, WEB_CONFIG);

// The real web config is NOT loaded here. Its home is the `Web config native
// load` step in static_checks.yaml, which is `npm run check:web-config-native-
// load` over the committed tree on every pull request; loading it a second time
// from inside this suite would buy nothing and would pull the app's plugin graph
// into a worker running beside the repo-wide checks. What is driven for real is
// the CONTROL fixture -- the calibration the whole check rests on, and cheap
// (a two-module graph, no plugins). Everything above it is logic, driven through
// an injected load.

describe("the control fixture, driven through the real loaders", () => {
  // Four child `node` processes, each importing Vite or a two-module fixture.
  // Measured at ~0.6s apiece; the budget is for a loaded CI runner rather than
  // for the work.
  const BUDGET_MS = 30_000;

  let directory;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "web-config-control-test-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /** The control fixture with its parameter property rewritten as erasable syntax. */
  function writeErasableTwin(root) {
    const configFile = writeStripOnlyControl(root);
    writeFileSync(
      join(root, "parameterProperty.ts"),
      "export class ParameterProperty {\n" +
        "  private readonly value: string;\n" +
        "\n" +
        "  constructor(value: string) {\n" +
        "    this.value = value;\n" +
        "  }\n" +
        "}\n",
    );
    return configFile;
  }

  for (const loader of LOADERS) {
    it(
      `${loader.id} refuses the control with ${REJECTION_CODE}`,
      { timeout: BUDGET_MS },
      () => {
        const control = writeStripOnlyControl(directory);
        const result = loadInChildProcess(loader.id, control, webConfig);
        expect(result.ok).toBe(false);
        expect(result.code).toBe(REJECTION_CODE);
      },
    );

    it(
      `${loader.id} loads the same fixture once the construct is erasable`,
      { timeout: BUDGET_MS },
      () => {
        const twin = writeErasableTwin(directory);
        const result = loadInChildProcess(loader.id, twin, webConfig);
        expect(result.output).toBe("");
        expect(result.ok).toBe(true);
      },
    );
  }
});

describe("the check, driven through an injected load", () => {
  let root;

  /** Record every load, and answer each from `outcomes` by call order. */
  function loader(outcomes) {
    const calls = [];
    const load = (loaderId, configFile, viteFrom) => {
      calls.push({ loaderId, configFile, viteFrom });
      return outcomes[calls.length - 1] ?? { ok: true, code: null, output: "" };
    };
    return { calls, load };
  }

  const loaded = { ok: true, code: null, output: "" };
  const refused = { ok: false, code: REJECTION_CODE, output: "a stack" };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "web-config-check-test-"));
    mkdirSync(dirname(resolve(root, WEB_CONFIG)), { recursive: true });
    writeFileSync(resolve(root, WEB_CONFIG), "export default {};\n");
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes when every leg loads the config", () => {
    const { calls, load } = loader([refused, refused]);
    const result = checkWebConfigNativeLoad({ root, load });
    expect(result).toMatchObject({ ok: true, status: "loads" });
    // Both legs against the control, then both against the config.
    expect(calls).toHaveLength(LOADERS.length * 2);
    expect(calls.slice(LOADERS.length).map((call) => call.configFile)).toEqual([
      resolve(root, WEB_CONFIG),
      resolve(root, WEB_CONFIG),
    ]);
  });

  it("resolves Vite from the web config even for the control", () => {
    const { calls, load } = loader([refused, refused]);
    checkWebConfigNativeLoad({ root, load });
    for (const call of calls) {
      expect(call.viteFrom).toBe(resolve(root, WEB_CONFIG));
    }
  });

  it("fails closed, without loading the config, when a control loads", () => {
    const { calls, load } = loader([loaded]);
    const result = checkWebConfigNativeLoad({ root, load });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("control-loaded");
    expect(result.message).toContain("no longer strip-only");
    expect(calls).toHaveLength(1);
  });

  it("fails closed when a control is refused for some other reason", () => {
    const { calls, load } = loader([
      { ok: false, code: "ERR_MODULE_NOT_FOUND", output: "no such module" },
    ]);
    const result = checkWebConfigNativeLoad({ root, load });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("control-failed-otherwise");
    expect(result.message).toContain("ERR_MODULE_NOT_FOUND");
    expect(result.message).toContain("no such module");
    expect(calls).toHaveLength(1);
  });

  it("names the rewrite when the config contains a refused construct", () => {
    const { load } = loader([
      refused,
      refused,
      { ok: false, code: REJECTION_CODE, output: "parameter property" },
    ]);
    const result = checkWebConfigNativeLoad({ root, load });
    expect(result.ok).toBe(false);
    expect(result.status).toBe("refused");
    expect(result.message).toContain(WEB_CONFIG);
    expect(result.message).toContain("assignment in the constructor body");
    expect(result.message).toContain("parameter property");
  });

  it("separates a load that failed for any other reason", () => {
    const { load } = loader([
      refused,
      refused,
      { ok: false, code: "ERR_MODULE_NOT_FOUND", output: "missing import" },
    ]);
    const result = checkWebConfigNativeLoad({ root, load });
    expect(result.status).toBe("refused");
    expect(result.message).toContain("not their syntax");
    expect(result.message).toContain("missing import");
  });

  it("fails without loading anything when the config is absent", () => {
    rmSync(resolve(root, WEB_CONFIG));
    const { calls, load } = loader([]);
    const result = checkWebConfigNativeLoad({ root, load });
    expect(result).toMatchObject({ ok: false, status: "missing" });
    expect(calls).toHaveLength(0);
  });
});

describe("wiring", () => {
  const read = (path) => readFileSync(resolve(repoRoot, path), "utf8");

  it("is a root npm script", () => {
    expect(
      JSON.parse(read("package.json")).scripts["check:web-config-native-load"],
    ).toBe("node scripts/check-web-config-native-load.mjs");
  });

  it("runs on every pull request", () => {
    expect(CHECKS.map((check) => check.script)).toContain(
      "check:web-config-native-load",
    );
  });

  it("is the command apps/web/README.md hands a contributor", () => {
    expect(read("apps/web/README.md")).toContain(
      "npm run check:web-config-native-load",
    );
  });
});
