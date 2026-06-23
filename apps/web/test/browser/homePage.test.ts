/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { HomePage } from "@components/HomePage";

import type { Root } from "react-dom/client";

import type { GeneratedInvitation } from "@psi/invitation";
import type { LinkageTerms } from "@psilink/core";

// HomePage owns the inviter session AND the shared data-file selection, and swaps
// its whole layout on generate: the two-column compose grid (InvitePanel +
// AcceptForm) plus the shared file drop below them give way to a single centered
// exchange panel with the accept form and the drop dropped. This suite drives a
// generate through InvitePanel's form -- seeding the lifted file via the (mocked)
// shared drop -- and asserts that takeover, the layout choice invitePanel.test.ts,
// which mounts InvitePanel alone, cannot see.

// The only router seam the rendered graph touches: InvitePanel's Advanced link and
// AcceptForm's submit navigate. This suite asserts layout, not navigation.
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => () => undefined,
}));

// Resolve a generated invitation on demand; keep the module's other exports intact
// via importOriginal, mirroring invitePanel.test.ts (this suite drives only the
// success path, so it never reaches InvitePanel's InvitationFileError branch).
const gen = vi.hoisted(() => ({
  impl: undefined as
    | ((params: {
        inviterName: string;
        file: unknown;
      }) => Promise<GeneratedInvitation>)
    | undefined,
}));
vi.mock("@psi/invitation", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    generateInvitation: (params: { inviterName: string; file: unknown }) => {
      if (gen.impl === undefined)
        throw new Error("homePage test: gen.impl was not set");
      return gen.impl(params);
    },
  };
});

// Stub the exchange screen (it pulls in the PSI WASM and a rendezvous); a testid is
// enough to assert the takeover rendered it in place of the grid.
vi.mock("@components/ExchangeView", () => ({
  ExchangeView: () =>
    createElement("div", { "data-testid": "exchange-view" }, "exchange"),
}));

// Stand in for the shared drop (the real Mantine Dropzone is awkward to drive
// headlessly): a button that seeds the lifted file selection, which HomePage feeds
// to both panels. InvitePanel renders its own Generate button, gated on this file.
vi.mock("@components/FileDropzone", () => ({
  default: (props: {
    files: Array<File>;
    setFiles: (files: Array<File>) => void;
  }) =>
    createElement(
      "button",
      {
        "data-testid": "select-file",
        onClick: () => props.setFiles([new File(["c\n1\n"], "data.csv")]),
      },
      "select",
    ),
}));

const terms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Dept",
  date: "2026-01-01",
  algorithm: "psi",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" }],
  linkageKeys: [{ name: "first", elements: [{ field: "firstName" }] }],
};

const generated: GeneratedInvitation = {
  encoded: "ENCODED_TOKEN",
  deepLink: "https://example.org/accept#ENCODED_TOKEN",
  sharedSecret: "SECRET",
  expires: "2099-01-01T00:00:00.000Z",
  linkageTerms: terms,
  rawRows: [{ first_name: "Alice" }],
  columns: ["first_name"],
};

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(MantineProvider, null, createElement(HomePage)));
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  gen.impl = undefined;
});

describe("HomePage layout", () => {
  test("resting state shows both compose panels and the shared file drop, no exchange", async () => {
    gen.impl = () => Promise.resolve(generated);
    mount();

    await expect
      .element(page.getByText("Invite someone to join you in a data exchange"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Accept an invitation you were sent"))
      .toBeInTheDocument();
    // The single shared drop sits below both panels (its heading -- not the
    // invite panel's "...choose your data file below" intro prose).
    await expect
      .element(page.getByRole("heading", { name: "Your data file" }))
      .toBeInTheDocument();
    // No exchange screen until an invitation exists.
    expect(page.getByTestId("exchange-view").query()).toBeNull();
  });

  test("generating an invitation takes over the view: accept form and shared drop dropped, exchange shown", async () => {
    gen.impl = () => Promise.resolve(generated);
    mount();

    // The name field is targeted by placeholder so it is unambiguous beside the
    // accept form's textarea (both expose the textbox role).
    await userEvent.fill(
      page.getByPlaceholder("Your name"),
      "County Health Dept",
    );
    await userEvent.click(page.getByTestId("select-file"));
    await userEvent.click(
      page.getByRole("button", { name: "Generate invitation" }),
    );

    // The exchange screen takes over the whole view...
    await expect.element(page.getByTestId("exchange-view")).toBeInTheDocument();
    // ...and the accept form and the shared drop (the rest of the compose layout)
    // are dropped.
    expect(
      page.getByText("Accept an invitation you were sent").query(),
    ).toBeNull();
    expect(
      page.getByRole("heading", { name: "Your data file" }).query(),
    ).toBeNull();
  });
});
