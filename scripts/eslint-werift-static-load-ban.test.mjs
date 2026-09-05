import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Coverage of the werift static-load ban in the repo-root eslint.config.mjs:
// werift is loaded only at the point of use (the deferred import in
// apps/cli/src/connection/webrtc/weriftPeer.ts), never through a static
// import or a static re-export, because the CLI bundles to one CommonJS file
// whose external requires all run at startup -- a static load would put
// werift's cost on every invocation, `psilink --version` included, for a
// channel most runs never open. The ban is three esquery selectors sharing
// one message (an ImportDeclaration, an ExportNamedDeclaration, and an
// ExportAllDeclaration, each keyed on the werift specifier), and a selector
// that stops matching fails silently: it keeps reporting zero problems,
// indistinguishable from clean source. These cases are what makes its
// coverage executable.
//
// Each case is linted through the real repo config against a path inside the
// guarded tree (apps/cli/src), so the scope, the selectors, and the rule
// wiring are all exercised as CI runs them rather than restated here.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: resolve(repoRoot, "eslint.config.mjs"),
});

/**
 * no-restricted-syntax messages the werift static-load ban reports for
 * `source` linted as `filePath`. A source that does not parse throws rather
 * than counting as zero problems.
 */
async function banHits(filePath, source) {
  const [result] = await eslint.lintText(source, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`${filePath}: ${fatal.map((m) => m.message).join("; ")}`);
  }
  return result.messages.filter(
    (message) =>
      message.ruleId === "no-restricted-syntax" &&
      message.message.startsWith("Import or re-export werift lazily"),
  );
}

const CLI_FILE = resolve(repoRoot, "apps/cli/src/weriftBanFixture.ts");
// Outside the ban's `files: ["apps/cli/src/**/*.ts"]` scope, but still inside
// apps/cli, so a case here proves the scoping rather than a different tree's
// own boundary rules.
const OUT_OF_SCOPE_FILE = resolve(
  repoRoot,
  "apps/cli/test/unit/weriftBanFixture.ts",
);

// Loading the flat config and the typescript-eslint parser for the first time
// is the expensive part of a lintText call, independent of which file or how
// much text it is given; under cold process/CPU load that one-time cost alone
// can exceed vitest's 5s test default. A beforeAll-shaped warm-up would work
// too, but a per-suite timeout keeps every case's own assertion visible on a
// slow run instead of failing the whole suite at one hook.
const LINT_TIMEOUT_MS = 30_000;

const FLAGGED = [
  ["a bare value import", 'import { RTCPeerConnection } from "werift";'],
  ["a subpath value import", 'import { Something } from "werift/nonstandard";'],
  [
    "a bare named value re-export",
    'export { RTCPeerConnection } from "werift";',
  ],
  [
    "a subpath named value re-export",
    'export { Something } from "werift/nonstandard";',
  ],
  ["a bare `export *`", 'export * from "werift";'],
  ["a subpath `export *`", 'export * from "werift/nonstandard";'],
  [
    "a mixed named re-export (one type, one value specifier)",
    'export { type A, B } from "werift";',
  ],
];

const EXEMPT = [
  ["a type-only import", 'import type { RTCPeerConnection } from "werift";'],
  [
    "a type-only named re-export (whole declaration)",
    'export type { RTCPeerConnection } from "werift";',
  ],
  [
    "a type-only named re-export (per-specifier)",
    'export { type RTCPeerConnection } from "werift";',
  ],
  ["a type-only `export *`", 'export type * from "werift";'],
  ["a type-only `export * as ns`", 'export type * as ns from "werift";'],
  [
    "a deferred dynamic import",
    'export async function load() {\n  const werift = await import("werift");\n  return werift;\n}',
  ],
  ["a near-miss specifier (weriftfoo)", 'import { X } from "weriftfoo";'],
  ["a near-miss specifier (not-werift)", 'import { X } from "not-werift";'],
];

describe("the werift static-load ban", { timeout: LINT_TIMEOUT_MS }, () => {
  for (const [label, source] of FLAGGED) {
    it(`rejects ${label}`, async () => {
      expect(await banHits(CLI_FILE, `${source}\n`)).not.toHaveLength(0);
    });
  }

  for (const [label, source] of EXEMPT) {
    it(`accepts ${label}`, async () => {
      expect(await banHits(CLI_FILE, `${source}\n`)).toHaveLength(0);
    });
  }

  it("does not reach outside apps/cli/src", async () => {
    expect(
      await banHits(
        OUT_OF_SCOPE_FILE,
        'import { RTCPeerConnection } from "werift";\n',
      ),
    ).toHaveLength(0);
  });
});
