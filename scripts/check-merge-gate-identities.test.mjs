import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  GATING_WORKFLOWS,
  GITHUB_ACTIONS_APP_ID,
  PROTECTED_BRANCHES,
  branchRequiredContexts,
  contextViolations,
  fetchBranchRules,
  foreignContexts,
  jobCheckNames,
  mergeContexts,
  parseRepositorySlug,
  pathFilterViolations,
  pullRequestTrigger,
  readRequiredContexts,
  workflowJobIndex,
} from "./check-merge-gate-identities.mjs";
import { parseWorkflow } from "./lib/workflows.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

// Both rules read a parsed workflow; each case states the source it stands for.
const jobNames = (source) =>
  jobCheckNames(parseWorkflow("fixture.yaml", source));
const trigger = (source) =>
  pullRequestTrigger(parseWorkflow("fixture.yaml", source));

const gatingWorkflow = (name) => `name: Gate
on:
  pull_request:
    branches: [main, staging]
jobs:
  gate:
    name: ${name}
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`;

const requiredCheck = (context, integrationId = GITHUB_ACTIONS_APP_ID) => ({
  context,
  ...(integrationId === null ? {} : { integration_id: integrationId }),
});

const rulesWithChecks = (...checks) => [
  { type: "deletion", ruleset_id: 1 },
  {
    type: "required_status_checks",
    parameters: {
      strict_required_status_checks_policy: false,
      required_status_checks: checks,
    },
    ruleset_id: 1,
  },
];

const indexOf = (...names) => ({ literal: new Set(names), templated: [] });

