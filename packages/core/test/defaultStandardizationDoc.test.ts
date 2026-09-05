import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";
import { parse as parseYaml } from "yaml";

import { ALIAS_TYPE_META_MAP } from "../src/config/metadata";
import { safeParseLinkageTerms } from "../src/config/linkageTerms";
import { getDefaultStandardization } from "../src/defaults/standardization";
import { runPipeline } from "../src/standardization";
import { SEMANTIC_TYPES } from "../src/types";
import { snakeizeKeys } from "../src/utils/camelizeKeys";
import { CANDIDATE_DATE_FORMATS, INFER_DATE_SCAN_CAP } from "../src/utils/date";

import type { ColumnMetadata } from "../src/config/metadata";
import type { LinkageField, LinkageTerms } from "../src/config/linkageTerms";
import type { StandardizationStep } from "../src/config/standardization";
import type { SemanticType } from "../src/types";

// docs/spec/DEFAULT_STANDARDIZATION.md mirrors registries that live only in
// code: the per-type step arrays, the inference alias table, and the
// date-format inference parameters. This suite reads the published document
// and drives the shipped functions against it, so an edit to either side
// that drifts from the other fails here, rather than keeping a second copy
// of the pipelines as a third place to drift.
const DOC_RELATIVE_PATH = "docs/spec/DEFAULT_STANDARDIZATION.md";
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const docLines = readFileSync(`${repoRoot}${DOC_RELATIVE_PATH}`, "utf8").split(
  "\n",
);

// --- Document parsing --------------------------------------------------------

interface TypeSection {
  stepsYaml: string;
  examples: Array<{ input: string; result: string | null }>;
}

const CODE_SPAN = /^`(.*)`$/s;

function unwrapCodeSpan(cell: string): string {
  const match = CODE_SPAN.exec(cell.trim());
  if (match === null)
    throw new Error(`${DOC_RELATIVE_PATH}: expected a code span, got: ${cell}`);
  return match[1];
}

