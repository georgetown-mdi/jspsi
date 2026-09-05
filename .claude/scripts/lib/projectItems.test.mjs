import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAllItems,
  fieldValueInput,
  githubToken,
  graphql,
  GRAPHQL_MAX_ATTEMPTS,
  GRAPHQL_REQUEST_TIMEOUT_MS,
  GRAPHQL_RETRY_BACKOFF_MS,
  mapFetchedNode,
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

    // Each item has numeric id, node id, title, and the extracted fields
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

describe("mapFetchedNode cross-project guard", () => {
  const contentNode = (projectNumber) => ({
    databaseId: 1,
    project: { number: projectNumber },
    fieldValues: {
      nodes: [
        {
          __typename: "ProjectV2ItemFieldNumberValue",
          number: 4,
          field: { name: "Order" },
        },
      ],
    },
    content: { __typename: "DraftIssue", title: "T", body: "B" },
  });

  it("resolves a node whose project matches the requested one", () => {
    const r = mapFetchedNode(contentNode(9), 123, 9);
    expect(r.type).toBe("DraftIssue");
    expect(r.fields).toEqual({ Order: 4 });
    expect(r.resolvedProject).toBeUndefined();
  });

  it("treats a node resolved on a different project as missing, noting the resolved project", () => {
    // The core hazard: a numeric id whose item lives on board 10, read under
    // board 9, must not come back as a board-9 item.
    const r = mapFetchedNode(contentNode(10), 123, 9);
    expect(r.type).toBe("missing");
    expect(r.resolvedProject).toBe(10);
    expect(r.body).toBeNull();
  });

  it("treats an absent or contentless node as missing without a resolved project", () => {
    expect(mapFetchedNode(null, 123, 9).type).toBe("missing");
    expect(mapFetchedNode({ content: null }, 123, 9).type).toBe("missing");
    expect(mapFetchedNode(null, 123, 9).resolvedProject).toBeUndefined();
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

describe("graphql request bounds", () => {
  // Small enough that the suite never waits out a real ladder, while every
  // assertion still runs the production timeout, retry, and classification code.
  const FAST = { timeoutMs: 25, maxAttempts: 3, backoffMs: 1 };

  const jsonResponse = (status, body) =>
    new Response(JSON.stringify(body), { status });
  const okResponse = (data) => jsonResponse(200, { data });
  // A transport that answers nothing and ignores the abort: the shape the
  // bound has to survive, since aborting is a request the transport may drop.
  const stalledFetch = () => new Promise(() => {});

  let stderr;

  beforeEach(() => {
    // Keeps githubToken on its env branch, so no `gh auth token` subprocess runs.
    vi.stubEnv("GH_TOKEN", "test-token");
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("fails a stalled request at the timeout and aborts it", async () => {
    const signals = [];
    const fetchStub = vi.fn((_url, init) => {
      signals.push(init.signal);
      return stalledFetch();
    });
    vi.stubGlobal("fetch", fetchStub);

    const err = await graphql("{ q }", undefined, {
      ...FAST,
      maxAttempts: 1,
    }).catch((e) => e);

    expect(err.message).toMatch(/no response within 25 ms/);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    // The socket is torn down rather than left in flight behind the failure.
    expect(signals[0].aborted).toBe(true);
  });

  it("reports the deadline when the transport honors the abort itself", async () => {
    vi.stubGlobal("fetch", (_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () =>
          reject(new DOMException("This operation was aborted", "AbortError")),
        );
      });
    });

    const err = await graphql("{ q }", undefined, {
      ...FAST,
      maxAttempts: 1,
    }).catch((e) => e);

    expect(err.message).toMatch(/no response within 25 ms/);
  });

  it("leaves no unhandled rejection when the transport rejects after the deadline", async () => {
    // The deadline wins the race, so the transport's own rejection arrives at a
    // promise that already lost it. Promise.race attaches a handler to every
    // input, so that late rejection is handled -- asserted rather than asserted
    // in prose, because the failure mode is a process-level crash far from here.
    const unhandled = [];
    const record = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    vi.stubGlobal(
      "fetch",
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            setTimeout(() => reject(new Error("late transport failure")), 20),
          );
        }),
    );

    try {
      const err = await graphql("{ q }", undefined, {
        ...FAST,
        maxAttempts: 1,
      }).catch((e) => e);

      expect(err.message).toMatch(/no response within 25 ms/);
      // Past the late rejection, and past the drain on which Node reports one.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", record);
    }
  });

  it("returns the success that follows a stalled attempt", async () => {
    let calls = 0;
    const fetchStub = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? stalledFetch()
        : Promise.resolve(okResponse({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchStub);

    const body = await graphql("{ q }", undefined, FAST);

    expect(body.data).toEqual({ ok: true });
    expect(fetchStub).toHaveBeenCalledTimes(2);
    // A retried stall that ends in success still says what it waited on.
    expect(stderr.mock.calls[0][0]).toMatch(
      /GraphQL attempt 1 of 3 failed \(no response within 25 ms\); retrying in 1 ms/,
    );
  });

  it("names the endpoint and attempt count when the budget runs out", async () => {
    const fetchStub = vi.fn(stalledFetch);
    vi.stubGlobal("fetch", fetchStub);

    const err = await graphql("{ q }", undefined, FAST).catch((e) => e);

    expect(err.message).toContain("https://api.github.com/graphql");
    expect(err.message).toContain("after 3 attempts");
    expect(fetchStub).toHaveBeenCalledTimes(GRAPHQL_MAX_ATTEMPTS);
  });

  it("retries a status that a later attempt could get past", async () => {
    for (const status of [408, 429, 500, 502, 503]) {
      let calls = 0;
      const fetchStub = vi.fn(() => {
        calls += 1;
        return Promise.resolve(
          calls === 1
            ? jsonResponse(status, { message: "try again" })
            : okResponse({ ok: status }),
        );
      });
      vi.stubGlobal("fetch", fetchStub);

      const body = await graphql("{ q }", undefined, FAST);

      expect(body.data).toEqual({ ok: status });
      expect(fetchStub).toHaveBeenCalledTimes(2);
    }
  });

  it("fails a permanently-bad request on the first attempt", async () => {
    // A bad token, a missing scope, or a malformed query answers the same way
    // every time; spending the whole budget on it only delays the report.
    for (const status of [400, 401, 403, 404, 422]) {
      const fetchStub = vi.fn(() =>
        Promise.resolve(jsonResponse(status, { message: "Bad credentials" })),
      );
      vi.stubGlobal("fetch", fetchStub);

      const err = await graphql("{ q }", undefined, FAST).catch((e) => e);

      expect(err.message).toContain(`HTTP ${status}`);
      expect(err.message).toContain("after 1 attempt:");
      expect(fetchStub).toHaveBeenCalledTimes(1);
    }
  });

  it("retries a network-level failure", async () => {
    let calls = 0;
    const fetchStub = vi.fn(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new TypeError("fetch failed"))
        : Promise.resolve(okResponse({ ok: true }));
    });
    vi.stubGlobal("fetch", fetchStub);

    expect((await graphql("{ q }", undefined, FAST)).data).toEqual({
      ok: true,
    });
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("sends the documented request and keeps a partial result, on default options", async () => {
    const fetchStub = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, {
          data: { i0: null },
          errors: [{ type: "NOT_FOUND" }],
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchStub);

    // No options: the production timeout, budget, and backoff defaults apply.
    const body = await graphql("query { x }", { a: 1 });

    // An HTTP 200 holding both data and errors is a partial result, which
    // fetchItems relies on being returned rather than thrown.
    expect(body.data).toEqual({ i0: null });
    expect(body.errors).toHaveLength(1);

    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe("https://api.github.com/graphql");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer test-token");
    expect(JSON.parse(init.body)).toEqual({
      query: "query { x }",
      variables: { a: 1 },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    await graphql("query { x }");
    expect(JSON.parse(fetchStub.mock.calls[1][1].body)).toEqual({
      query: "query { x }",
    });
  });

  it("keeps the default ladder inside the budget a harness gives one command", () => {
    // An agent harness backgrounds (and eventually kills) a foreground command
    // at 120 s, so a ladder that runs to the end of its budget has to fail loudly
    // well before then -- otherwise the bound reproduces the hang it replaces.
    const HARNESS_COMMAND_BUDGET_MS = 120_000;
    let backoffTotal = 0;
    for (let attempt = 1; attempt < GRAPHQL_MAX_ATTEMPTS; attempt += 1) {
      backoffTotal += GRAPHQL_RETRY_BACKOFF_MS * attempt;
    }
    const worstCaseMs =
      GRAPHQL_MAX_ATTEMPTS * GRAPHQL_REQUEST_TIMEOUT_MS + backoffTotal;

    expect(worstCaseMs).toBeLessThan(HARNESS_COMMAND_BUDGET_MS * 0.75);
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
