import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { coversAction as coversName } from "./check-dependabot-ignore-shape.mjs";
import {
  coverageViolations,
  headingViolations,
  npmGroups,
  upgradeSections,
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

const group = (name, patterns, excludePatterns = []) => ({
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

describe("the real repository configuration", () => {
  const sections = () =>
    upgradeSections(readRepo("docs/spec/DEPENDENCY_PINS.md"));
  const packages = () => [
    ...new Set(sections().flatMap(({ packages }) => packages)),
  ];
  const groups = () => npmGroups(readRepo(".github/dependabot.yml"));

  it("names its packages in every upgrade-checklist heading", () => {
    expect(sections().length).toBeGreaterThan(0);
    expect(headingViolations(sections())).toEqual([]);
  });

  it("holds every checklist package out of the groups that would batch it", () => {
    expect(groups()).not.toBeNull();
    expect(coverageViolations(packages(), groups())).toEqual([]);
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

  it("exits 0 from the CLI entry point", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(here, "check-dependabot-pin-coverage.mjs")],
      { encoding: "utf8" },
    );
    expect(output).toContain("Dependabot checklist-pin coverage check passed");
  });
});
