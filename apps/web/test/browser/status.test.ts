/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { ProcessState } from "@psilink/core";

import { Status } from "@components/Status";

import type { Root } from "react-dom/client";

const stages = [
  {
    id: "before start",
    label: "Before start",
    state: ProcessState.BeforeStart,
  },
  { id: "working", label: "Confirming protocol", state: ProcessState.Working },
  { id: "done", label: "Done", state: ProcessState.Done },
];

let container: HTMLElement | undefined;
let root: Root | undefined;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
});

function renderStatus(stageId: string) {
  root!.render(
    createElement(
      MantineProvider,
      null,
      createElement(Status, { stages, stageId, resultsFileURL: undefined }),
    ),
  );
}

describe("Status live region", () => {
  test("scopes a single polite live region to the stage label only", async () => {
    renderStatus("working");
    // root.render commits asynchronously; wait for the stage label before querying.
    await expect
      .element(page.getByText("Confirming protocol"))
      .toBeInTheDocument();

    // Exactly one polite live region, and it is the stage-label wrapper -- not the
    // card (which carries the "Status" heading and, mid-run, the download
    // controls), so a stage change announces just the new stage rather than the
    // whole card.
    const regions = container!.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(1);
    const live = regions[0];
    expect(live.getAttribute("aria-atomic")).toBe("true");

    expect(live.textContent).toContain("Confirming protocol");
    // The region does not wrap the heading or the download affordances.
    expect(live.textContent).not.toContain("Status");
    expect(live.textContent).not.toContain("Download result");
    // The card around it does carry those, so they are present on screen, just
    // outside the announced region.
    expect(container!.textContent).toContain("Status");
    expect(container!.textContent).toContain("Download result");
  });
});
