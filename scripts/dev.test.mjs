import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  APP_WORKSPACE,
  CORE_WORKSPACE,
  DEFAULT_APP_SCRIPT,
  TEARDOWN_SIGNALS,
  appScriptNames,
  coreBuildIsCurrent,
  parseAppScript,
  runDevLoop,
  startProcess,
} from "./dev.mjs";

// Coverage of the root dev loop's two critical properties, neither of which
// a passing dev session would report: core's dist is current BEFORE the dev
// server starts (a server that races the watcher resolves whatever dist happened
// to be on disk, which is the stale build the loop exists to prevent), and one
// side exiting takes the other down (a surviving rollup watcher or dev server
// holds the port and the file watches after the loop is gone).
//
// The process control is injected, so these run the real ordering and teardown
// logic against recorded invocations rather than a spawned dev server.

/** Recording process-control fakes for runDevLoop. */
function harness({ buildCode = 0, buildIsCurrent = false } = {}) {
  const order = [];
  const watchers = [];
  let bothStarted;
  const started = new Promise((r) => {
    bothStarted = r;
  });

  const isCoreBuildCurrent = () => buildIsCurrent;

  const runToCompletion = async (args) => {
    order.push(["run-to-completion", args]);
    return buildCode;
  };

  const startWatcher = (args) => {
    order.push(["watcher", args]);
    let settle;
    const watcher = {
      args,
      killed: [],
      exited: new Promise((r) => {
        settle = r;
      }),
      kill: (signal) => {
        watcher.killed.push(signal);
        settle(143);
      },
      exit: (code) => settle(code),
    };
    watchers.push(watcher);
    if (watchers.length === 2) bothStarted();
    return watcher;
  };

  return {
    order,
    watchers,
    started,
    isCoreBuildCurrent,
    runToCompletion,
    startWatcher,
  };
}

// Start the loop and resolve once both watchers are running. The loop promise is
// returned boxed: `await` on a bare promise return value would unwrap it, and the
// loop does not settle until a watcher exits.
async function startedLoop(harnessState, appScript = "dev") {
  const loop = runDevLoop({
    appScript,
    isCoreBuildCurrent: harnessState.isCoreBuildCurrent,
    runToCompletion: harnessState.runToCompletion,
    startWatcher: harnessState.startWatcher,
  });
  await harnessState.started;
  return { loop };
}

/** A packages/core layout under a throwaway root, with the given mtimes. */
function coreTree({ sourceMtime, distMtime }) {
  const root = mkdtempSync(join(tmpdir(), "psilink-dev-"));
  const core = join(root, CORE_WORKSPACE);
  mkdirSync(join(core, "src"), { recursive: true });
  writeFileSync(join(core, "src", "main.ts"), "export const a = 1;\n");
  utimesSync(join(core, "src", "main.ts"), sourceMtime, sourceMtime);
  if (distMtime !== undefined) {
    mkdirSync(join(core, "dist"), { recursive: true });
    writeFileSync(join(core, "dist", "core.esm.js"), "export const a = 1;\n");
    utimesSync(join(core, "dist", "core.esm.js"), distMtime, distMtime);
  }
  return root;
}

describe("the root dev loop", () => {
  it("builds core before starting anything long-running", async () => {
    const h = harness();
    const { loop } = await startedLoop(h);
    h.watchers[1].exit(0);
    await loop;

    expect(h.order.map(([kind]) => kind)).toEqual([
      "run-to-completion",
      "watcher",
      "watcher",
    ]);
    expect(h.order[0][1]).toEqual(["run", "build", "-w", CORE_WORKSPACE]);
  });

  it("skips the build when core's dist is already current", async () => {
    const h = harness({ buildIsCurrent: true });
    const { loop } = await startedLoop(h);
    h.watchers[1].exit(0);
    await loop;

    expect(h.order.map(([kind]) => kind)).toEqual(["watcher", "watcher"]);
  });

  it("starts the core watcher and the named app script", async () => {
    const h = harness();
    const { loop } = await startedLoop(h, "dev:console");
    h.watchers[1].exit(0);
    await loop;

    expect(h.watchers.map((w) => w.args)).toEqual([
      ["run", "dev", "-w", CORE_WORKSPACE],
      ["run", "dev:console", "-w", APP_WORKSPACE],
    ]);
  });

  it("starts nothing long-running when the core build fails", async () => {
    const h = harness({ buildCode: 1 });
    await expect(
      runDevLoop({
        appScript: "dev",
        isCoreBuildCurrent: h.isCoreBuildCurrent,
        runToCompletion: h.runToCompletion,
        startWatcher: h.startWatcher,
      }),
    ).resolves.toBe(1);
    expect(h.watchers).toHaveLength(0);
  });

  it("takes down the app server when the core watcher exits", async () => {
    const h = harness();
    const { loop } = await startedLoop(h);
    h.watchers[0].exit(7);

    expect(await loop).toBe(7);
    expect(h.watchers[1].killed).toEqual(["SIGTERM"]);
  });

  it("takes down the core watcher when the app server exits", async () => {
    const h = harness();
    const { loop } = await startedLoop(h);
    h.watchers[1].exit(3);

    expect(await loop).toBe(3);
    expect(h.watchers[0].killed).toEqual(["SIGTERM"]);
  });
});

