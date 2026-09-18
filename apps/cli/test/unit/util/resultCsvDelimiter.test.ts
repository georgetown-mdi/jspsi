import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, expect, test } from "vitest";
import { buildOutputTable, loadCSVFile, toRetainedResult } from "@psilink/core";
import type { AssociationTable, Metadata, PartnerPayload } from "@psilink/core";

import { writeOutput } from "../../../src/util/dataIo";

// The result CSV under a chosen field delimiter: core escapes each field against
// it and writeOutput joins with the same one, so the file reads back through the
// delimiter the operator picked. The comma case is resultCsvEscaping.test.ts's;
// this is the same round trip under every other accepted delimiter, including one
// whose values hold the delimiter itself.

const metadata: Metadata = [
  { name: "pid", type: "ssn", role: "identifier", isPayload: false },
];
const associationTable: AssociationTable = [
  [0, 1],
  [0, 1],
];

const tempDirs: string[] = [];

function tempResultPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "psilink-result-delim-"));
  tempDirs.push(dir);
  return path.join(dir, "results.csv");
}

function silentLog(): { error: (message: string) => void } {
  return { error: () => {} };
}

afterEach(() => {
  while (tempDirs.length > 0)
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

test("a result written with a chosen delimiter reads back through the same one", async () => {
  for (const delimiter of [",", "\t", "|", ";", "^"]) {
    // Every character the write has to quote, in one cell: the delimiter, a
    // double quote, and a line break.
    const held = `x${delimiter}y "q" z\nw`;
    const partnerPayload: PartnerPayload = {
      columns: ["note"],
      rowIndices: [0, 1],
      rows: [[held], ["plain"]],
    };
    const { headers, rows } = buildOutputTable(
      associationTable,
      [{ pid: held }, { pid: "P2" }],
      metadata,
      partnerPayload,
      undefined,
      delimiter,
    );
    const file = tempResultPath();
    await writeOutput(file, headers, rows, silentLog(), undefined, delimiter);

    const readBack = toRetainedResult(
      await loadCSVFile(fs.createReadStream(file), undefined, delimiter),
    );
    expect(readBack.headers).toEqual(["pid", "row_id", "note"]);
    expect(readBack.rows).toEqual([
      [held, "0", held],
      ["P2", "1", "plain"],
    ]);
  }
});

test("writeOutput given no delimiter writes commas", async () => {
  const { headers, rows } = buildOutputTable(
    associationTable,
    [{ pid: "P1" }, { pid: "P2" }],
    metadata,
    { columns: ["note"], rowIndices: [0, 1], rows: [["a"], ["b"]] },
  );
  const file = tempResultPath();
  await writeOutput(file, headers, rows, silentLog());
  expect(fs.readFileSync(file, "utf8")).toBe(
    "pid,row_id,note\nP1,0,a\nP2,1,b\n",
  );
});

test("each field is quoted once against the chosen delimiter", async () => {
  // The bytes on disk: escaping is core's and the writer only joins, so a
  // second pass here would write `"""a|b"""`, which still parses and would slip
  // past the reader assertion above.
  const { headers, rows } = buildOutputTable(
    associationTable,
    [{ pid: "a|b" }, { pid: "P2" }],
    metadata,
    { columns: ["note"], rowIndices: [0, 1], rows: [["x,y"], ["b"]] },
    undefined,
    "|",
  );
  const file = tempResultPath();
  await writeOutput(file, headers, rows, silentLog(), undefined, "|");

  const text = fs.readFileSync(file, "utf8");
  expect(text).toContain('"a|b"');
  expect(text).not.toContain('"""a|b"""');
  // A comma is an ordinary character under this delimiter, so it is not quoted.
  expect(text).toContain("|x,y\n");
  expect(text.startsWith("pid|row_id|note\n")).toBe(true);
});
