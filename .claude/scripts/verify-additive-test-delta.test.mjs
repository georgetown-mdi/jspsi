import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createGitFixtures } from "./lib/gitFixture.mjs";
import {
  collectVerdicts,
  insertedLines,
  insertionRefusal,
  soundnessProbes,
  summarize,
  testPathRefusal,
} from "./verify-additive-test-delta.mjs";

// The verifier admits a head no reviewer will read again, so the cases that
// matter are the refusals: every way a test delta can hold something other than
// an added line. Each of those is driven through real git below rather than
// modelled, since what git reports for a replaced line, a file with no trailing
// newline, a rename and a binary blob is the whole basis for reading a patch as
// insertion-only.

describe("soundness probes", () => {
  it("all pass on the installed git (the CLI's preflight gate)", () => {
    expect(soundnessProbes().filter((probe) => !probe.ok)).toEqual([]);
  });
});

describe("test-path classification", () => {
  it("admits the app and package test directories", () => {
    for (const path of [
      "apps/web/test/browser/import.test.ts",
      "apps/web/test/unit/console/panel.test.tsx",
      "apps/cli/test/exitCapture.ts",
      "apps/cli/test/unit/commands/run.test.ts",
      "packages/core/test/psi/engine.test.ts",
      "packages/peerjs-broker/test/broker.test.mjs",
    ]) {
      expect(testPathRefusal(path)).toBeNull();
    }
  });

  it("refuses a path outside those directories", () => {
    for (const path of [
      "apps/web/src/routes/index.tsx",
      "packages/core/src/psi/engine.ts",
      "packages/testkit/src/fixtures.ts",
      "apps/web/testHelpers.ts",
      "apps/web/e2e/import.test.ts",
      "apps/web/nested/test/import.test.ts",
      "test/import.test.ts",
    ]) {
      expect(testPathRefusal(path)).toMatch(/only directories/);
    }
  });

  // Measured, not assumed: scripts/sftp-tracked-round-trips.test.mjs holds
  // ALLOWED_OUTSIDE_THE_BRACKET, a list of call sites exempted from the control
  // that check enforces, and an inserted entry there widens the exemption rather
  // than adding a test. The check tests are refused as a class for that reason.
  it("refuses the repository's own check tests, whose inserted lines can be pin data", () => {
    for (const path of [
      "scripts/sftp-tracked-round-trips.test.mjs",
      "scripts/check-egress-claims.test.mjs",
      ".claude/scripts/verify-additive-test-delta.test.mjs",
      "scripts/lib/typeScriptSources.test.mjs",
    ]) {
      expect(testPathRefusal(path)).toMatch(/only directories/);
    }
  });

  it("refuses a configuration file inside a test directory", () => {
    for (const path of [
      "apps/web/test/vitest.config.ts",
      "apps/web/test/.eslintrc.cjs",
      "packages/core/test/tsconfig.json",
      "apps/cli/test/package.json",
    ]) {
      expect(testPathRefusal(path)).toMatch(/dotfile or a tool configuration/);
    }
  });

  it("refuses a fixture it cannot read as test code", () => {
    for (const path of [
      "packages/core/test/vectors/psi-intersection-vectors.json",
      "apps/cli/test/sftpServer/host.key",
      "apps/web/test/browser/page.html",
      "apps/cli/test/fixtures/input.csv",
    ]) {
      expect(testPathRefusal(path)).toMatch(/TypeScript or JavaScript/);
    }
  });
});

describe("patch reading", () => {
  // These patches are hand-written, which makes them a model of git's output
  // rather than a measurement of it; they cover the shapes the run refuses
  // without producing, and every shape git does produce is driven through real
  // git below.
  it("refuses a context line, which --unified=0 does not produce", () => {
    expect(insertedLines("@@ -1,2 +1,3 @@\n kept\n+added\n").error).toMatch(
      /context lines/,
    );
  });

  it("refuses a patch line it does not model", () => {
    expect(insertedLines("@@ -1,0 +2 @@\n?added\n").error).toMatch(
      /does not model/,
    );
  });

  it("refuses a change that produced no hunks", () => {
    expect(insertedLines("").error).toMatch(/no patch hunks/);
  });

  it("reads an inserted line after the no-newline marker", () => {
    const { lines, error } = insertedLines(
      "@@ -1,0 +2 @@\n+added\n\\ No newline at end of file\n",
    );
    expect(error).toBeNull();
    expect(lines).toEqual(["added"]);
  });
});