// A cell holding a JSON scalar in a code span (`"abc"` or `null`), the form the
// worked-example tables use so leading and trailing whitespace stays visible.
function jsonScalarCell(cell: string): string | null {
  const raw = unwrapCodeSpan(cell);
  const value: unknown = JSON.parse(raw);
  if (value !== null && typeof value !== "string")
    throw new Error(
      `${DOC_RELATIVE_PATH}: expected a string or null, got: ${raw}`,
    );
  return value;
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function isSeparatorRow(line: string): boolean {
  return /^\|[\s:|-]+\|$/.test(line);
}

// Rows of the table whose header row is at `headerIndex`, up to the first line
// that is not a table row.
function tableRows(headerIndex: number): string[][] {
  const rows: string[][] = [];
  for (let i = headerIndex + 1; i < docLines.length; i++) {
    const line = docLines[i];
    if (!line.startsWith("|")) break;
    if (isSeparatorRow(line)) continue;
    rows.push(splitRow(line));
  }
  return rows;
}

function parseDocument() {
  const typeSections = new Map<string, TypeSection>();
  const aliasRows: string[][] = [];
  const parameterRows: string[][] = [];
  let currentType: string | undefined;
  let inFence = false;
  let fenceLanguage = "";
  let fenceBody: string[] = [];
  const currentSection = (): TypeSection | undefined =>
    currentType === undefined ? undefined : typeSections.get(currentType);

  for (let i = 0; i < docLines.length; i++) {
    const line = docLines[i];

    if (line.startsWith("```")) {
      if (!inFence) {
        inFence = true;
        fenceLanguage = line.slice(3).trim();
        fenceBody = [];
        continue;
      }
      inFence = false;
      const section = currentSection();
      if (fenceLanguage === "yaml" && section?.stepsYaml === "")
        section.stepsYaml = fenceBody.join("\n");
      continue;
    }
    if (inFence) {
      fenceBody.push(line);
      continue;
    }

    const typeHeading = /^### `([a-z0-9_]+)`$/.exec(line);
    if (typeHeading !== null) {
      currentType = typeHeading[1];
      typeSections.set(currentType, { stepsYaml: "", examples: [] });
      continue;
    }
    // Any other heading of the same or a higher level closes the type section.
    if (/^#{1,3} /.test(line)) currentType = undefined;

    if (/^\| Input \| Result \|/.test(line)) {
      const section = currentSection();
      if (section === undefined)
        throw new Error(
          `${DOC_RELATIVE_PATH}:${i + 1}: worked examples outside a type section`,
        );
      for (const row of tableRows(i))
        section.examples.push({
          input: jsonScalarCell(row[0]) ?? "",
          result: jsonScalarCell(row[1]),
        });
      continue;
    }
    if (/^\| Semantic type \|/.test(line)) aliasRows.push(...tableRows(i));
    if (/^\| Parameter \| Value \|/.test(line))
      parameterRows.push(...tableRows(i));
  }

  return { typeSections, aliasRows, parameterRows };
}

const { typeSections, aliasRows, parameterRows } = parseDocument();

// --- Registry side -----------------------------------------------------------

function termsFor(types: readonly SemanticType[]): LinkageTerms {
  return {
    version: "1.0.0",
    identity: "doc parity",
    date: "2025-01-01",
    algorithm: "psi",
    linkageStrategy: "cascade",
    output: { expectsOutput: true, shareWithPartner: false },
    deduplicate: false,
    linkageFields: types.map((type) => ({
      name: type,
      type,
    })) as LinkageField[],
    linkageKeys: [{ name: "key", elements: [{ field: types[0] }] }],
  };
}

function metadataFor(types: readonly SemanticType[]): ColumnMetadata[] {
  return types.map((type) => ({
    name: type,
    type,
    role: "linkage",
    isPayload: false,
  }));
}

// The semantic types the linkage-terms schema accepts as a linkage field: the
// set the defaults must cover, recovered from the schema rather than listed.
const linkageFieldTypes = SEMANTIC_TYPES.filter(
  (type) => safeParseLinkageTerms(termsFor([type])).success,
);

const defaultSteps = new Map<string, StandardizationStep[]>(
  getDefaultStandardization(
    metadataFor(linkageFieldTypes),
    termsFor(linkageFieldTypes),
  ).map((transformation) => [
    transformation.output,
    transformation.steps ?? [],
  ]),
);

// --- Assertions --------------------------------------------------------------

describe("DEFAULT_STANDARDIZATION.md pipelines", () => {
  test("documents exactly the types the defaults clean", () => {
    expect([...typeSections.keys()].sort()).toEqual(
      [...defaultSteps.keys()].sort(),
    );
  });

  test("covers every type a linkage field may declare", () => {
    expect([...defaultSteps.keys()].sort()).toEqual(
      [...linkageFieldTypes].sort(),
    );
  });

  test.each([...typeSections.keys()])("%s steps match the registry", (type) => {
    const documented = parseYaml(typeSections.get(type)!.stepsYaml) as {
      steps: unknown;
    };
    expect(documented.steps).toEqual(snakeizeKeys(defaultSteps.get(type)));
  });

  test.each([...typeSections.keys()])("%s worked examples hold", (type) => {
    const steps = defaultSteps.get(type)!;
    const examples = typeSections.get(type)!.examples;
    expect(examples.length).toBeGreaterThan(0);
    for (const { input, result } of examples)
      expect(
        runPipeline(input, steps),
        `input ${JSON.stringify(input)}`,
      ).toEqual(result);
  });
});

describe("DEFAULT_STANDARDIZATION.md inference table", () => {
  test("matches the alias registry", () => {
    const documented = new Map<string, unknown>();
    for (const [type, aliases, role, isPayload] of aliasRows)
      for (const alias of aliases.split(","))
        documented.set(unwrapCodeSpan(alias), {
          type: unwrapCodeSpan(type),
          role: unwrapCodeSpan(role),
          isPayload: unwrapCodeSpan(isPayload) === "true",
        });
    expect(Object.fromEntries(documented)).toEqual(ALIAS_TYPE_META_MAP);
  });
});

describe("DEFAULT_STANDARDIZATION.md date-format inference", () => {
  const parameter = (label: string): string => {
    const row = parameterRows.find((cells) => cells[0] === label);
    if (row === undefined)
      throw new Error(`${DOC_RELATIVE_PATH}: no parameter row for "${label}"`);
    return row[1];
  };

  test("lists the candidate formats in elimination order", () => {
    const documented = parameter(
      "Candidate input formats, in elimination order",
    )
      .split(",")
      .map(unwrapCodeSpan);
    expect(documented).toEqual([...CANDIDATE_DATE_FORMATS]);
  });

  test("states the scan cap", () => {
    expect(
      Number(unwrapCodeSpan(parameter("Maximum non-empty values scanned"))),
    ).toBe(INFER_DATE_SCAN_CAP);
  });
});
