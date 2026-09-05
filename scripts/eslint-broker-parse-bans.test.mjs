import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { afterAll, describe, expect, it } from "vitest";

import eslintConfig from "../eslint.config.mjs";

// Coverage of the parse bans the repo-root eslint.config.mjs carries over
// packages/peerjs-broker/src: untrusted JSON is decoded through @psilink/core's
// parseBoundedJson, and a secret-bearing document through the same package's
// sensitive-parse chokepoint. This is the tree with an unauthenticated adversary
// in front of it -- the signaling socket parses whatever an internet client
// sends, and the abort a pathological body reaches is uncatchable -- so a ban
// that quietly stops matching here costs more than it would anywhere else.
//
// A ban fails silently: a `files` pattern or an object/property name that stops
// matching keeps reporting zero problems, which reads exactly like clean source.
// The shapes it does NOT catch are pinned below as well, so its reach is a
// measured property rather than an assumption a reader makes from the rule text.
// The vendored subtree the repo-wide ignores leave unlinted is outside every one
// of these bans, so its files are scanned here with the bans themselves: a parse
// added there fails this test rather than passing unnoticed.
//
// The raw-error-at-sink ban is the broker's third, and its tree coverage sits
// with that ban's other cases in eslint-display-sink-ban.test.mjs.

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const eslint = new ESLint({
  cwd: repoRoot,
  overrideConfigFile: resolve(repoRoot, "eslint.config.mjs"),
});

// A path inside the guarded tree. The bans are scoped by `files` pattern, so the
// text each case hands in is linted as though it sat here; the path needs no
// file behind it.
const BROKER_SRC = resolve(
  repoRoot,
  "packages/peerjs-broker/src/banFixture.ts",
);

// Upstream's unedited message routing, which the repo-wide ignores keep out of
// linting altogether so its history against upstream stays readable.
const BROKER_VENDORED = resolve(
  repoRoot,
  "packages/peerjs-broker/src/contrib/messageHandler/banFixture.ts",
);

// A guarded path that exists on disk and parses, reserved for the canary.
const BROKER_FIRST_PARSE = resolve(
  repoRoot,
  "packages/peerjs-broker/src/standalone.ts",
);

// The broker paths the repo-wide ignores keep out of linting, read from the
// config rather than restated, so widening or narrowing the ignores moves the
// scan below with them.
const IGNORED_BROKER_PATTERNS = eslintConfig
  .filter((config) => config.ignores && !config.files)
  .flatMap((config) => config.ignores)
  .filter((pattern) => pattern.startsWith("packages/peerjs-broker/"));

/**
 * Messages `ruleId` reports for `source` linted as `filePath`, narrowed to those
 * whose text starts with `messagePrefix` when one is given -- a rule this tree
 * loads several bans into reports them all under the one id. A source that does
 * not parse throws rather than reading as zero problems.
 */
async function banHits(filePath, source, ruleId, messagePrefix = "") {
  const [result] = await eslint.lintText(source, { filePath });
  const fatal = result.messages.filter((message) => message.fatal);
  if (fatal.length > 0) {
    throw new Error(`${filePath}: ${fatal.map((m) => m.message).join("; ")}`);
  }
  return result.messages.filter(
    (message) =>
      message.ruleId === ruleId && message.message.startsWith(messagePrefix),
  );
}

const PREAMBLE = `
declare const YAML: {
  parse(text: string): unknown;
  parseDocument(text: string): unknown;
  parseAllDocuments(text: string): unknown;
};
declare function parseBoundedJson(text: string): unknown;
declare const text: string;
export function fixture(): unknown {
`;

function fixture(body) {
  return `${PREAMBLE}  ${body}\n}\n`;
}

/**
 * The message text of the three parse bans as they resolve for the guarded
 * broker tree: the JSON.parse property ban, the YAML call ban, and the yaml
 * named-import ban. Taken from the resolved config so a reworded ban stays
 * detectable, and so a ban that stopped resolving fails the count assertion
 * rather than turning the scan into a no-op.
 */
async function parseBanMessages() {
  const config = await eslint.calculateConfigForFile(BROKER_SRC);
  const entriesOf = (ruleId) => (config.rules[ruleId] ?? []).slice(1);
  return [
    ...entriesOf("no-restricted-properties").filter(
      (entry) => entry.object === "JSON" && entry.property === "parse",
    ),
    ...entriesOf("no-restricted-syntax").filter((entry) =>
      entry.selector?.includes("YAML"),
    ),
    ...entriesOf("no-restricted-imports")
      .flatMap((entry) => entry.paths ?? [])
      .filter((entry) => entry.name === "yaml"),
  ].map((entry) => entry.message);
}

