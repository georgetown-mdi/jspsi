import { describe, expect, it } from "vitest";
import {
  fetchAllItems,
  fieldValueInput,
  githubToken,
  numericIdFromNodeId,
  PAGE_SIZE,
  pvtiNodeId,
  toNumericId,
} from "./projectItems.mjs";

// Build a synthetic project item as the GraphQL listing query selects it: a
// PVTI_ node id (so numericIdFromNodeId can decode it), a fieldValues node list
// covering the three triage fields, and a draft-issue title.
function fakeNode(projectNumber, numericId, { status, epic, order, title }) {
  return {
    id: pvtiNodeId(projectNumber, numericId),
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldSingleSelectValue",
          name: status,
          field: { name: "Status" },
        },
        {
          __typename: "ProjectV2ItemFieldTextValue",
          text: epic,
          field: { name: "Epic" },
        },
        {
          __typename: "ProjectV2ItemFieldNumberValue",
          number: order,
          field: { name: "Order" },
        },
      ],
    },
    content: { __typename: "DraftIssue", title },
  };
}

// A runQuery that serves `nodes` in pages of `pageSize`, honoring the cursor the
// way GitHub's items connection does: each call returns the next page and an
// endCursor, with hasNextPage false on the last. fetchAllItems only feeds the
// returned endCursor back as an opaque token, so a served-count closure is a
// faithful stand-in for real cursor pagination.
function pagedRunQuery(nodes, pageSize) {
  let served = 0;
  return () => {
    const page = nodes.slice(served, served + pageSize);
    served += page.length;
    const hasNextPage = served < nodes.length;
    return {
      organization: {
        projectV2: {
          items: {
            pageInfo: {
              hasNextPage,
              endCursor: hasNextPage ? `cursor-${served}` : null,
            },
            nodes: page,
          },
        },
      },
    };
  };
}

describe("fetchAllItems pagination", () => {
  it("returns every item across more than one page (past the default page size)", async () => {
    const total = PAGE_SIZE + 50; // 150: forces a second page beyond the 100 cap
    const nodes = Array.from({ length: total }, (_, idx) =>
      fakeNode(9, 100000000 + idx, {
        status: "Todo",
        epic: "Epic A",
        order: idx,
        title: `Item ${idx}`,
      }),
    );

    const result = await fetchAllItems(9, {
      runQuery: pagedRunQuery(nodes, PAGE_SIZE),
    });

    // No silent truncation: all 150 come back, not just the first 100-item page.
    expect(result).toHaveLength(total);
    expect(total).toBeGreaterThan(PAGE_SIZE);

    // Each item carries numeric id, node id, title, and the extracted fields
    // (status / Epic / Order) the listing promises.
    const last = result[total - 1];
    expect(last.id).toBe(numericIdFromNodeId(nodes[total - 1].id));
    expect(last.nodeId).toBe(nodes[total - 1].id);
    expect(last.title).toBe(`Item ${total - 1}`);
    expect(last.fields).toEqual({
      Status: "Todo",
      Epic: "Epic A",
      Order: total - 1,
    });
  });

  it("stops after a single page when the board fits in one", async () => {
    const nodes = [
      fakeNode(10, 199240250, {
        status: "Todo",
        epic: undefined,
        order: undefined,
        title: "Only item",
      }),
    ];
    const result = await fetchAllItems(10, {
      runQuery: pagedRunQuery(nodes, PAGE_SIZE),
    });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(199240250);
  });
});

describe("toNumericId", () => {
  it("resolves a PVTI_ node id to the same numeric item id as its numeric form", () => {
    // lint-issues.mjs routes its arguments through toNumericId, so a node id and
    // the numeric id it was derived from must address the same item.
    const numeric = 199240250;
    const nodeId = pvtiNodeId(10, numeric);

    expect(toNumericId(nodeId)).toBe(numeric);
    expect(toNumericId(String(numeric))).toBe(numeric);
    expect(toNumericId(nodeId)).toBe(toNumericId(String(numeric)));
  });

  it("returns NaN for an unparseable numeric argument (so Number.isInteger rejects it)", () => {
    expect(toNumericId("not-a-number")).toBeNaN();
  });

  it("rejects a node id whose project disagrees with the requested project", () => {
    // A board-10 node id passed with project 9 would otherwise decode and be
    // re-encoded under board 9's prefix, silently addressing a different item.
    const board10NodeId = pvtiNodeId(10, 199240250);
    expect(() => toNumericId(board10NodeId, 9)).toThrow(
      /not the requested project/,
    );
    expect(toNumericId(board10NodeId, 10)).toBe(199240250);
    // With no expected project given, the cross-check is skipped (back-compat).
    expect(toNumericId(board10NodeId)).toBe(199240250);
  });
});

describe("githubToken", () => {
  it("prefers GH_TOKEN, then GITHUB_TOKEN, then the stored credential", () => {
    const stored = () => "stored-token";
    expect(
      githubToken({
        env: { GH_TOKEN: "gh-token", GITHUB_TOKEN: "github-token" },
        readStoredToken: stored,
      }),
    ).toBe("gh-token");
    expect(
      githubToken({
        env: { GITHUB_TOKEN: "github-token" },
        readStoredToken: stored,
      }),
    ).toBe("github-token");
    // gh auth token prints a trailing newline; it must be trimmed off.
    expect(
      githubToken({ env: {}, readStoredToken: () => "stored-token\n" }),
    ).toBe("stored-token");
  });

  it("throws (rather than returning empty) when no token is available", () => {
    expect(() =>
      githubToken({
        env: {},
        readStoredToken: () => {
          throw new Error("gh: not logged in");
        },
      }),
    ).toThrow(/no GitHub token/);
    expect(() => githubToken({ env: {}, readStoredToken: () => "" })).toThrow(
      /no GitHub token/,
    );
  });

  it("falls through a whitespace-only env var to the stored credential", () => {
    expect(
      githubToken({
        env: { GH_TOKEN: "   " },
        readStoredToken: () => "stored",
      }),
    ).toBe("stored");
  });
});

describe("fieldValueInput", () => {
  const status = {
    name: "Status",
    dataType: "SINGLE_SELECT",
    options: [
      { id: "opt_todo", name: "Todo" },
      { id: "opt_done", name: "Done" },
    ],
  };

  it("resolves a single-select option id by name, case-insensitively", () => {
    expect(fieldValueInput(status, "todo")).toEqual({
      singleSelectOptionId: "opt_todo",
    });
  });

  it("throws on an unknown single-select option, listing the choices", () => {
    expect(() => fieldValueInput(status, "Nope")).toThrow(/Todo, Done/);
  });

  it("maps text straight through and number to a JS number", () => {
    expect(fieldValueInput({ name: "Epic", dataType: "TEXT" }, "Sync")).toEqual(
      {
        text: "Sync",
      },
    );
    expect(fieldValueInput({ name: "Order", dataType: "NUMBER" }, "7")).toEqual(
      { number: 7 },
    );
    expect(
      fieldValueInput({ name: "Due", dataType: "DATE" }, "2026-01-02"),
    ).toEqual({ date: "2026-01-02" });
  });

  it("throws on a non-numeric value for a number field", () => {
    expect(() =>
      fieldValueInput({ name: "Order", dataType: "NUMBER" }, "soon"),
    ).toThrow(/not numeric/);
  });

  it("throws on an unsupported field type", () => {
    expect(() =>
      fieldValueInput({ name: "Sprint", dataType: "ITERATION" }, "x"),
    ).toThrow(/unsupported type/);
  });
});
