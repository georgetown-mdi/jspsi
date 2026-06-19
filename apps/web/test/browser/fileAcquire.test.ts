/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import FileAcquire from "@components/FileAcquire";

import type { Root } from "react-dom/client";

import type { AcquiredBundle, AlertContent } from "@components/FileAcquire";
import type { LinkageTerms } from "@psilink/core";

// The acquire phase pulls in only core + FileSelect (no peerjs/WASM), but the real
// Mantine Dropzone is awkward to drive headlessly. Stub FileSelect with a file
// counter and two buttons -- one seeds the selected file from `harness`, one fires
// handleSubmit -- so each test controls the parsed columns precisely. The counter
// lets the test wait for the file-state commit before starting, so handleSubmit
// never reads a stale (empty) selection. (vitest hoists vi.mock above the imports;
// the factory reads `harness` through vi.hoisted.)
const harness = vi.hoisted(() => ({ files: [] as Array<File> }));
vi.mock("@components/FileSelect", () => ({
  default: (props: {
    submitLabel: string;
    submitted: boolean;
    files: Array<File>;
    handleSubmit: () => void;
    setFiles: (files: Array<File>) => void;
  }) =>
    createElement(
      "div",
      null,
      createElement(
        "span",
        { "data-testid": "file-count" },
        String(props.files.length),
      ),
      createElement(
        "button",
        {
          "data-testid": "select",
          onClick: () => props.setFiles(harness.files),
        },
        "select",
      ),
      createElement(
        "button",
        {
          "data-testid": "start",
          disabled: props.submitted,
          onClick: props.handleSubmit,
        },
        props.submitLabel,
      ),
    ),
}));

// Swap core's loadCSVFile per-test to drive the read-failure and teardown-mid-read
// paths, which a real (always-resolving) papaparse parse cannot reach
// deterministically. With impl unset it delegates to the real parser, so the
// pre-flight tests below still run against real CSV parsing and satisfiability.
const csvLoad = vi.hoisted(() => ({
  impl: undefined as ((file: unknown) => Promise<unknown>) | undefined,
}));
vi.mock("@psilink/core", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadCSVFile: (file: unknown) =>
      csvLoad.impl
        ? csvLoad.impl(file)
        : (actual.loadCSVFile as (f: unknown) => Promise<unknown>)(file),
  };
});

// Two single-element linkage keys, one per name field, so a CSV can satisfy both,
// one, or neither -- the three pre-flight outcomes the acceptor distinguishes.
const acceptorTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
};

function csvFile(content: string): File {
  return new File([content], "data.csv", { type: "text/csv" });
}

function makeSpies() {
  return {
    onError: vi.fn((_alert: AlertContent | undefined): void => {}),
    onWarning: vi.fn((_alert: AlertContent | undefined): void => {}),
    onAcquired: vi.fn((_bundle: AcquiredBundle): void => {}),
  };
}
type Spies = ReturnType<typeof makeSpies>;

/** The non-clear (defined) arguments a spy was called with: the acquire phase
 * clears each alert with `undefined` at the start of every attempt, so the
 * meaningful assertions are over the alerts it actually raised. */
function raised(spy: Spies["onError"]): Array<AlertContent> {
  return spy.mock.calls
    .map((c) => c[0])
    .filter((a): a is AlertContent => a !== undefined);
}

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(linkageTerms: LinkageTerms | undefined, spies: Spies) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    createElement(FileAcquire, {
      submitLabel: "Start",
      linkageTerms,
      onError: spies.onError,
      onWarning: spies.onWarning,
      onAcquired: spies.onAcquired,
    }),
  );
}

// Seed the file, wait for the selection to commit (so handleSubmit reads it back
// rather than an empty array), then start.
async function selectAndStart(file: File) {
  harness.files = [file];
  await userEvent.click(page.getByTestId("select"));
  await expect.element(page.getByTestId("file-count")).toHaveTextContent("1");
  await userEvent.click(page.getByTestId("start"));
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  harness.files = [];
  csvLoad.impl = undefined;
});

