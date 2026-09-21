import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ServerFilePicker } from "@console/ServerFilePicker";
import { resolveCsvDelimiter } from "@components/csvDelimiterChoice";

import type {
  JobInputProfileResult,
  WorkInputReference,
} from "@psi/jobClient/workInputClient";
import type { CsvDelimiterResolution } from "@components/csvDelimiterChoice";

/**
 * A render harness for a component whose subject is its effects. The unit project
 * runs on `node` with no DOM to mount in, and which file the picker re-profiles on a
 * delimiter change is decided in an effect and reported by fetching rather than by
 * anything painted. So the hooks are slot-backed substitutes that honour the
 * dependency arrays -- the re-profile guard reads a ref and the fetchers are
 * memoized by the delimiter -- and each render returns the element tree unrendered.
 *
 * Hoisted because the `react` mock factory below is lifted above the file's
 * declarations.
 */
const reactHarness = vi.hoisted(() => {
  interface Slot {
    value: unknown;
    deps?: ReadonlyArray<unknown>;
  }
  const slots: Array<Slot> = [];
  const queued: Array<() => unknown> = [];
  let cursor = 0;

  const depsChanged = (
    previous: ReadonlyArray<unknown> | undefined,
    next: ReadonlyArray<unknown> | undefined,
  ): boolean =>
    previous === undefined ||
    next === undefined ||
    previous.length !== next.length ||
    previous.some((value, index) => !Object.is(value, next[index]));

  const slotAt = (): Slot | undefined => slots[cursor];
  const keep = (slot: Slot): Slot => {
    slots[cursor] = slot;
    cursor += 1;
    return slot;
  };

  const memoized = (produce: () => unknown, deps?: ReadonlyArray<unknown>) => {
    const existing = slotAt();
    if (existing !== undefined && !depsChanged(existing.deps, deps)) {
      existing.deps = deps;
      return keep(existing).value;
    }
    return keep({ value: produce(), deps }).value;
  };

  return {
    hooks: {
      useState: (initial: unknown) => {
        const existing = slotAt();
        const slot =
          existing ??
          ({
            value:
              typeof initial === "function"
                ? (initial as () => unknown)()
                : initial,
          } satisfies Slot);
        keep(slot);
        return [
          slot.value,
          (next: unknown) => {
            slot.value =
              typeof next === "function"
                ? (next as (previous: unknown) => unknown)(slot.value)
                : next;
          },
        ];
      },
      useRef: (initial: unknown) => {
        const existing = slotAt();
        const slot =
          existing ?? ({ value: { current: initial } } satisfies Slot);
        keep(slot);
        return slot.value;
      },
      useMemo: (factory: () => unknown, deps?: ReadonlyArray<unknown>) =>
        memoized(factory, deps),
      useCallback: (callback: unknown, deps?: ReadonlyArray<unknown>) =>
        memoized(() => callback, deps),
      useEffect: (effect: () => unknown, deps?: ReadonlyArray<unknown>) => {
        const existing = slotAt();
        if (existing === undefined || depsChanged(existing.deps, deps))
          queued.push(effect);
        keep({ value: undefined, deps });
      },
    },
    reset() {
      slots.length = 0;
      queued.length = 0;
      cursor = 0;
    },
    render<T>(component: () => T): T {
      cursor = 0;
      const tree = component();
      for (const effect of queued.splice(0)) effect();
      return tree;
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, ...reactHarness.hooks };
});

const LISTING = {
  configured: true,
  readable: true,
  files: [
    { name: "a.csv", sizeBytes: 64, modifiedAt: 1_700_000_000_000 },
    { name: "b.csv", sizeBytes: 128, modifiedAt: 1_700_000_000_000 },
  ],
};

// The mounted files are tab-separated, so a read by the comma the picker starts on
// yields the whole header as one column and a read by the tab yields the columns
// the run would see. That difference is what makes a stale confirm panel visible.
const COMMA_COLUMNS = ["ssn\tlast_name"];
const TAB_COLUMNS = ["ssn", "last_name"];

const COMMA = resolveCsvDelimiter({ option: ",", other: "" });
const TAB = resolveCsvDelimiter({ option: "\t", other: "" });

const profileRequests: Array<{ name: string; delimiter: string | null }> = [];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function profileWire(name: string, columns: Array<string>) {
  return {
    name,
    sizeBytes: 64,
    modifiedAt: 1_700_000_000_000,
    rowCount: 3,
    columns,
    sanitizedColumnPositions: [],
    columnSamples: columns.map((column) => ({ column, values: ["value"] })),
  };
}

/** Let the listing and profile fetches settle: each resolution runs through the
 * client's bounded body read before it reaches the picker's state. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 3; turn += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

/** The first prop of `name` in the element tree, searched depth-first -- the way a
 * stage's own handler is reached without a renderer. */
function findProp<T>(node: unknown, name: string): T | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findProp<T>(child, name);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof node !== "object" || node === null) return undefined;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props === undefined) return undefined;
  if (name in props && props[name] !== undefined) return props[name] as T;
  return findProp<T>(props.children, name);
}

