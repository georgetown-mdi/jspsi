import { describe, expect, it } from "vitest";
import { filterItems, parseArgs } from "./list-issues.mjs";

// A mapped item as list-issues.mjs's main() builds it before filtering:
// { id, nodeId, status, epic, order, title }. filterItems only reads status, so
// the other fields are filled with distinct placeholders to make a failure easy
// to attribute to the right item.
function item(id, status) {
  return {
    id,
    nodeId: `PVTI_${id}`,
    status,
    epic: "Epic",
    order: id,
    title: `Item ${id}`,
  };
}

describe("parseArgs", () => {
  it("defaults to no filters and reads the project number", () => {
    const parsed = parseArgs(["9"]);
    expect(parsed).toEqual({
      ok: true,
      asJson: false,
      open: false,
      statuses: [],
      projectNumber: 9,
    });
  });

  it("accepts --json in either position around the project number", () => {
    expect(parseArgs(["--json", "9"])).toMatchObject({
      ok: true,
      asJson: true,
    });
  });

  it("collects repeated --status values, lowercased", () => {
    const parsed = parseArgs([
      "--status",
      "Todo",
      "--status",
      "In Progress",
      "9",
    ]);
    expect(parsed).toMatchObject({
      ok: true,
      statuses: ["todo", "in progress"],
    });
  });

  it("sets open on --open", () => {
    expect(parseArgs(["--open", "9"])).toMatchObject({
      ok: true,
      open: true,
      statuses: [],
    });
  });

  it("rejects --open combined with --status", () => {
    const parsed = parseArgs(["--open", "--status", "Todo", "9"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toMatch(/--open cannot be combined with --status/);

    // Order of the two flags does not matter.
    const reversed = parseArgs(["--status", "Todo", "--open", "9"]);
    expect(reversed.ok).toBe(false);
    expect(reversed.message).toMatch(/--open cannot be combined with --status/);
  });

  it("rejects a --status with no value", () => {
    const parsed = parseArgs(["--status"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.message).toBe("error: --status requires a value\n");
  });

  it("rejects a missing or non-numeric project number with the usage string", () => {
    expect(parseArgs([]).ok).toBe(false);
    expect(parseArgs([]).message).toMatch(/^Usage: node list-issues\.mjs/);
    expect(parseArgs(["not-a-number"]).ok).toBe(false);
    expect(parseArgs(["9", "10"]).ok).toBe(false);
  });
});

describe("filterItems", () => {
  const items = [
    item(1, "Todo"),
    item(2, "Done"),
    item(3, "done"), // differently cased, still Done
    item(4, "In Progress"),
    item(5, null), // no Status set
  ];

  it("passes every item through when neither --status nor --open is given", () => {
    expect(filterItems(items, { statuses: [], open: false })).toEqual(items);
  });

  it("keeps only items whose Status matches, case-insensitively, dropping unset Status", () => {
    const result = filterItems(items, {
      statuses: ["todo", "done"],
      open: false,
    });
    expect(result.map((i) => i.id)).toEqual([1, 2, 3]);
  });

  it("excludes every Done item (case-insensitively) when --open is set", () => {
    const result = filterItems(items, { statuses: [], open: true });
    expect(result.map((i) => i.id)).toEqual([1, 4, 5]);
  });

  it("keeps an item with no Status under --open, since unset is not Done", () => {
    const result = filterItems([item(9, null)], { statuses: [], open: true });
    expect(result).toEqual([item(9, null)]);
  });
});
