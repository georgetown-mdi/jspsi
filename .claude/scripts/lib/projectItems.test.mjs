import { describe, expect, it } from "vitest";
import {
  fetchAllItems,
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
          field: { name: "Implementation Order" },
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
    // (status / Epic / Implementation Order) the listing promises.
    const last = result[total - 1];
    expect(last.id).toBe(numericIdFromNodeId(nodes[total - 1].id));
    expect(last.nodeId).toBe(nodes[total - 1].id);
    expect(last.title).toBe(`Item ${total - 1}`);
    expect(last.fields).toEqual({
      Status: "Todo",
      Epic: "Epic A",
      "Implementation Order": total - 1,
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
});