const withTempRoot = (body) => {
  const root = mkdtempSync(join(tmpdir(), "merge-gate-identities-"));
  try {
    mkdirSync(join(root, ".github/workflows"), { recursive: true });
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

describe("job check names", () => {
  it("reads a job's name and falls back to the job id", () => {
    expect(
      jobNames(`jobs:
  static-checks:
    name: Typecheck, Lint, Format
  build-and-test:
    runs-on: ubuntu-latest
`),
    ).toEqual([
      { name: "Typecheck, Lint, Format", templated: false },
      { name: "build-and-test", templated: false },
    ]);
  });

  it("marks a name carrying an expression as templated", () => {
    expect(
      jobNames(`jobs:
  probe:
    name: Probe \${{ matrix.leg }} (\${{ matrix.tag }})
`),
    ).toEqual([
      { name: "Probe ${{ matrix.leg }} (${{ matrix.tag }})", templated: true },
    ]);
  });

  it("reads no jobs from a source declaring none", () => {
    expect(jobNames("on:\n  pull_request:\n")).toEqual([]);
  });

  it("marks a nameless matrix job unmatchable rather than exposing its id", () => {
    expect(
      jobNames(`jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20]
`),
    ).toEqual([{ name: "build", templated: true }]);
  });
});

describe("workflow job index", () => {
  it("collects every workflow's literal names and separates templated ones", () => {
    withTempRoot((root) => {
      writeFileSync(
        join(root, ".github/workflows/a.yaml"),
        gatingWorkflow("Typecheck, Lint, Format"),
        "utf8",
      );
      writeFileSync(
        join(root, ".github/workflows/b.yml"),
        `jobs:
  matrix-leg:
    name: Build the \${{ matrix.variant }} image
  plain:
    name: Dependency Review
`,
        "utf8",
      );
      writeFileSync(join(root, ".github/workflows/README.md"), "not yaml\n");

      const index = workflowJobIndex(root);
      expect([...index.literal].sort()).toEqual([
        "Dependency Review",
        "Typecheck, Lint, Format",
      ]);
      expect(index.templated).toEqual([
        {
          file: ".github/workflows/b.yml",
          name: "Build the ${{ matrix.variant }} image",
        },
      ]);
    });
  });

  it("names the file when a workflow cannot be parsed", () => {
    withTempRoot((root) => {
      writeFileSync(
        join(root, ".github/workflows/broken.yaml"),
        "jobs:\n  - [unbalanced\n",
        "utf8",
      );
      expect(() => workflowJobIndex(root)).toThrow(
        /\.github\/workflows\/broken\.yaml: could not be parsed as YAML/,
      );
    });
  });
});

describe("required contexts", () => {
  it("reads the contexts out of a branch's rules, defaulting an absent app", () => {
    expect(
      branchRequiredContexts(
        "main",
        rulesWithChecks(
          requiredCheck("Typecheck, Lint, Format"),
          requiredCheck("CodeQL", 57789),
          requiredCheck("Anyone's check", null),
          { integration_id: 15368 },
        ),
      ),
    ).toEqual([
      {
        branch: "main",
        context: "Typecheck, Lint, Format",
        integrationId: GITHUB_ACTIONS_APP_ID,
      },
      { branch: "main", context: "CodeQL", integrationId: 57789 },
      { branch: "main", context: "Anyone's check", integrationId: null },
    ]);
  });

  it("reads no contexts from rules carrying no required-status-checks rule", () => {
    expect(branchRequiredContexts("main", [{ type: "deletion" }])).toEqual([]);
  });

  it("keys a context shared by both branches once, carrying both", () => {
    expect(
      mergeContexts([
        ...branchRequiredContexts("main", rulesWithChecks(requiredCheck("A"))),
        ...branchRequiredContexts(
          "staging",
          rulesWithChecks(requiredCheck("A"), requiredCheck("B")),
        ),
      ]),
    ).toEqual([
      {
        context: "A",
        integrationId: GITHUB_ACTIONS_APP_ID,
        branches: ["main", "staging"],
      },
      {
        context: "B",
        integrationId: GITHUB_ACTIONS_APP_ID,
        branches: ["staging"],
      },
    ]);
  });
});

describe("rule 1: a required context names a job", () => {
  const bothBranches = (...checks) =>
    mergeContexts(
      PROTECTED_BRANCHES.flatMap((branch) =>
        branchRequiredContexts(branch, rulesWithChecks(...checks)),
      ),
    );

  it("passes when every Actions context matches a job name", () => {
    expect(
      contextViolations(
        bothBranches(requiredCheck("Typecheck, Lint, Format")),
        indexOf("Typecheck, Lint, Format"),
      ),
    ).toEqual([]);
  });

  it("fails when the job has been renamed out from under the context", () => {
    const violations = contextViolations(
      bothBranches(requiredCheck("Typecheck, Lint, Format")),
      indexOf("Typecheck and Lint"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("main, staging: the branch rules require");
    expect(violations[0]).toContain(
      '"Typecheck, Lint, Format", which matches no job name',
    );
    expect(violations[0]).not.toContain("names no app");
  });

  it("names the templated jobs alongside a failure, since none can match", () => {
    const violations = contextViolations(bothBranches(requiredCheck("Gone")), {
      literal: new Set(),
      templated: [{ file: "wf.yaml", name: "Probe ${{ matrix.leg }}" }],
    });
    expect(violations).toHaveLength(2);
    expect(violations[1]).toContain(
      'cannot satisfy a required context here: "Probe ${{ matrix.leg }}" (wf.yaml)',
    );
  });

  it("matches no job name for a context another app raises", () => {
    const merged = bothBranches(requiredCheck("CodeQL", 57789));
    expect(contextViolations(merged, indexOf())).toEqual([]);
    expect(foreignContexts(merged)).toHaveLength(1);
  });

  it("requires a job name for a context naming no app, and says why", () => {
    const violations = contextViolations(
      bothBranches(requiredCheck("Anyone's check", null)),
      indexOf(),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("The ruleset entry names no app");
  });

  it("fails a branch whose rules carry no required status check at all", () => {
    const violations = contextViolations(
      mergeContexts(
        branchRequiredContexts("main", rulesWithChecks(requiredCheck("A"))),
      ),
      indexOf("A"),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      "staging: the branch rules carry no required status checks",
    );
  });
});

describe("rule 2: a gating workflow filters nothing", () => {
  it("reads the pull_request trigger's shape", () => {
    expect(trigger("on:\n  push:\n    branches: [main]\n")).toEqual({
      declared: false,
      filters: [],
    });
    expect(trigger("on:\n  pull_request:\n")).toEqual({
      declared: true,
      filters: [],
    });
    expect(trigger("on:\n  pull_request:\n    branches: [main]\n")).toEqual({
      declared: true,
      filters: [],
    });
    expect(
      trigger(
        "on:\n  pull_request:\n    paths: ['apps/**']\n    paths-ignore: ['docs/**']\n",
      ),
    ).toEqual({ declared: true, filters: ["paths", "paths-ignore"] });
  });

  it("reads the scalar and array trigger shorthands as declared, no filters", () => {
    expect(trigger("on: pull_request\n")).toEqual({
      declared: true,
      filters: [],
    });
    expect(trigger("on: [push, pull_request]\n")).toEqual({
      declared: true,
      filters: [],
    });
    expect(trigger("on: [push]\n")).toEqual({
      declared: false,
      filters: [],
    });
  });

  it("does not read a path filter on another event as a violation", () => {
    withTempRoot((root) => {
      writeFileSync(
        join(root, ".github/workflows/gate.yaml"),
        `on:
  pull_request:
    branches: [main]
  push:
    paths: ["apps/**"]
jobs:
  gate:
    name: Gate
`,
        "utf8",
      );
      expect(
        pathFilterViolations(root, [".github/workflows/gate.yaml"]),
      ).toEqual([]);
    });
  });

  it("fails a gating workflow that grows a paths filter", () => {
    withTempRoot((root) => {
      writeFileSync(
        join(root, ".github/workflows/gate.yaml"),
        `on:
  pull_request:
    branches: [main, staging]
    paths: ["apps/**"]
jobs:
  gate:
    name: Gate
`,
        "utf8",
      );
      const violations = pathFilterViolations(root, [
        ".github/workflows/gate.yaml",
      ]);
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(
        ".github/workflows/gate.yaml filters its pull_request trigger with paths:",
      );
    });
  });

  it("fails a gating workflow that grows a paths-ignore filter", () => {
    withTempRoot((root) => {
      writeFileSync(
        join(root, ".github/workflows/gate.yaml"),
        `on:
  pull_request:
    paths-ignore: ["docs/**"]
jobs:
  gate:
    name: Gate
`,
        "utf8",
      );
      expect(
        pathFilterViolations(root, [".github/workflows/gate.yaml"])[0],
      ).toContain("filters its pull_request trigger with paths-ignore:");
    });
  });

  it("fails a gating workflow that stops running on pull requests", () => {
    withTempRoot((root) => {
      writeFileSync(
        join(root, ".github/workflows/gate.yaml"),
        "on:\n  push:\n    branches: [main]\njobs:\n  gate:\n    name: Gate\n",
        "utf8",
      );
      expect(
        pathFilterViolations(root, [".github/workflows/gate.yaml"])[0],
      ).toContain("declares no on.pull_request trigger");
    });
  });

  it("fails a gating workflow that has moved or been deleted", () => {
    withTempRoot((root) => {
      expect(
        pathFilterViolations(root, [".github/workflows/gone.yaml"])[0],
      ).toContain("is named as a gating workflow but does not exist");
    });
  });

  // A tree carrying every workflow the real constant names, all filter-free but
  // for the one under test, run through the default `files` argument: what fails
  // is the constant's own reach rather than a list the test supplied.
  const gatingTreeWith = (file, source) =>
    withTempRoot((root) => {
      for (const named of GATING_WORKFLOWS) {
        writeFileSync(
          join(root, named),
          named === file ? source : gatingWorkflow("Gate"),
          "utf8",
        );
      }
      return pathFilterViolations(root);
    });

  it.each(GATING_WORKFLOWS)("fails %s alone for a paths filter", (file) => {
    const violations = gatingTreeWith(
      file,
      `on:
  pull_request:
    branches: [main, staging]
    paths: ["apps/**"]
jobs:
  gate:
    name: Gate
`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      `${file} filters its pull_request trigger with paths:`,
    );
  });

  it.each(GATING_WORKFLOWS)(
    "fails %s alone for a paths-ignore filter",
    (file) => {
      const violations = gatingTreeWith(
        file,
        `on:
  pull_request:
    paths-ignore: ["docs/**"]
jobs:
  gate:
    name: Gate
`,
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(
        `${file} filters its pull_request trigger with paths-ignore:`,
      );
    },
  );

  it.each(GATING_WORKFLOWS)(
    "fails %s alone for a dropped pull_request trigger",
    (file) => {
      const violations = gatingTreeWith(
        file,
        "on:\n  push:\n    branches: [main]\njobs:\n  gate:\n    name: Gate\n",
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(
        `${file} declares no on.pull_request trigger`,
      );
    },
  );
});

describe("repository resolution", () => {
  it("reads the slug out of either remote spelling", () => {
    for (const remote of [
      "git@github.com:georgetown-mdi/jspsi.git",
      "git@github.com:georgetown-mdi/jspsi",
      "https://github.com/georgetown-mdi/jspsi.git",
      "https://github.com/georgetown-mdi/jspsi/",
      "ssh://git@github.com/georgetown-mdi/jspsi.git",
      "  https://token@github.com/georgetown-mdi/jspsi.git\n",
    ]) {
      expect(parseRepositorySlug(remote)).toBe("georgetown-mdi/jspsi");
    }
  });

  it("reads no slug out of a remote naming no github.com repository", () => {
    for (const remote of [
      "git@gitlab.com:georgetown-mdi/jspsi.git",
      "/srv/git/jspsi.git",
      "https://github.com/georgetown-mdi",
      "",
      undefined,
    ]) {
      expect(parseRepositorySlug(remote)).toBeNull();
    }
  });
});

describe("the branch-rules read", () => {
  const okResponse = (body) => ({
    ok: true,
    status: 200,
    json: async () => body,
  });

  it("returns the rules and sends an authorized versioned request", async () => {
    const calls = [];
    const { rules, reason } = await fetchBranchRules({
      slug: "owner/repo",
      branch: "main",
      token: "t0ken",
      fetchImpl: async (url, init) => {
        calls.push([url, init]);
        return okResponse(rulesWithChecks(requiredCheck("A")));
      },
    });
    expect(reason).toBeNull();
    expect(branchRequiredContexts("main", rules)).toHaveLength(1);
    expect(calls[0][0]).toBe(
      "https://api.github.com/repos/owner/repo/rules/branches/main",
    );
    expect(calls[0][1].headers.authorization).toBe("Bearer t0ken");
    expect(calls[0][1].headers["x-github-api-version"]).toBe("2022-11-28");
  });

  it("reports the status rather than throwing when the token cannot read", async () => {
    const { rules, reason } = await fetchBranchRules({
      slug: "owner/repo",
      branch: "main",
      token: "t0ken",
      fetchImpl: async () => ({ ok: false, status: 403 }),
    });
    expect(rules).toBeNull();
    expect(reason).toContain("answered HTTP 403");
  });

  it("reports a transport failure rather than throwing", async () => {
    const { rules, reason } = await fetchBranchRules({
      slug: "owner/repo",
      branch: "main",
      token: "t0ken",
      fetchImpl: async () => {
        throw new Error("getaddrinfo ENOTFOUND");
      },
    });
    expect(rules).toBeNull();
    expect(reason).toContain("could not be reached");
  });

  it("reports a body that is not a rule array", async () => {
    for (const body of [{ message: "Not Found" }, "text"]) {
      const { rules, reason } = await fetchBranchRules({
        slug: "owner/repo",
        branch: "main",
        token: "t0ken",
        fetchImpl: async () => okResponse(body),
      });
      expect(rules).toBeNull();
      expect(reason).toContain("where a rule array was expected");
    }
  });

  it("reports an unparseable body", async () => {
    const { rules, reason } = await fetchBranchRules({
      slug: "owner/repo",
      branch: "main",
      token: "t0ken",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected end of JSON input");
        },
      }),
    });
    expect(rules).toBeNull();
    expect(reason).toContain("unparseable JSON");
  });
});

describe("the stated skip", () => {
  const neverCalled = async () => {
    throw new Error("the network must not be reached");
  };

  it("skips with a named reason when no token is in the environment", async () => {
    const { merged, skipped } = await readRequiredContexts({
      env: { GITHUB_REPOSITORY: "owner/repo" },
      fetchImpl: neverCalled,
    });
    expect(merged).toBeNull();
    expect(skipped).toContain("neither GH_TOKEN nor GITHUB_TOKEN is set");
  });

  it("skips with a named reason when no repository can be resolved", async () => {
    const { merged, skipped } = await readRequiredContexts({
      env: { GH_TOKEN: "t0ken" },
      cwd: tmpdir(),
      fetchImpl: neverCalled,
    });
    expect(merged).toBeNull();
    expect(skipped).toContain("GITHUB_REPOSITORY is unset");
  });

  it("skips on the first branch whose rules cannot be read", async () => {
    const branches = [];
    const { merged, skipped } = await readRequiredContexts({
      env: { GITHUB_TOKEN: "t0ken", GITHUB_REPOSITORY: "owner/repo" },
      fetchImpl: async (url) => {
        branches.push(url);
        return { ok: false, status: 404 };
      },
    });
    expect(merged).toBeNull();
    expect(skipped).toContain("answered HTTP 404");
    expect(branches).toHaveLength(1);
  });

  it("merges both branches' contexts when the read succeeds", async () => {
    const { merged, skipped } = await readRequiredContexts({
      env: { GH_TOKEN: "t0ken", GITHUB_REPOSITORY: "owner/repo" },
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => rulesWithChecks(requiredCheck("Gate")),
      }),
    });
    expect(skipped).toBeNull();
    expect(merged).toEqual([
      {
        context: "Gate",
        integrationId: GITHUB_ACTIONS_APP_ID,
        branches: PROTECTED_BRANCHES,
      },
    ]);
  });
});

describe("the real repository tree", () => {
  it("names each workflow declaring a job the merge gate requires", () => {
    expect(GATING_WORKFLOWS).toEqual([
      ".github/workflows/codeql.yaml",
      ".github/workflows/dependency_review.yaml",
      ".github/workflows/native_alpine.yaml",
      ".github/workflows/static_checks.yaml",
    ]);
  });

  it("has job names to match against, and no filter on the gating workflows", () => {
    const index = workflowJobIndex(repoRoot);
    expect(index.literal.size).toBeGreaterThan(0);
    expect(pathFilterViolations(repoRoot, GATING_WORKFLOWS)).toEqual([]);
  });

  it("exits 0 from the CLI entry point, stating the skip without a token", () => {
    const env = { ...process.env, GITHUB_ACTIONS: "true" };
    delete env.GH_TOKEN;
    delete env.GITHUB_TOKEN;
    const output = execFileSync(
      process.execPath,
      [resolve(here, "check-merge-gate-identities.mjs")],
      { encoding: "utf8", env },
    );
    expect(output).toContain("::warning title=Merge gate identities::");
    expect(output).toContain("the required-context rule was SKIPPED");
    expect(output).toContain("neither GH_TOKEN nor GITHUB_TOKEN is set");
    expect(output).toContain(
      "Path-filter rule passed: .github/workflows/codeql.yaml, .github/workflows/dependency_review.yaml, .github/workflows/native_alpine.yaml, .github/workflows/static_checks.yaml",
    );
  });
});