/** Every `.ts` file the ignore `pattern` covers, resolved against `root`. */
function typeScriptFilesUnder(root, pattern) {
  const bare = pattern.replace(/\/\*\*$/, "");
  if (bare.includes("*")) {
    throw new Error(
      `${pattern}: this scan expands a directory or a file path, not a glob; teach it the new shape rather than dropping the path`,
    );
  }
  const target = resolve(root, bare);
  if (!statSync(target).isDirectory()) {
    return target.endsWith(".ts") ? [target] : [];
  }
  return readdirSync(target, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => resolve(entry.parentPath, entry.name))
    .sort();
}

/**
 * The lint-ignored broker files under `root` that hold a banned parse, each as a
 * path relative to `root`. Every file is linted as though it sat at a guarded
 * path, so what this flags is exactly what the bans refuse -- the four JSON.parse
 * shapes, a YAML parse call, and a yaml named import -- rather than a second
 * matcher that could drift from them.
 */
async function bannedParsesUnderIgnoredPaths(root) {
  const banMessages = await parseBanMessages();
  expect(
    banMessages,
    "the JSON.parse, YAML call and yaml named-import bans no longer all resolve for the broker tree, so this scan would flag nothing",
  ).toHaveLength(3);
  const found = [];
  for (const pattern of IGNORED_BROKER_PATTERNS) {
    for (const file of typeScriptFilesUnder(root, pattern)) {
      const [result] = await eslint.lintText(readFileSync(file, "utf8"), {
        filePath: BROKER_SRC,
      });
      const fatal = result.messages.filter((message) => message.fatal);
      if (fatal.length > 0) {
        throw new Error(`${file}: ${fatal.map((m) => m.message).join("; ")}`);
      }
      const hit = result.messages.some((message) =>
        banMessages.some((text) => message.message.endsWith(text)),
      );
      if (hit) found.push(relative(root, file));
    }
  }
  return found.sort();
}

function yamlCall(parser) {
  return `declare const YAML: { ${parser}(text: string): unknown };\nexport const parsed: unknown = YAML.${parser}("a: 1");\n`;
}

// One planted file per shape the bans catch, laid out under the same ignored
// paths so the scan reaches them by the same walk it uses on the repository.
const PLANTED_FILES = {
  "packages/peerjs-broker/src/contrib/messageHandler/direct.ts":
    'export const parsed: unknown = JSON.parse("{}");\n',
  "packages/peerjs-broker/src/contrib/messageHandler/alias.ts":
    "export const parse = JSON.parse;\n",
  "packages/peerjs-broker/src/contrib/messageHandler/computed.ts":
    'export const parsed: unknown = JSON["parse"]("{}");\n',
  "packages/peerjs-broker/src/contrib/messageHandler/handlers/destructure.ts":
    "const { parse } = JSON;\nexport const parsed: unknown = parse;\n",
  "packages/peerjs-broker/src/contrib/messageHandler/handlers/yamlParse.ts":
    yamlCall("parse"),
  "packages/peerjs-broker/src/contrib/messageHandler/handlers/yamlDocument.ts":
    yamlCall("parseDocument"),
  "packages/peerjs-broker/src/contrib/messageHandler/handlers/yamlDocuments.ts":
    yamlCall("parseAllDocuments"),
  "packages/peerjs-broker/src/contrib/messageHandler/handlers/yamlImport.ts":
    'import { parse } from "yaml";\n\nexport const parsed: unknown = parse("a: 1");\n',
  "packages/peerjs-broker/src/contrib/models/message.ts":
    'export const parsed: unknown = JSON.parse("{}");\n',
};

// The one planted file the scan must leave alone, so a case where it flags
// everything cannot pass as a case where it flags the right files.
const PLANTED_CLEAN =
  "packages/peerjs-broker/src/contrib/messageHandler/handlers/bounded.ts";

let plantedRoot;

