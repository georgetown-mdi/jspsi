import { execFileSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { coversAction as coversName } from "./check-dependabot-ignore-shape.mjs";
import {
  coverageViolations,
  exactnessViolations,
  groupExclusionViolations,
  headingViolations,
  manifestPaths,
  npmGroups,
  packageDeclarations,
  upgradeSections,
  versionAgreementViolations,
} from "./check-dependabot-pin-coverage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const readRepo = (path) => readFileSync(resolve(repoRoot, path), "utf8");

const config = (groups) => `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    groups:
${groups}
  - package-ecosystem: docker
    directory: "/"
    groups:
      base-image:
        patterns:
          - "*"
`;

const twoNpmBlocks = (first, second) => `version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    groups:
${first}
  - package-ecosystem: npm
    directory: "/apps/web"
    groups:
${second}
`;

const group = (name, patterns, excludePatterns = [], block = 0) => ({
  block,
  name,
  patterns,
  excludePatterns,
});

describe("reading the upgrade checklists out of the pins document", () => {
  it("takes an Upgrading heading at any level and leaves every other heading", () => {
    expect(
      upgradeSections(`# Pinned dependency internals

## Why these are exact-pinned

## Upgrading the SFTP Stack (ssh2 / ssh2-sftp-client)

### Upgrading the CLI WebRTC peer (werift)

### Re-verification on a bump
`),
    ).toEqual([
      {
        heading: "Upgrading the SFTP Stack (ssh2 / ssh2-sftp-client)",
        packages: ["ssh2", "ssh2-sftp-client"],
      },
      {
        heading: "Upgrading the CLI WebRTC peer (werift)",
        packages: ["werift"],
      },
    ]);
  });

  it("separates names on the spaced slash, so a scoped name keeps its own", () => {
    expect(
      upgradeSections("## Upgrading the addon (@openmined/psi.js / uuid)\n"),
    ).toEqual([
      {
        heading: "Upgrading the addon (@openmined/psi.js / uuid)",
        packages: ["@openmined/psi.js", "uuid"],
      },
    ]);
  });

  it("reads a heading naming no package as an empty list rather than skipping it", () => {
    expect(upgradeSections("## Upgrading the SFTP Stack\n")).toEqual([
      { heading: "Upgrading the SFTP Stack", packages: [] },
    ]);
  });

  it("ignores a heading inside a fenced code sample", () => {
    expect(
      upgradeSections(`\`\`\`md
## Upgrading the example (left-pad)
\`\`\`

## Upgrading the real one (werift)
`),
    ).toEqual([
      { heading: "Upgrading the real one (werift)", packages: ["werift"] },
    ]);
  });
});

describe("the heading convention", () => {
  it("fails a section whose heading names no package, and states the form", () => {
    const violations = headingViolations([
      { heading: "Upgrading the SFTP Stack", packages: [] },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      'the "Upgrading the SFTP Stack" section names no package in its heading',
    );
    expect(violations[0]).toContain(
      "Upgrading the SFTP Stack (ssh2 / ssh2-sftp-client)",
    );
  });

  it("fails a listed token that is not an npm package name", () => {
    const violations = headingViolations([
      {
        heading: "Upgrading the SFTP Stack (ssh2 / and its client wrapper)",
        packages: ["ssh2", "and its client wrapper"],
      },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('lists "and its client wrapper"');
  });

  it("passes a heading naming plain and scoped packages", () => {
    expect(
      headingViolations([
        {
          heading: "Upgrading things (ssh2-sftp-client / @openmined/psi.js)",
          packages: ["ssh2-sftp-client", "@openmined/psi.js"],
        },
      ]),
    ).toEqual([]);
  });
});

describe("reading the npm groups out of the config", () => {
  it("takes the npm block's groups, not another ecosystem's", () => {
    expect(
      npmGroups(
        config(`      webrtc-stack:
        patterns:
          - "peerjs"
          - "werift"`),
      ),
    ).toEqual([group("webrtc-stack", ["peerjs", "werift"])]);
  });

  it("reads a group declaring no patterns as matching everything", () => {
    expect(
      npmGroups(
        config(`      non-critical:
        update-types:
          - "minor"
        exclude-patterns:
          - "werift"`),
      ),
    ).toEqual([group("non-critical", ["*"], ["werift"])]);
  });

  it("reads a group declaring no exclude-patterns as excluding nothing", () => {
    expect(
      npmGroups(
        config(`      everything:
        patterns:
          - "*"`),
      ),
    ).toEqual([group("everything", ["*"])]);
  });

  it("returns null when no npm block matched, so the CLI can fail closed", () => {
    expect(
      npmGroups(`version: 2
updates:
  - package-ecosystem: github-actions
    directory: "/"
`),
    ).toBeNull();
    expect(npmGroups("version: 2\n")).toBeNull();
  });

  it("reads an npm block declaring no groups as no groups at all", () => {
    expect(
      npmGroups(`version: 2
updates:
  - package-ecosystem: npm
    directory: "/"
    open-pull-requests-limit: 10
`),
    ).toEqual([]);
  });

  it("numbers the block each group came from, so a rule can scope to one", () => {
    expect(
      npmGroups(
        twoNpmBlocks(
          `      cryptographic:
        patterns:
          - "ssh2"`,
          `      web-non-critical:
        patterns:
          - "*"`,
        ),
      ),
    ).toEqual([
      group("cryptographic", ["ssh2"], [], 0),
      group("web-non-critical", ["*"], [], 1),
    ]);
  });
});

describe("a checklist package a group would swallow", () => {
  it("fails when a catch-all group does not exclude it", () => {
    const violations = coverageViolations(
      ["werift"],
      [group("non-critical", ["*"], ["peerjs"])],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      'carries an "Upgrading ..." checklist for werift',
    );
    expect(violations[0]).toContain(
      'the npm group "non-critical" in .github/dependabot.yml matches it through pattern "*"',
    );
    expect(violations[0]).toContain(
      'Add "werift" to that group\'s exclude-patterns',
    );
  });

  it("passes when the group excludes it by name", () => {
    expect(
      coverageViolations(
        ["werift"],
        [group("non-critical", ["*"], ["peerjs", "werift"])],
      ),
    ).toEqual([]);
  });

  it("passes when a wildcard exclude covers it", () => {
    expect(
      coverageViolations(["werift"], [group("non-critical", ["*"], ["wer*"])]),
    ).toEqual([]);
  });

  it("passes when the group names it in its patterns, its reviewed treatment", () => {
    expect(
      coverageViolations(
        ["werift"],
        [group("webrtc-stack", ["peerjs", "werift"])],
      ),
    ).toEqual([]);
  });

  it("passes when the group's patterns cannot reach it", () => {
    expect(
      coverageViolations(
        ["werift"],
        [group("cryptographic", ["ssh2", "node-forge"])],
      ),
    ).toEqual([]);
  });

  it("fails a wildcard group that reaches it without naming it", () => {
    const violations = coverageViolations(
      ["werift"],
      [group("w-packages", ["w*"])],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('through pattern "w*"');
  });

  it("reports each swallowing group once", () => {
    expect(
      coverageViolations(
        ["werift", "peerjs"],
        [
          group("non-critical", ["*"]),
          group("also-everything", ["*"]),
          group("webrtc-stack", ["peerjs", "werift"]),
        ],
      ),
    ).toHaveLength(4);
  });
});

describe("a group-named package another group would swallow", () => {
  it("passes when every group-named package is excluded from the catch-all", () => {
    expect(
      groupExclusionViolations([
        group("cryptographic", ["ssh2", "node-forge"]),
        group("non-critical", ["*"], ["ssh2", "node-forge"]),
      ]),
    ).toEqual([]);
  });

  it("fails naming the package, the naming group, and the group missing the exclusion", () => {
    const violations = groupExclusionViolations([
      group("cryptographic", ["ssh2", "node-forge"]),
      group("non-critical", ["*"], ["ssh2"]),
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("node-forge");
    expect(violations[0]).toContain('npm group "cryptographic"');
    expect(violations[0]).toContain('npm group "non-critical"');
    expect(violations[0]).toContain('through pattern "*"');
  });

  it("passes when the swallowing group names the package in its own patterns too", () => {
    expect(
      groupExclusionViolations([
        group("cryptographic", ["ssh2"]),
        group("also-crypto", ["ssh2"]),
      ]),
    ).toEqual([]);
  });

  it("passes when no other group's patterns can reach the package", () => {
    expect(
      groupExclusionViolations([
        group("cryptographic", ["ssh2"]),
        group("webrtc-stack", ["peerjs", "werift"]),
      ]),
    ).toEqual([]);
  });

  it("passes when a wildcard exclude-patterns entry covers it", () => {
    expect(
      groupExclusionViolations([
        group("cryptographic", ["ssh2"]),
        group("non-critical", ["*"], ["ss*"]),
      ]),
    ).toEqual([]);
  });

  it("reports one violation per swallowing group when several would batch it", () => {
    const violations = groupExclusionViolations([
      group("cryptographic", ["ssh2"]),
      group("non-critical", ["*"]),
      group("also-everything", ["*"]),
    ]);
    expect(violations).toHaveLength(2);
  });

  it("treats a bare * patterns entry as naming no package", () => {
    expect(
      groupExclusionViolations([
        group("non-critical", ["*"]),
        group("also-everything", ["*"]),
      ]),
    ).toEqual([]);
  });

  it("leaves a catch-all in another update block alone, batching separately", () => {
    expect(
      groupExclusionViolations(
        npmGroups(
          twoNpmBlocks(
            `      cryptographic:
        patterns:
          - "ssh2"`,
            `      web-non-critical:
        patterns:
          - "*"`,
          ),
        ),
      ),
    ).toEqual([]);
  });

  it("fails that same pair of groups when one update block declares both", () => {
    const violations = groupExclusionViolations(
      npmGroups(
        config(`      cryptographic:
        patterns:
          - "ssh2"
      web-non-critical:
        patterns:
          - "*"`),
      ),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("ssh2");
    expect(violations[0]).toContain('npm group "cryptographic"');
    expect(violations[0]).toContain('npm group "web-non-critical"');
  });

  it("throws on a group pattern carrying a glob beyond the bare * default", () => {
    expect(() =>
      groupExclusionViolations([
        group("scoped", ["@openmined/*"]),
        group("non-critical", ["*"]),
      ]),
    ).toThrow(/glob shape/);
  });
});

describe("finding the manifests to read", () => {
  const expand = (glob) =>
    ({
      "apps/*/package.json": ["apps/cli/package.json", "apps/web/package.json"],
      "packages/*/package.json": ["packages/core/package.json"],
    })[glob] ?? [];

  it("puts the root manifest first and sorts what the globs reach", () => {
    expect(
      manifestPaths({ workspaces: ["packages/*", "apps/*"] }, expand),
    ).toEqual([
      "package.json",
      "apps/cli/package.json",
      "apps/web/package.json",
      "packages/core/package.json",
    ]);
  });

  it("normalizes a Windows separator and keeps the root listed once", () => {
    expect(
      manifestPaths({ workspaces: ["apps/*", "."] }, (glob) =>
        glob === "./package.json"
          ? ["package.json"]
          : ["apps\\cli\\package.json", "apps\\cli\\package.json"],
      ),
    ).toEqual(["package.json", "apps/cli/package.json"]);
  });

  it("returns null on a workspaces field it cannot read, so the CLI fails closed", () => {
    expect(manifestPaths({}, expand)).toBeNull();
    expect(
      manifestPaths({ workspaces: { packages: ["apps/*"] } }, expand),
    ).toBeNull();
    expect(manifestPaths({ workspaces: ["apps/*", 7] }, expand)).toBeNull();
  });
});

describe("reading the declarations out of the manifests", () => {
  const manifests = [
    {
      path: "package.json",
      manifest: { devDependencies: { vitest: "^4.1.9" } },
    },
    {
      path: "apps/cli/package.json",
      manifest: {
        dependencies: { ssh2: "1.17.0", loglevel: "^1.9.2" },
        devDependencies: { "@types/ssh2": "~1.15.5" },
        optionalDependencies: { werift: "0.24.4" },
      },
    },
  ];

  it("takes every dependency field, carrying the manifest and field", () => {
    expect(packageDeclarations(["ssh2", "werift"], manifests)).toEqual([
      {
        path: "apps/cli/package.json",
        field: "dependencies",
        name: "ssh2",
        specifier: "1.17.0",
      },
      {
        path: "apps/cli/package.json",
        field: "optionalDependencies",
        name: "werift",
        specifier: "0.24.4",
      },
    ]);
  });

  it("matches a package by its whole name, so @types/ssh2 is not ssh2", () => {
    expect(packageDeclarations(["@types/ssh2"], manifests)).toEqual([
      {
        path: "apps/cli/package.json",
        field: "devDependencies",
        name: "@types/ssh2",
        specifier: "~1.15.5",
      },
    ]);
  });

  it("reads a manifest declaring no dependencies at all", () => {
    expect(
      packageDeclarations(["ssh2"], [{ path: "packages/x/package.json" }]),
    ).toEqual([]);
  });
});

describe("a checklist package's pin exactness", () => {
  const declaration = (specifier, name = "werift") => ({
    path: "apps/cli/package.json",
    field: "dependencies",
    name,
    specifier,
  });

  it("passes a bare version, with a prerelease or build suffix among them", () => {
    expect(
      exactnessViolations(
        ["werift"],
        [
          declaration("0.24.4"),
          declaration("1.0.0-rc.1"),
          declaration("1.0.0+20260826"),
        ],
      ),
    ).toEqual([]);
  });

  it("fails a range, naming the manifest, the field, and the specifier", () => {
    const violations = exactnessViolations(
      ["werift"],
      [declaration("^0.24.4")],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      'apps/cli/package.json (dependencies) declares werift as "^0.24.4"',
    );
    expect(violations[0]).toContain("not a bare major.minor.patch version");
  });

  it("fails every other specifier shape, pinning route or not", () => {
    const specifiers = [
      "~0.24.4",
      ">=0.24.4",
      "0.24.x",
      "*",
      "latest",
      "=0.24.4",
      "0.24.4 || 0.25.0",
      "file:../../vendor/werift.tgz",
      "npm:werift@0.24.4",
      "github:shinyoshiaki/werift-webrtc#v0.24.4",
      "",
    ];
    expect(
      exactnessViolations(
        ["werift"],
        specifiers.map((specifier) => declaration(specifier)),
      ),
    ).toHaveLength(specifiers.length);
  });

  it("reports each inexact declaration of the same package", () => {
    expect(
      exactnessViolations(
        ["peerjs-js-binarypack"],
        [
          declaration("2.1.0", "peerjs-js-binarypack"),
          { ...declaration("^2.1.0", "peerjs-js-binarypack"), path: "a.json" },
          { ...declaration("^2.1.0", "peerjs-js-binarypack"), path: "b.json" },
        ],
      ),
    ).toHaveLength(2);
  });

  it("fails a checklist package no manifest declares", () => {
    const violations = exactnessViolations(
      ["werift", "ssh2"],
      [declaration("0.24.4")],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      'carries an "Upgrading ..." checklist for ssh2, but no manifest in this workspace declares it',
    );
  });
});

describe("a checklist package's one version across the manifests", () => {
  const declaration = (path, specifier, name = "peerjs-js-binarypack") => ({
    path,
    field: "dependencies",
    name,
    specifier,
  });

  it("fails two manifests pinning different versions, listing both", () => {
    const violations = versionAgreementViolations(
      ["werift"],
      [
        declaration("apps/cli/package.json", "0.24.4", "werift"),
        declaration("apps/web/package.json", "0.25.0", "werift"),
      ],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      "This workspace declares werift at 2 different versions",
    );
    expect(violations[0]).toContain(
      'apps/cli/package.json (dependencies) "0.24.4"',
    );
    expect(violations[0]).toContain(
      'apps/web/package.json (dependencies) "0.25.0"',
    );
  });

  it("passes one version declared by every manifest", () => {
    expect(
      versionAgreementViolations(
        ["peerjs-js-binarypack"],
        [
          declaration("apps/cli/package.json", "2.1.0"),
          declaration("apps/web/package.json", "2.1.0"),
          declaration("packages/core/package.json", "2.1.0"),
          declaration("packages/testkit/package.json", "2.1.0"),
        ],
      ),
    ).toEqual([]);
  });

  it("passes a package one manifest declares, and one none declares", () => {
    expect(
      versionAgreementViolations(
        ["peerjs-js-binarypack", "ssh2"],
        [declaration("apps/cli/package.json", "2.1.0")],
      ),
    ).toEqual([]);
  });

  it("fails two fields of one manifest disagreeing", () => {
    const violations = versionAgreementViolations(
      ["peerjs-js-binarypack"],
      [
        declaration("apps/cli/package.json", "2.1.0"),
        {
          ...declaration("apps/cli/package.json", "2.0.0"),
          field: "devDependencies",
        },
      ],
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(
      'apps/cli/package.json (devDependencies) "2.0.0"',
    );
  });

  it("reports one violation per package, not one per disagreeing pair", () => {
    expect(
      versionAgreementViolations(
        ["peerjs-js-binarypack", "werift"],
        [
          declaration("a/package.json", "2.1.0"),
          declaration("b/package.json", "2.2.0"),
          declaration("c/package.json", "2.3.0"),
          declaration("a/package.json", "0.24.4", "werift"),
          declaration("b/package.json", "0.25.0", "werift"),
        ],
      ),
    ).toHaveLength(2);
  });
});

describe("the real repository configuration", () => {
  const sections = () =>
    upgradeSections(readRepo("docs/spec/DEPENDENCY_PINS.md"));
  const packages = () => [
    ...new Set(sections().flatMap(({ packages }) => packages)),
  ];
  const groups = () => npmGroups(readRepo(".github/dependabot.yml"));
  const readJson = (path) => JSON.parse(readRepo(path));
  const paths = () =>
    manifestPaths(readJson("package.json"), (glob) =>
      globSync(glob, { cwd: repoRoot }),
    );
  const declarations = () =>
    packageDeclarations(
      packages(),
      paths().map((path) => ({ path, manifest: readJson(path) })),
    );

  it("names its packages in every upgrade-checklist heading", () => {
    expect(sections().length).toBeGreaterThan(0);
    expect(headingViolations(sections())).toEqual([]);
  });

  it("holds every checklist package out of the groups that would batch it", () => {
    expect(groups()).not.toBeNull();
    expect(coverageViolations(packages(), groups())).toEqual([]);
  });

  it("holds every group-named package out of every other group's batch", () => {
    expect(groupExclusionViolations(groups())).toEqual([]);
  });

  it.each(["@noble/curves", "@openmined/psi.js", "node-forge"])(
    "fails when %s is dropped from non-critical's exclude-patterns, and passes restored",
    (name) => {
      const withoutExclusion = groups().map((candidate) =>
        candidate.name === "non-critical"
          ? {
              ...candidate,
              excludePatterns: candidate.excludePatterns.filter(
                (pattern) => pattern !== name,
              ),
            }
          : candidate,
      );
      const violations = groupExclusionViolations(withoutExclusion);
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.some((violation) => violation.includes(name))).toBe(
        true,
      );
      expect(
        violations.some((violation) => violation.includes('"non-critical"')),
      ).toBe(true);
      // Restoring the untouched real config -- groups() re-reads the file, so
      // withoutExclusion above never mutated it -- passes again.
      expect(groupExclusionViolations(groups())).toEqual([]);
    },
  );

  it("fails when a new name joins cryptographic's patterns with no matching exclusion", () => {
    const withNewPattern = groups().map((candidate) =>
      candidate.name === "cryptographic"
        ? { ...candidate, patterns: [...candidate.patterns, "left-pad"] }
        : candidate,
    );
    const violations = groupExclusionViolations(withNewPattern);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("left-pad");
    expect(violations[0]).toContain('npm group "cryptographic"');
    expect(violations[0]).toContain('npm group "non-critical"');
  });

  it("has a group that would swallow a checklist package, so the green above is not vacuous", () => {
    const swallowing = groups().filter((candidate) =>
      packages().some(
        (name) =>
          !candidate.patterns.includes(name) &&
          candidate.patterns.some((pattern) => coversName(pattern, name)),
      ),
    );
    expect(swallowing.length).toBeGreaterThan(0);
  });

  it("gives werift the WebRTC treatment: grouped for review, out of the batch", () => {
    expect(packages()).toContain("werift");
    const npmBlock = parse(readRepo(".github/dependabot.yml")).updates.find(
      (block) => block["package-ecosystem"] === "npm",
    );
    expect(npmBlock.groups["webrtc-stack"].patterns).toContain("werift");
    expect(npmBlock.groups["non-critical"]["exclude-patterns"]).toContain(
      "werift",
    );
  });

  it("enumerates the manifests npm itself recorded as this workspace's", () => {
    const lock = JSON.parse(readRepo("package-lock.json"));
    const recorded = Object.keys(lock.packages)
      .filter((path) => !path.includes("node_modules/"))
      .map((path) => (path === "" ? "package.json" : `${path}/package.json`))
      .sort();
    expect(recorded.length).toBeGreaterThan(1);
    expect([...paths()].sort()).toEqual(recorded);
  });

  it("declares every checklist package at an exact version", () => {
    expect(exactnessViolations(packages(), declarations())).toEqual([]);
  });

  it("sweeps declarations in more than one manifest, so the green is not one file's", () => {
    const swept = declarations();
    expect(new Set(swept.map(({ name }) => name))).toEqual(new Set(packages()));
    expect(new Set(swept.map(({ path }) => path)).size).toBeGreaterThan(1);
  });

  it("reddens on a range where an exact version stands", () => {
    const [first, ...rest] = declarations();
    const violations = exactnessViolations(packages(), [
      { ...first, specifier: `^${first.specifier}` },
      ...rest,
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(first.path);
  });

  it("declares every checklist package at one version wherever it appears", () => {
    expect(versionAgreementViolations(packages(), declarations())).toEqual([]);
  });

  it("reddens when a package several manifests declare drifts in one", () => {
    const swept = declarations();
    const shared = packages().filter(
      (name) => swept.filter((entry) => entry.name === name).length > 1,
    );
    expect(shared.length).toBeGreaterThan(0);
    for (const name of shared) {
      const at = swept.findIndex((entry) => entry.name === name);
      const violations = versionAgreementViolations(
        packages(),
        swept.map((entry, index) =>
          index === at
            ? { ...entry, specifier: `${entry.specifier}-drift` }
            : entry,
        ),
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain(name);
      expect(violations[0]).toContain(swept[at].path);
      expect(violations[0]).toContain(`${swept[at].specifier}-drift`);
    }
  });

  it("leaves the inexact @types siblings of a checklist package alone", () => {
    const cli = JSON.parse(readRepo("apps/cli/package.json"));
    expect(cli.devDependencies["@types/ssh2"]).not.toMatch(/^\d/);
    expect(packages()).toContain("ssh2");
    expect(packages()).not.toContain("@types/ssh2");
    expect(declarations().map(({ name }) => name)).not.toContain("@types/ssh2");
  });

  it("exits 0 from the CLI entry point", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(here, "check-dependabot-pin-coverage.mjs")],
      { encoding: "utf8" },
    );
    expect(output).toContain("Dependabot checklist-pin coverage check passed");
  });
});