describe("FileAcquire pre-flight parity", () => {
  test("inviter (no terms) hands off any parsed file with no pre-flight", async () => {
    const spies = makeSpies();
    mount(undefined, spies);
    await selectAndStart(csvFile("notes\nhello\n"));

    await vi.waitFor(() => expect(spies.onAcquired).toHaveBeenCalledTimes(1));
    const bundle = spies.onAcquired.mock.calls[0][0];
    expect(bundle.columns).toEqual(["notes"]);
    expect(bundle.rawRows).toEqual([{ notes: "hello" }]);
    // The inviter is the source of the terms: it never blocks or warns on
    // coverage, even for a file that would be unsatisfiable as an acceptor.
    expect(raised(spies.onError)).toEqual([]);
    expect(raised(spies.onWarning)).toEqual([]);
  });

  test("acceptor with full coverage hands off without a warning", async () => {
    const spies = makeSpies();
    mount(acceptorTerms, spies);
    await selectAndStart(csvFile("first_name,last_name\nAlice,Smith\n"));

    await vi.waitFor(() => expect(spies.onAcquired).toHaveBeenCalledTimes(1));
    const bundle = spies.onAcquired.mock.calls[0][0];
    expect(bundle.columns).toEqual(["first_name", "last_name"]);
    expect(raised(spies.onError)).toEqual([]);
    expect(raised(spies.onWarning)).toEqual([]);
  });

  test("acceptor with partial coverage warns but still hands off", async () => {
    const spies = makeSpies();
    mount(acceptorTerms, spies);
    // Only first_name is present: the "first" key survives, "last" does not.
    await selectAndStart(csvFile("first_name\nAlice\n"));

    await vi.waitFor(() => expect(spies.onAcquired).toHaveBeenCalledTimes(1));
    const warnings = raised(spies.onWarning);
    expect(warnings).toHaveLength(1);
    expect(warnings[0].title).toBe("Partial CSV coverage");
    expect(raised(spies.onError)).toEqual([]);
  });

  test("acceptor with zero coverage blocks and never hands off", async () => {
    const spies = makeSpies();
    mount(acceptorTerms, spies);
    // No name columns at all: no linkage key can match.
    await selectAndStart(csvFile("notes\nhello\n"));

    await vi.waitFor(() => {
      const errors = raised(spies.onError);
      expect(errors).toHaveLength(1);
      expect(errors[0].title).toBe("This file cannot be linked");
    });
    expect(spies.onAcquired).not.toHaveBeenCalled();
  });
});

describe("FileAcquire read failure and teardown", () => {
  test("a read failure blocks with a read-error alert and hands nothing off", async () => {
    // loadCSVFile rejects only on a stream/read error (a malformed-but-readable
    // CSV still resolves), so force the reject to exercise the read-failure branch.
    csvLoad.impl = () => Promise.reject(new Error("stream exploded"));
    const spies = makeSpies();
    mount(acceptorTerms, spies);
    await selectAndStart(csvFile("first_name\nAlice\n"));

    await vi.waitFor(() => {
      const errors = raised(spies.onError);
      expect(errors).toHaveLength(1);
      expect(errors[0].title).toBe("Could not read your file");
    });
    // The read failed before the pre-flight, so nothing is handed off and no
    // partial-coverage warning is raised.
    expect(spies.onAcquired).not.toHaveBeenCalled();
    expect(raised(spies.onWarning)).toEqual([]);
  });

  test("a teardown mid-read hands nothing off and raises no alert", async () => {
    // Hold the parse open so the component unmounts while the read is in flight;
    // the unmount-abort must then suppress the handoff once the read resolves --
    // i.e. no callback fires into the torn-down tree (no setState after unmount).
    let release: (value: unknown) => void = () => {};
    csvLoad.impl = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const spies = makeSpies();
    mount(acceptorTerms, spies);
    await selectAndStart(csvFile("first_name,last_name\nA,B\n"));

    root?.unmount();
    root = undefined;
    // Resolve the now-orphaned read: the aborted attempt must not call back.
    release({
      data: [{ first_name: "A", last_name: "B" }],
      meta: { fields: ["first_name", "last_name"] },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(spies.onAcquired).not.toHaveBeenCalled();
    // Only the start-of-attempt clears (with undefined) were emitted; no defined
    // alert is raised after the teardown.
    expect(raised(spies.onError)).toEqual([]);
    expect(raised(spies.onWarning)).toEqual([]);
  });
});
