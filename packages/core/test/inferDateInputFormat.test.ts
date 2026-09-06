import { Readable } from "node:stream";

import { expect, test } from "vitest";

import { inferMetadata } from "../src/config/metadata";
import {
  columnValues,
  inferDateFormat,
  INFER_DATE_SCAN_CAP,
} from "../src/utils/date";
import { loadCSVFile } from "../src/file";
import {
  inferDateInputFormatFromSource,
  inferDateOfBirthColumn,
} from "../src/inferDateInputFormat";

function streamOf(content: string): Readable {
  const s = new Readable({ read() {} });
  if (content.length > 0) s.push(Buffer.from(content, "utf8"));
  s.push(null);
  return s;
}

const COLUMNS = ["first_name", "last_name", "dob", "member_id"];

function csvWithRows(rows: number): string {
  const body = Array.from(
    { length: rows },
    (_v, i) =>
      `First${i},Last${i},1990-01-${String((i % 28) + 1).padStart(2, "0")},${i}`,
  ).join("\n");
  return `${COLUMNS.join(",")}\n${body}\n`;
}

test("inferDateOfBirthColumn resolves the date_of_birth column via inferMetadata", () => {
  expect(inferDateOfBirthColumn(COLUMNS)).toBe("dob");
  expect(
    inferDateOfBirthColumn(COLUMNS),
    // The one definition every caller shares.
  ).toBe(
    inferMetadata(COLUMNS, []).find((c) => c.type === "date_of_birth")?.name,
  );
  expect(inferDateOfBirthColumn(["a", "b"])).toBeUndefined();
});

test("a header column emptied by the strip is skipped, not refused here", () => {
  // The selection runs inside the read, which holds no sanitized positions, so
  // it leaves the empty name to the caller's positions-aware refusal instead of
  // raising the wrong cause from under the parse.
  expect(inferDateOfBirthColumn(["id", "", "dob"])).toBe("dob");
  expect(inferDateOfBirthColumn(["id", "", "city"])).toBeUndefined();
});

test("a header that is only direction characters reaches the caller whole", async () => {
  // U+202E (right-to-left override) then U+2069 (pop directional isolate): the
  // strip leaves the column no name. The read resolves rather than throwing, so
  // the caller warns by position and refuses with the removal as the cause.
  const inferred = await inferDateInputFormatFromSource(
    streamOf("id,\u202e\u2069,dob\n1,x,1990-01-02\n"),
  );
  expect(inferred.columns).toEqual(["id", "", "dob"]);
  expect(inferred.bidiStrippedColumns).toEqual([2]);
  expect(inferred.dobColumn).toBe("dob");
  expect(inferred.dateInputFormat).toBe("YYYY-MM-DD");
});

test("the inferred format equals inferDateFormat over the full date column", async () => {
  const csv = csvWithRows(40);
  const full = await loadCSVFile(streamOf(csv));
  const inferred = await inferDateInputFormatFromSource(streamOf(csv));
  expect(inferred.columns).toEqual(full.meta.fields);
  expect(inferred.dobColumn).toBe("dob");
  expect(inferred.dateInputFormat).toBe("YYYY-MM-DD");
  expect(inferred.dateInputFormat).toBe(
    inferDateFormat(columnValues(full.data, "dob")),
  );
});

test("a file with no date-of-birth column yields no dobColumn and no format", async () => {
  const inferred = await inferDateInputFormatFromSource(
    streamOf("first_name,member_id\nAlice,1\n"),
  );
  expect(inferred.columns).toEqual(["first_name", "member_id"]);
  expect(inferred.dobColumn).toBeUndefined();
  expect(inferred.dateInputFormat).toBeUndefined();
});

test("the DOB sample is bounded to the scan cap, matching a full read's format", async () => {
  const csv = csvWithRows(INFER_DATE_SCAN_CAP + 500);
  const full = await loadCSVFile(streamOf(csv));
  const inferred = await inferDateInputFormatFromSource(streamOf(csv));
  expect(inferred.dateInputFormat).toBe(
    inferDateFormat(columnValues(full.data, "dob")),
  );
});