function renderPicker(options: {
  committed?: WorkInputReference;
  delimiter: CsvDelimiterResolution;
}): unknown {
  return reactHarness.render(() =>
    ServerFilePicker({
      committed: options.committed,
      delimiter: options.delimiter,
      onUse: () => {},
    }),
  );
}

/** The columns the confirm stage is showing, from the profile it holds. */
function confirmedColumns(tree: unknown): Array<string> | undefined {
  const profile = findProp<JobInputProfileResult | "loading">(tree, "profile");
  if (profile === undefined || profile === "loading") return undefined;
  return profile.kind === "profile" ? profile.profile.columns : undefined;
}

beforeEach(() => {
  reactHarness.reset();
  profileRequests.length = 0;
  vi.stubGlobal("fetch", (input: string) => {
    const url = new URL(input, "http://localhost");
    if (url.pathname === "/api/jobs/inputs")
      return Promise.resolve(jsonResponse(LISTING));
    if (url.pathname === "/api/jobs/inputs/profile") {
      const name = url.searchParams.get("name") ?? "";
      const delimiter = url.searchParams.get("delimiter");
      profileRequests.push({ name, delimiter });
      return Promise.resolve(
        jsonResponse(
          profileWire(name, delimiter === "\t" ? TAB_COLUMNS : COMMA_COLUMNS),
        ),
      );
    }
    throw new Error(`unexpected request to ${url.pathname}`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the delimiter change re-profiles the file on screen", () => {
  test("the open selection, with nothing committed yet", async () => {
    renderPicker({ delimiter: COMMA });
    await settle();
    const listing = renderPicker({ delimiter: COMMA });
    findProp<(name: string) => void>(listing, "onSelect")?.("b.csv");
    await settle();
    expect(confirmedColumns(renderPicker({ delimiter: COMMA }))).toEqual(
      COMMA_COLUMNS,
    );

    renderPicker({ delimiter: TAB });
    await settle();
    // The columns the operator confirms are the columns the new choice reads: a
    // panel left on the previous read would commit terms the run cannot reproduce.
    expect(profileRequests.at(-1)).toEqual({ name: "b.csv", delimiter: "\t" });
    expect(confirmedColumns(renderPicker({ delimiter: TAB }))).toEqual(
      TAB_COLUMNS,
    );
  });

  test("the open selection, not the file committed before it", async () => {
    const committed: WorkInputReference = { name: "a.csv" };
    renderPicker({ committed, delimiter: COMMA });
    await settle();
    const listing = renderPicker({ committed, delimiter: COMMA });
    findProp<(name: string) => void>(listing, "onSelect")?.("b.csv");
    await settle();

    renderPicker({ committed, delimiter: TAB });
    await settle();
    // Reverting to the committed file here would hand "Use this file" a panel for
    // a file the operator had already moved off.
    expect(profileRequests.at(-1)).toEqual({ name: "b.csv", delimiter: "\t" });
    expect(profileRequests.map((request) => request.name)).not.toContain(
      "a.csv",
    );
  });

  test("the committed file, while the listing is showing", async () => {
    const committed: WorkInputReference = { name: "a.csv" };
    renderPicker({ committed, delimiter: COMMA });
    await settle();

    renderPicker({ committed, delimiter: TAB });
    await settle();
    expect(profileRequests).toEqual([{ name: "a.csv", delimiter: "\t" }]);
    expect(
      confirmedColumns(renderPicker({ committed, delimiter: TAB })),
    ).toEqual(TAB_COLUMNS);
  });

  test("nothing at all, with no file committed and none open", async () => {
    renderPicker({ delimiter: COMMA });
    await settle();

    renderPicker({ delimiter: TAB });
    await settle();
    expect(profileRequests).toEqual([]);
  });
});
