/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import {
  clearAdvancedHandoff,
  stashAdvancedHandoff,
} from "@components/advancedHandoff";
import { AdvancedInvite } from "@components/AdvancedInvite";

import type { Root } from "react-dom/client";

import type { ExchangeConfig } from "@components/ExchangeView";
import type { GeneratedInvitation } from "@psi/invitation";
import type { LinkageTerms } from "@psilink/core";

// Drive generateInvitation from the test; keep InvitationFileError real so
// `instanceof` matches in AdvancedInvite.
const gen = vi.hoisted(() => ({
  impl: undefined as
    | ((params: {
        linkageTerms?: LinkageTerms;
      }) => Promise<GeneratedInvitation>)
    | undefined,
}));
vi.mock("@psi/invitation", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    generateInvitation: (params: { linkageTerms?: LinkageTerms }) => {
      if (gen.impl === undefined)
        throw new Error("advancedInvite test: gen.impl was not set");
      return gen.impl(params);
    },
  };
});

// Stand in for the exchange screen (avoids loading the PSI wasm) and capture its
// props, so the generate transition can be asserted.
const exchange = vi.hoisted(() => ({
  lastProps: undefined as ExchangeConfig | undefined,
}));
vi.mock("@components/ExchangeView", () => ({
  ExchangeView: (props: ExchangeConfig) => {
    exchange.lastProps = props;
    return createElement("div", { "data-testid": "exchange-view" }, "exchange");
  },
}));

const CSV = "ssn,first_name,last_name,dob\n123456789,Alice,Smith,1990-01-02\n";

function csvFile(): File {
  return new File([CSV], "data.csv", { type: "text/csv" });
}

const generated: GeneratedInvitation = {
  encoded: "ENCODED",
  deepLink: "https://example.org/accept#ENCODED",
  sharedSecret: "SECRET",
  expires: "2099-01-01T00:00:00.000Z",
  linkageTerms: {
    version: "1.0.0",
    identity: "County Health Dept",
    date: "2026-01-01",
    algorithm: "psi",
    output: { expectsOutput: true, shareWithPartner: true },
    deduplicate: false,
    linkageFields: [{ name: "first_name", type: "first_name" }],
    linkageKeys: [{ name: "first", elements: [{ field: "first_name" }] }],
  },
  rawRows: [{ first_name: "Alice" }],
  columns: ["first_name"],
};

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    createElement(MantineProvider, null, createElement(AdvancedInvite)),
  );
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  exchange.lastProps = undefined;
  gen.impl = undefined;
  clearAdvancedHandoff();
});

describe("AdvancedInvite", () => {
  test("cold load shows its own file picker", async () => {
    mount();
    await expect
      .element(
        page.getByText("Choose your data file to begin.", { exact: false }),
      )
      .toBeInTheDocument();
    // No editor yet.
    expect(page.getByText("Customize your invitation").query()).toBeNull();
  });

  test("a warm hand-off seeds the editor without a re-drop", async () => {
    stashAdvancedHandoff({ file: csvFile(), name: "County Health Dept" });
    mount();
    // The header is read and the editor opens, name prefilled from the hand-off.
    await expect
      .element(page.getByText("Customize your invitation"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("textbox", { name: "Your name" }))
      .toHaveValue("County Health Dept");
  });

  test("generating from the editor transitions to the exchange screen", async () => {
    gen.impl = () => Promise.resolve(generated);
    stashAdvancedHandoff({ file: csvFile(), name: "County Health Dept" });
    mount();

    await expect
      .element(page.getByRole("button", { name: "Generate invitation" }))
      .toBeEnabled();
    await userEvent.click(
      page.getByRole("button", { name: "Generate invitation" }),
    );

    await expect.element(page.getByTestId("exchange-view")).toBeInTheDocument();
    expect(exchange.lastProps?.role).toBe("inviter");
    expect(exchange.lastProps?.linkageTerms).toBe(generated.linkageTerms);
  });
});
