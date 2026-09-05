import ts from "typescript";
import { describe, expect, it } from "vitest";

import { parseFile, parseSource } from "./lib/typeScriptSources.mjs";

// The console server declares the CLI's persistence-loss exit code itself
// rather than importing it -- the CLI is a separate workspace it drives as a
// subprocess -- so nothing in the module graph holds the two declarations
// together.
//
// That code is the one exit the server must not classify as an ordinary
// failure: the exchange completed and a local write did not, so a supervisor
// told "failed" re-runs it and re-sends this party's data for an exchange that
// already happened. Each side's suite pins only its OWN copy against the
// literal, so a coherent change to one workspace -- the constant and the
// literals its own tests assert -- leaves both suites green while the server
// classifies a value that does not match the CLI's current exit code. This
// check is what fails there: it reads both declarations out of source and
// compares them.
//
// docs/spec/SERVER_JOB_API.md cites it rather than asserting the alignment in
// prose.
//
// Reach and limits, stated rather than implied.
//
// What it reads is a TOP-LEVEL `export const <name> = <numeric literal>` in each
// module, parsed with the TypeScript compiler API. Every other shape -- a
// missing or duplicated declaration, one that is not exported or not `const`, an
// initializer written as an expression, an `as const`, or an import of the other
// side's value -- is reported as a shape this check cannot read rather than
// passed over, so a change of idiom fails here to be answered instead of going
// quiet.
//
// What it decides is EQUALITY of the two declared values, not that either is the
// right one: a change that moved both to the same new number passes here. The
// value itself is pinned against the exit-code contract by each side's own suite
// (apps/cli/test/unit/protocol.test.ts and
// apps/web/test/unit/jobs/jobDriver.unit.test.ts).
//
// It reaches only this constant. The server module has one other
// cross-workspace mirror, the CLI's fd-3 event vocabulary, which is a type
// rather than a value and is not read here.

const SELF = "scripts/persistence-loss-exit-code.test.mjs";

/** The name both sides export. */
const CONSTANT = "PERSISTENCE_LOSS_EXIT_CODE";

/** The declaring modules, repository-relative: the CLI's, then the server's. */
const CLI_MODULE = "apps/cli/src/eventStream.ts";
const SERVER_MODULE = "apps/web/src/jobs/cliDriver.ts";

/**
 * What a module declares for the constant: `{file, value}` for a shape this
 * check reads, `{file, unreadable}` for one it does not.
 */
function readDeclaration(sourceFile) {
  const file = sourceFile.fileName;
  const found = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations)
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === CONSTANT
      )
        found.push({ statement, declaration });
  }
  if (found.length !== 1)
    return {
      file,
      unreadable: `${found.length} top-level declaration(s) of ${CONSTANT}, not one`,
    };
  const [{ statement, declaration }] = found;
  if (
    !statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
  )
    return { file, unreadable: `${CONSTANT} is declared without \`export\`` };
  if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0)
    return { file, unreadable: `${CONSTANT} is declared without \`const\`` };
  const { initializer } = declaration;
  if (initializer === undefined || !ts.isNumericLiteral(initializer))
    return {
      file,
      unreadable:
        `${CONSTANT} is initialized by ` +
        `${initializer === undefined ? "nothing" : ts.SyntaxKind[initializer.kind]} ` +
        `rather than a numeric literal`,
    };
  return { file, value: Number(initializer.text) };
}

/** Read each module's declaration, in the order the modules are given. */
function readDeclarations(
  files = [CLI_MODULE, SERVER_MODULE],
  parse = parseFile,
) {
  return files.map((file) => readDeclaration(parse(file)));
}

/**
 * How the readable declarations disagree, one entry per module, or nothing when
 * they all hold the same value.
 */
function divergence(readings) {
  const read = readings.filter((reading) => reading.value !== undefined);
  const values = new Set(read.map((reading) => reading.value));
  return values.size > 1
    ? read.map((reading) => `${reading.file} declares ${reading.value}`)
    : [];
}

const readings = readDeclarations();

describe("the console server's persistence-loss exit code tracks the CLI's", () => {
  it("reads a declaration it understands out of each module", () => {
    const unreadable = readings
      .filter((reading) => reading.unreadable !== undefined)
      .map((reading) => `${reading.file}: ${reading.unreadable}`);
    expect(
      unreadable,
      `${unreadable.length} declaration(s) of ${CONSTANT} are shapes this ` +
        `check cannot read, so it cannot say whether the pair agrees. Declare ` +
        `it as an exported top-level \`const\` with a numeric literal, or ` +
        `teach ${SELF} the new idiom.`,
    ).toEqual([]);
  });

  it("holds the two declared values equal", () => {
    const divergent = divergence(readings);
    expect(
      divergent,
      `${CLI_MODULE} and ${SERVER_MODULE} declare different values for ` +
        `${CONSTANT}, so a run that completed its exchange and lost a local ` +
        `write is classified as an ordinary failure -- which tells a ` +
        `supervisor to re-run it, re-sending this party's data for an ` +
        `exchange that already happened. Carry the change to both.`,
    ).toEqual([]);
  });

  it("reports a server copy the CLI has moved away from", () => {
    // The defect this check exists for, pinned against sources of its own: the
    // shape both workspaces' own suites pass, because each pins only its own
    // copy.
    const sources = {
      "cli.ts": `export const ${CONSTANT} = 74;`,
      "server.ts": `export const ${CONSTANT} = 73;`,
    };
    const moved = readDeclarations(Object.keys(sources), (file) =>
      parseSource(file, sources[file]),
    );
    expect(divergence(moved)).toEqual([
      "cli.ts declares 74",
      "server.ts declares 73",
    ]);
  });

  it("refuses a declaration shape it cannot read rather than passing it", () => {
    const sources = {
      "imported.ts": `import { ${CONSTANT} } from "@psilink/cli";`,
      "unexported.ts": `const ${CONSTANT} = 73;`,
      "reassignable.ts": `export let ${CONSTANT} = 73;`,
      "computed.ts": `export const ${CONSTANT} = EX_CANTCREAT;`,
      "asserted.ts": `export const ${CONSTANT} = 73 as const;`,
    };
    const refused = readDeclarations(Object.keys(sources), (file) =>
      parseSource(file, sources[file]),
    );
    expect(
      refused
        .filter((reading) => reading.unreadable !== undefined)
        .map((reading) => reading.file),
    ).toEqual(Object.keys(sources));
  });
});
