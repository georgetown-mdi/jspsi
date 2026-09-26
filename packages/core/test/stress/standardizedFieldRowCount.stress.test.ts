import { expect, test } from "vitest";

import { StandardizedField } from "../../src/standardization";

import type { CSVRow } from "../../src/file";

// A V8 Map holds at most 2^24 entries, so a per-row cache kept in one refuses
// the row past it. About 2 GB of heap and a few seconds for the cache alone,
// which is why it is the opt-in tier.
const MAP_ENTRY_LIMIT = 2 ** 24;

test("a field realizes and caches every row of an input one row past the Map entry limit", () => {
  const rowCount = MAP_ENTRY_LIMIT + 1;
  const rows: Array<CSVRow> = new Array<CSVRow>(rowCount).fill({ c: "a" });
  const field = new StandardizedField("f", "c", [], rows);

  let realized = 0;
  for (let i = 0; i < MAP_ENTRY_LIMIT; i++) realized += field.get(i).length;
  expect(realized).toBe(MAP_ENTRY_LIMIT);
  expect(field.get(MAP_ENTRY_LIMIT)).toEqual(["a"]);

  expect(field.get(0)).toBe(field.get(0));
  expect(field.get(MAP_ENTRY_LIMIT)).toBe(field.get(MAP_ENTRY_LIMIT));
});