describe("inserted-line content", () => {
  it("refuses a lint or type-check suppression", () => {
    for (const line of [
      "  // eslint-disable-next-line no-restricted-syntax",
      "/* eslint-disable */",
      "  // @ts-expect-error the stub returns the wrong shape",
      "// @ts-ignore",
      "  /* v8 ignore next */",
      "  // prettier-ignore",
    ]) {
      expect(insertionRefusal([line])).toMatch(/lint or type-check/);
    }
  });

  it("refuses a test double reaching past its own statement", () => {
    for (const line of [
      'vi.mock("../../src/exchange/guard");',
      '  vi.doMock("node:fs");',
      '  vi.spyOn(process, "exit").mockImplementation(() => undefined);',
      '  vi.stubGlobal("fetch", stub);',
      '  vi.stubEnv("PSILINK_ALLOW", "1");',
      "  vi.useFakeTimers();",
      "  expect.extend({ toBeSafe: () => ({ pass: true }) });",
      'import { vi as v } from "vitest";\nv.spyOn(process, "exit");',
    ]) {
      expect(insertionRefusal([line])).toMatch(/test double/);
    }
  });

  it("admits the ordinary lines an added test is made of", () => {
    expect(
      insertionRefusal([
        'it("refuses an invalid record", async () => {',
        "  const stub = vi.fn();",
        "  expect(await load(record)).toBeUndefined();",
        "});",
      ]),
    ).toBeNull();
  });
});

const {
  makeTempDir,
  makeFixture: makeBareFixture,
  cleanup,
} = createGitFixtures();

afterEach(cleanup);

const makeFixture = () => makeBareFixture("additive-test-delta-");

const byPath = (verdicts) =>
  Object.fromEntries(verdicts.map((v) => [v.path, v.verdict]));

const reasonFor = (verdicts, path) =>
  verdicts.find((v) => v.path === path)?.reason ?? "";