describe("core's build currency", () => {
  it("is false when there is no dist at all", () => {
    expect(coreBuildIsCurrent(coreTree({ sourceMtime: 1000 }))).toBe(false);
  });

  it("is false when a source is newer than the build", () => {
    expect(
      coreBuildIsCurrent(coreTree({ sourceMtime: 2000, distMtime: 1000 })),
    ).toBe(false);
  });

  it("is true when the build is newer than every source", () => {
    expect(
      coreBuildIsCurrent(coreTree({ sourceMtime: 1000, distMtime: 2000 })),
    ).toBe(true);
  });

  it("reads the checked-out tree without throwing", () => {
    expect(typeof coreBuildIsCurrent()).toBe("boolean");
  });
});

// A workspace whose one script runs a node process that records its own pid and
// then stays up, reproducing the shape the dev loop tears down: npm, the shell
// npm runs the script through, and the tool underneath.
function leafWorkspace() {
  const root = mkdtempSync(join(tmpdir(), "psilink-dev-leaf-"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "leaf-probe",
      version: "0.0.0",
      private: true,
      scripts: { leaf: "node leaf.mjs" },
    }),
  );
  writeFileSync(
    join(root, "leaf.mjs"),
    [
      'import { writeFileSync } from "node:fs";',
      'import { join } from "node:path";',
      'writeFileSync(join(import.meta.dirname, "leaf.pid"), String(process.pid));',
      "setInterval(() => {}, 1000);",
      "",
    ].join("\n"),
  );
  return root;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Resolves once `ready` holds, or rejects after `timeoutMs`. */
async function until(ready, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resume) => setTimeout(resume, 50));
  }
}

const ON_WINDOWS = process.platform === "win32";

// The claim the header makes, held as a check rather than as prose: nothing the
// loop started outlives the signal. npm does not forward a signal to the tool it
// runs through a shell, so a startProcess that signals its immediate child
// leaves the leaf running, reparented to init, holding whatever port and file
// watches it had.
describe.skipIf(ON_WINDOWS)("a child of the dev loop", () => {
  const leaves = [];

  // A failing leg is the leaked-process case itself, so the leaf goes down here
  // rather than outliving the run that reported it.
  afterEach(() => {
    for (const leaf of leaves.splice(0)) {
      if (isAlive(leaf)) process.kill(leaf, "SIGKILL");
    }
  });

  it.each(TEARDOWN_SIGNALS)(
    "does not outlive %s",
    async (signal) => {
      const root = leafWorkspace();
      const pidFile = join(root, "leaf.pid");
      const started = startProcess(["--prefix", root, "run", "leaf"]);

      await until(() => existsSync(pidFile), 60_000, "the leaf to start");
      const leaf = Number(readFileSync(pidFile, "utf8"));
      leaves.push(leaf);
      expect(isAlive(leaf)).toBe(true);

      started.kill(signal);
      await started.exited;
      await until(() => !isAlive(leaf), 15_000, `pid ${leaf} to exit`);
    },
    90_000,
  );
});

describe("the dev loop's app-script argument", () => {
  it("defaults to the app's dev script", () => {
    expect(parseAppScript([], appScriptNames())).toBe(DEFAULT_APP_SCRIPT);
  });

  it("accepts a script the app declares", () => {
    expect(parseAppScript(["dev:console"], appScriptNames())).toBe(
      "dev:console",
    );
  });

  it("names the scripts that exist when given one that does not", () => {
    expect(() => parseAppScript(["dve"], appScriptNames())).toThrow(
      /has no 'dve' script; available: .*\bdev\b/,
    );
  });

  it("refuses more than one script name", () => {
    expect(() => parseAppScript(["dev", "dev:console"], ["dev"])).toThrow(
      /at most one/,
    );
  });

  it("reads the app's declared scripts, which include the defaulted ones", () => {
    const names = appScriptNames();
    expect(names).toContain(DEFAULT_APP_SCRIPT);
    expect(names).toContain("dev:console");
  });
});