// Loading the flat config and the typescript-eslint parser for the first time is
// the expensive part of a lintText call, independent of which file or how much
// text it is given; under cold process or CPU load that one-time cost alone can
// outrun the default per-test timeout on a CI runner.
describe("the broker parse bans", { timeout: 60_000 }, () => {
  afterAll(() => {
    if (plantedRoot) rmSync(plantedRoot, { recursive: true, force: true });
  });

  it("lints the text it is handed, not the file on disk", async () => {
    expect(
      existsSync(BROKER_FIRST_PARSE),
      `${BROKER_FIRST_PARSE} no longer exists`,
    ).toBe(true);
    const [result] = await eslint.lintText("this is not typescript !!! (((\n", {
      filePath: BROKER_FIRST_PARSE,
    });
    expect(
      result.messages.map((message) => message.message).join("; "),
      `${BROKER_FIRST_PARSE}: the source on disk was linted instead, so a case asserting zero problems proves nothing about the text it handed in`,
    ).toMatch(/Parsing error/);
  });

  it("resolves the JSON.parse ban for the broker tree", async () => {
    const config = await eslint.calculateConfigForFile(BROKER_SRC);
    const [, ...entries] = config.rules["no-restricted-properties"] ?? [];
    expect(
      entries.some(
        (entry) => entry.object === "JSON" && entry.property === "parse",
      ),
      `${BROKER_SRC}: the resolved no-restricted-properties options do not carry the JSON.parse ban, so linting it reports zero however the parse is written`,
    ).toBe(true);
  });

  for (const [shape, body] of [
    ["a direct call", 'return JSON.parse("{}");'],
    ["an alias", "return JSON.parse;"],
    ["a computed access", 'return JSON["parse"]("{}");'],
    ["a destructure", "const { parse } = JSON;\n  return parse;"],
  ]) {
    it(`refuses ${shape} of JSON.parse`, async () => {
      expect(
        await banHits(BROKER_SRC, fixture(body), "no-restricted-properties"),
      ).not.toHaveLength(0);
    });
  }

  // The reach the syntactic form does not have: both need value-flow analysis,
  // and both are left to review, exactly as the identical ban over
  // packages/core/src states of itself.
  for (const [shape, body] of [
    ["a renamed JSON object", 'const J = JSON;\n  return J.parse("{}");'],
    ["a globalThis access", 'return globalThis.JSON.parse("{}");'],
  ]) {
    it(`does not reach ${shape}`, async () => {
      expect(
        await banHits(BROKER_SRC, fixture(body), "no-restricted-properties"),
      ).toHaveLength(0);
    });
  }

  it("leaves the bounded chokepoint and JSON.stringify alone", async () => {
    for (const body of [
      "return parseBoundedJson(text);",
      "return JSON.stringify({});",
    ]) {
      expect(
        await banHits(BROKER_SRC, fixture(body), "no-restricted-properties"),
      ).toHaveLength(0);
    }
  });

  for (const parser of ["parse", "parseDocument", "parseAllDocuments"]) {
    it(`refuses YAML.${parser}`, async () => {
      expect(
        await banHits(
          BROKER_SRC,
          fixture(`return YAML.${parser}(text);`),
          "no-restricted-syntax",
          "Parse operator/credential files",
        ),
      ).not.toHaveLength(0);
    });

    it(`refuses a named '${parser}' import from yaml`, async () => {
      expect(
        await banHits(
          BROKER_SRC,
          `import { ${parser} } from "yaml";\n\nexport const parsed = ${parser}("a: 1");\n`,
          "no-restricted-imports",
        ),
      ).not.toHaveLength(0);
    });
  }

  it("does not reach the vendored message routing", async () => {
    expect(
      await eslint.calculateConfigForFile(BROKER_VENDORED),
      `${BROKER_VENDORED}: a config resolves for the vendored subtree, so the repo-wide ignore that keeps it readable against upstream has moved`,
    ).toBeUndefined();
    const [result] = await eslint.lintText(
      fixture('return JSON.parse("{}");'),
      {
        filePath: BROKER_VENDORED,
      },
    );
    expect(result.messages.map((message) => message.ruleId)).toEqual([null]);
  });

  it("scans only broker paths the lint still ignores", async () => {
    expect(
      IGNORED_BROKER_PATTERNS,
      "eslint.config.mjs ignores no broker path, so the scan below covers nothing",
    ).not.toHaveLength(0);
    const files = IGNORED_BROKER_PATTERNS.flatMap((pattern) =>
      typeScriptFilesUnder(repoRoot, pattern),
    );
    expect(files, "the ignored broker paths hold no .ts file").not.toHaveLength(
      0,
    );
    for (const file of files) {
      expect(
        await eslint.calculateConfigForFile(file),
        `${file}: a config resolves for it, so it is linted and the bans already cover it`,
      ).toBeUndefined();
    }
  });

  it("finds no banned parse in the lint-ignored broker paths", async () => {
    expect(await bannedParsesUnderIgnoredPaths(repoRoot)).toEqual([]);
  });

  it("finds a planted parse in every shape the bans catch", async () => {
    plantedRoot = mkdtempSync(resolve(tmpdir(), "broker-parse-bans-"));
    for (const [path, source] of Object.entries({
      ...PLANTED_FILES,
      [PLANTED_CLEAN]:
        'declare function parseBoundedJson(text: string): unknown;\nexport const parsed: unknown = parseBoundedJson("{}");\n',
    })) {
      const file = resolve(plantedRoot, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, source);
    }
    expect(await bannedParsesUnderIgnoredPaths(plantedRoot)).toEqual(
      Object.keys(PLANTED_FILES).sort(),
    );
  });
});