describe("against a real git repository", () => {
  it("holds for an inserted block and a whole added test file", () => {
    const { git, write, commit } = makeFixture();
    write(
      "apps/web/test/browser/import.test.ts",
      'it("imports", () => {\n  expect(1).toBe(1);\n});\n',
    );
    const attested = commit("Base");

    write(
      "apps/web/test/browser/import.test.ts",
      'it("imports", () => {\n  expect(1).toBe(1);\n});\n\nit("imports beside an invalid record", () => {\n  expect(2).toBe(2);\n});\n',
    );
    write(
      "packages/core/test/psi/engine.test.ts",
      'it("intersects", () => {\n  expect(3).toBe(3);\n});\n',
    );
    const head = commit("Add tests");

    const verdicts = collectVerdicts({ attested, head, git });
    expect(byPath(verdicts)).toEqual({
      "apps/web/test/browser/import.test.ts": "additive-test",
      "packages/core/test/psi/engine.test.ts": "additive-test",
    });
    expect(verdicts.map((v) => v.inserted)).toEqual([4, 3]);
    expect(summarize(verdicts)).toMatchObject({ holds: true, exitCode: 0 });
  });

  it("refuses a deleted line and a replaced one", () => {
    const { git, write, commit } = makeFixture();
    write(
      "apps/cli/test/unit/run.test.ts",
      'it("a", () => {\n  expect(a).toBe(1);\n});\n',
    );
    write(
      "packages/core/test/psi/engine.test.ts",
      'it("b", () => {\n  expect(b).toBe(2);\n});\n',
    );
    const attested = commit("Base");

    write("apps/cli/test/unit/run.test.ts", 'it("a", () => {\n});\n');
    write(
      "packages/core/test/psi/engine.test.ts",
      'it("b", () => {\n  expect(b).toBeDefined();\n});\n',
    );
    const head = commit("Loosen them");

    const verdicts = collectVerdicts({ attested, head, git });
    expect(byPath(verdicts)).toEqual({
      "apps/cli/test/unit/run.test.ts": "refused",
      "packages/core/test/psi/engine.test.ts": "refused",
    });
    for (const path of Object.keys(byPath(verdicts))) {
      expect(reasonFor(verdicts, path)).toMatch(/deletes a line/);
    }
    expect(summarize(verdicts)).toMatchObject({ holds: false, exitCode: 1 });
  });

  it("refuses an append to a test file that had no trailing newline", () => {
    const { git, write, commit } = makeFixture();
    write("apps/cli/test/unit/run.test.ts", "const a = 1;");
    const attested = commit("Base");

    write("apps/cli/test/unit/run.test.ts", "const a = 1;\nconst b = 2;\n");
    const head = commit("Append");

    expect(
      reasonFor(
        collectVerdicts({ attested, head, git }),
        "apps/cli/test/unit/run.test.ts",
      ),
    ).toMatch(/deletes a line/);
  });

  it("refuses a deleted test file and a renamed one", () => {
    const { git, write, remove, commit } = makeFixture();
    write("apps/cli/test/unit/gone.test.ts", "const a = 1;\n");
    write("apps/cli/test/unit/mover.test.ts", "const b = 2;\n");
    const attested = commit("Base");

    remove("apps/cli/test/unit/gone.test.ts");
    git([
      "mv",
      "apps/cli/test/unit/mover.test.ts",
      "apps/cli/test/unit/moved.test.ts",
    ]);
    const head = commit("Drop one, move one");

    const verdicts = collectVerdicts({ attested, head, git });
    expect(byPath(verdicts)).toEqual({
      "apps/cli/test/unit/gone.test.ts": "refused",
      "apps/cli/test/unit/mover.test.ts": "refused",
      "apps/cli/test/unit/moved.test.ts": "additive-test",
    });
    expect(reasonFor(verdicts, "apps/cli/test/unit/mover.test.ts")).toMatch(
      /deleted at the head/,
    );
    expect(summarize(verdicts)).toMatchObject({ holds: false, exitCode: 1 });
  });

  it("refuses a chmod, which changes no line at all", () => {
    const { git, write, chmod, commit } = makeFixture();
    write("apps/cli/test/unit/run.test.ts", "const a = 1;\n");
    const attested = commit("Base");

    chmod("apps/cli/test/unit/run.test.ts", 0o755);
    const head = commit("Make it runnable");

    expect(
      reasonFor(
        collectVerdicts({ attested, head, git }),
        "apps/cli/test/unit/run.test.ts",
      ),
    ).toMatch(/file mode/);
  });

  it("refuses an inserted mock and an inserted lint suppression", () => {
    const { git, write, commit } = makeFixture();
    write("apps/web/test/unit/guard.test.ts", "const a = 1;\n");
    write("packages/core/test/psi/engine.test.ts", "const b = 2;\n");
    const attested = commit("Base");

    write(
      "apps/web/test/unit/guard.test.ts",
      'const a = 1;\nvi.mock("../../src/guard");\n',
    );
    write(
      "packages/core/test/psi/engine.test.ts",
      "const b = 2;\n// eslint-disable-next-line no-restricted-syntax\nconst c = 3;\n",
    );
    const head = commit("Add a mock and a suppression");

    const verdicts = collectVerdicts({ attested, head, git });
    expect(byPath(verdicts)).toEqual({
      "apps/web/test/unit/guard.test.ts": "refused",
      "packages/core/test/psi/engine.test.ts": "refused",
    });
    expect(reasonFor(verdicts, "apps/web/test/unit/guard.test.ts")).toMatch(
      /test double/,
    );
    expect(
      reasonFor(verdicts, "packages/core/test/psi/engine.test.ts"),
    ).toMatch(/lint or type-check/);
  });

  it("refuses a binary path under a test directory", () => {
    const { git, write, commit } = makeFixture();
    write("packages/core/test/vectors/blob.ts", "const a = 1;\n");
    const attested = commit("Base");

    write(
      "packages/core/test/vectors/blob.ts",
      Buffer.from([99, 0, 100]).toString("binary"),
    );
    const head = commit("Make it binary");

    expect(
      reasonFor(
        collectVerdicts({ attested, head, git }),
        "packages/core/test/vectors/blob.ts",
      ),
    ).toMatch(/binary file/);
  });

  it("refuses a source path changed beside an additive test insertion", () => {
    const { git, write, commit } = makeFixture();
    write("packages/core/src/psi/engine.ts", "export const a = 1;\n");
    write("packages/core/test/psi/engine.test.ts", "const b = 2;\n");
    const attested = commit("Base");

    write(
      "packages/core/src/psi/engine.ts",
      "export const a = 1;\nexport const added = 2;\n",
    );
    write(
      "packages/core/test/psi/engine.test.ts",
      "const b = 2;\nconst c = 3;\n",
    );
    const head = commit("Add to both");

    const verdicts = collectVerdicts({ attested, head, git });
    expect(byPath(verdicts)).toEqual({
      "packages/core/src/psi/engine.ts": "refused",
      "packages/core/test/psi/engine.test.ts": "additive-test",
    });
    expect(summarize(verdicts)).toMatchObject({ holds: false, exitCode: 1 });
  });

  it("refuses an added test vector, which is not read as test code", () => {
    const { git, write, commit } = makeFixture();
    write("packages/core/test/psi/engine.test.ts", "const b = 2;\n");
    const attested = commit("Base");

    write("packages/core/test/vectors/added.json", '{ "a": 1 }\n');
    const head = commit("Add a vector");

    expect(
      reasonFor(
        collectVerdicts({ attested, head, git }),
        "packages/core/test/vectors/added.json",
      ),
    ).toMatch(/TypeScript or JavaScript/);
  });

  it("holds vacuously for a ref compared with itself", () => {
    const { git, write, commit } = makeFixture();
    write("apps/cli/test/unit/run.test.ts", "const a = 1;\n");
    const head = commit("Base");

    const verdicts = collectVerdicts({ attested: head, head, git });
    expect(verdicts).toEqual([]);
    expect(summarize(verdicts)).toMatchObject({ holds: true, exitCode: 0 });
  });
});

const SCRIPT = fileURLToPath(
  new URL("./verify-additive-test-delta.mjs", import.meta.url),
);

// The verdict is about the tree the process runs in, so every case states its
// own `cwd`; the default is the directory holding the script, which puts a case
// that names no tree of its own inside this repository.
const runScript = (args, cwd = dirname(SCRIPT)) => {
  try {
    return {
      status: 0,
      stdout: execFileSync(process.execPath, [SCRIPT, ...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
      stderr: "",
    };
  } catch (error) {
    return {
      status: error.status,
      stdout: error.stdout,
      stderr: error.stderr,
    };
  }
};

// The script as an agent invokes it, so argv handling, the git error path, and
// the exit codes are exercised rather than assumed. Exit 3 stays unreachable
// from a subprocess -- it needs a git whose diff output fails a probe -- and is
// covered only by the soundness-probe test above.
describe("the script as an agent runs it", () => {
  // Each run spawns Node cold and drives git several times for its probes;
  // sized well past the worst measurement under a full `npm test` fan-out, this
  // stays a hang safety check rather than a claim about how fast a process
  // starts.
  const SPAWN_TIMEOUT_MS = 60_000;

  it(
    "prints usage and exits 2 unless given exactly two refs",
    () => {
      for (const args of [[], ["only-one"], ["one", "two", "three"]]) {
        const result = runScript(args);
        expect(result.status).toBe(2);
        expect(result.stderr).toMatch(
          /^Usage: node \.claude\/scripts\/verify-additive-test-delta\.mjs /,
        );
        expect(result.stdout).toBe("");
      }
    },
    SPAWN_TIMEOUT_MS,
  );

  it(
    "exits 2 when a ref does not resolve, rather than reporting a verdict",
    { timeout: SPAWN_TIMEOUT_MS },
    () => {
      const result = runScript(["HEAD", "no-such-ref-9f3c1a"]);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/^error: /m);
      expect(result.stdout).not.toMatch(/HOLDS|VIOLATED/);
    },
  );

  it(
    "passes its probes and exits 0 over a ref compared with itself",
    { timeout: SPAWN_TIMEOUT_MS },
    () => {
      const result = runScript(["HEAD", "HEAD"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /soundness probes: (\d+)\/\1 passed on git version /,
      );
      expect(result.stdout).toContain("(none)");
      expect(result.stdout).toMatch(/additive-test-delta property: HOLDS/);
    },
  );

  it(
    "reports the held paths and their inserted-line counts in the invoking tree",
    { timeout: SPAWN_TIMEOUT_MS },
    () => {
      const fixture = makeFixture();
      fixture.write("apps/web/test/browser/import.test.ts", "const a = 1;\n");
      const attested = fixture.commit("Base");
      fixture.write(
        "apps/web/test/browser/import.test.ts",
        "const a = 1;\nconst b = 2;\n",
      );
      const head = fixture.commit("Add a line");

      const result = runScript([attested, head], fixture.dir);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(
        /\[additive test\] apps\/web\/test\/browser\/import\.test\.ts \(\+1\)/,
      );
      expect(result.stdout).toMatch(/additive-test-delta property: HOLDS/);
    },
  );

  it(
    "names each refused path and exits 1",
    { timeout: SPAWN_TIMEOUT_MS },
    () => {
      const fixture = makeFixture();
      fixture.write("packages/core/src/psi/engine.ts", "export const a = 1;\n");
      const attested = fixture.commit("Base");
      fixture.write(
        "packages/core/src/psi/engine.ts",
        "export const a = 1;\nexport const b = 2;\n",
      );
      const head = fixture.commit("Change the source");

      const result = runScript([attested, head], fixture.dir);
      expect(result.status).toBe(1);
      expect(result.stdout).toMatch(
        /\[REFUSED\s*\] packages\/core\/src\/psi\/engine\.ts/,
      );
      expect(result.stdout).toMatch(/only directories/);
      expect(result.stdout).toMatch(/additive-test-delta property: VIOLATED/);
    },
  );

  it(
    "exits 2 from outside any worktree rather than falling back to its own",
    { timeout: SPAWN_TIMEOUT_MS },
    () => {
      const result = runScript(
        ["HEAD", "HEAD"],
        makeTempDir("additive-test-delta-bare-"),
      );
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/is not inside a git worktree/);
      expect(result.stdout).not.toMatch(/HOLDS|VIOLATED/);
    },
  );
});
