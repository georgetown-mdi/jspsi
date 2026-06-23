/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { InvitationFileError } from "@psi/invitation";

import {
  clearAdvancedHandoff,
  peekAdvancedHandoff,
} from "@components/advancedHandoff";
import { InvitePanel } from "@components/InvitePanel";

import type { Root } from "react-dom/client";

import type { ExchangeConfig } from "@components/ExchangeView";
import type { GeneratedInvitation } from "@psi/invitation";
import type { InviterSession } from "@components/InvitePanel";
import type { LinkageTerms } from "@psilink/core";

// Drive generateInvitation from the test: each case sets `gen.impl`. The real
// module (and its InvitationFileError class, so `instanceof` in InvitePanel and
// here refer to the same class) is preserved; only the entry point is swapped.
// Capture navigation: InvitePanel's "Advanced Options" link navigates to the
// editor route via useNavigate. Mock the router so the panel can mount without a
// RouterProvider (the render-test pattern) and record where it navigates.
const nav = vi.hoisted(() => ({ calls: [] as Array<unknown> }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => (opts: unknown) => {
    nav.calls.push(opts);
  },
}));

const gen = vi.hoisted(() => ({
  impl: undefined as
    | ((params: {
        inviterName: string;
        file: unknown;
      }) => Promise<GeneratedInvitation>)
    | undefined,
}));
vi.mock("@psi/invitation", async (importOriginal) => {
  // Keep every real export (notably InvitationFileError, so `instanceof` in
  // InvitePanel and here refer to the same class) and swap only the entry point.
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    generateInvitation: (params: { inviterName: string; file: unknown }) => {
      // Fail loudly rather than return undefined: a test that triggers compose
      // without setting gen.impl should get a clear error here, not a confusing
      // downstream `undefined is not a Promise`.
      if (gen.impl === undefined)
        throw new Error("invitePanel test: gen.impl was not set");
      return gen.impl(params);
    },
  };
});

// Capture the props InvitePanel hands the exchange screen: this is the seam the
// "reuses the embedded terms and parsed rows" criterion turns on -- the inviter's
// run is configured entirely from what generateInvitation returned.
const exchange = vi.hoisted(() => ({
  lastProps: undefined as ExchangeConfig | undefined,
}));
vi.mock("@components/ExchangeView", () => ({
  ExchangeView: (props: ExchangeConfig) => {
    exchange.lastProps = props;
    return createElement("div", { "data-testid": "exchange-view" }, "exchange");
  },
}));

// The CSV the harness's "select file" button seeds. A hoisted handle so a test can
// pick the file's columns before clicking (InvitePanel reads the header to derive
// the "What you will send" disclosure); defaults to a single `other` column.
const fileSeed = vi.hoisted(() => ({
  content: ["c\n1\n"] as Array<string>,
  name: "data.csv",
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
let consoleErrorSpy: ReturnType<typeof vi.spyOn> | undefined;

// InvitePanel is now controlled on two axes: HomePage owns the inviter session
// (fed back so the panel can swap the compose form for the exchange view) AND the
// shared data-file selection (the drop now lives below both compose panels, not in
// this one). Stand in for that owner with a minimal stateful harness: a "select
// file" button seeds the lifted `files`, and generating drives the session
// transition exactly as it does under HomePage.
function Harness() {
  const [session, setSession] = useState<InviterSession>();
  const [files, setFiles] = useState<Array<File>>([]);
  return createElement(
    "div",
    null,
    createElement(
      "button",
      {
        "data-testid": "select-file",
        onClick: () => setFiles([new File(fileSeed.content, fileSeed.name)]),
      },
      "select",
    ),
    createElement(InvitePanel, { session, setSession, files }),
  );
}

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(MantineProvider, null, createElement(Harness)));
}

// Enter a name, select a file, then click Generate -- the full compose action.
// Generate is InvitePanel's own button now (the drop and its button no longer live
// here), gated on the lifted file being present.
async function compose(name = "County Health Dept") {
  await userEvent.fill(page.getByRole("textbox"), name);
  await userEvent.click(page.getByTestId("select-file"));
  await userEvent.click(
    page.getByRole("button", { name: "Generate invitation" }),
  );
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  exchange.lastProps = undefined;
  gen.impl = undefined;
  nav.calls.length = 0;
  fileSeed.content = ["c\n1\n"];
  fileSeed.name = "data.csv";
  clearAdvancedHandoff();
  consoleErrorSpy?.mockRestore();
  consoleErrorSpy = undefined;
});

describe("InvitePanel compose screen", () => {
  test("Advanced Options appears only once a file is chosen and navigates to the editor", async () => {
    gen.impl = () => Promise.resolve(generated);
    mount();

    // No file yet: the lone Advanced Options link (now inside the disclosure) is
    // absent -- there is nothing to take into the editor.
    expect(page.getByText("Advanced Options").query()).toBeNull();

    await userEvent.click(page.getByTestId("select-file"));

    const advanced = page.getByText("Advanced Options");
    await expect.element(advanced).toBeInTheDocument();
    const el = advanced.element() as HTMLElement;
    expect(el.tagName).toBe("BUTTON");

    await userEvent.click(advanced);
    expect(nav.calls).toContainEqual({ to: "/advanced" });
  });

  test("Advanced Options hands off the chosen file and name in memory", async () => {
    gen.impl = () => Promise.resolve(generated);
    mount();

    await userEvent.fill(page.getByRole("textbox"), "  Dr. Jane  ");
    await userEvent.click(page.getByTestId("select-file"));

    const advanced = page.getByText("Advanced Options");
    await expect.element(advanced).toBeInTheDocument();
    await userEvent.click(advanced);

    // The editor route reads this in-memory hand-off on arrival: the chosen file
    // and the trimmed name, so it opens seeded without a re-drop.
    const handoff = peekAdvancedHandoff();
    expect(handoff?.file).toBeInstanceOf(File);
    expect(handoff?.name).toBe("Dr. Jane");
    expect(nav.calls).toContainEqual({ to: "/advanced" });
  });

  test("surfaces exactly the columns the quick path will send, as a chip list", async () => {
    gen.impl = () => Promise.resolve(generated);
    // first_name (linkage, not sent), record_id (inferred row identifier, still
    // sent on the un-normalized quick path), notes (other, sent).
    fileSeed.content = ["first_name,record_id,notes\n", "Alice,1,vip\n"];
    mount();
    await userEvent.click(page.getByTestId("select-file"));

    await expect
      .element(page.getByText("What you will send"))
      .toBeInTheDocument();
    // The disclosed set, derived from the same predicate the wire uses -- the
    // identifier and other columns, never the linkage one -- shown as chips.
    await expect.element(page.getByText("record_id")).toBeInTheDocument();
    await expect.element(page.getByText("notes")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("first_name");
  });

  test("shows the no-columns disclosure (still with Advanced Options) when the quick path sends nothing", async () => {
    gen.impl = () => Promise.resolve(generated);
    // Start with a disclosing file so the chip list is present...
    fileSeed.content = ["first_name,notes\n", "Alice,vip\n"];
    mount();
    await userEvent.click(page.getByTestId("select-file"));
    await expect
      .element(page.getByText(/For each row that matches/))
      .toBeInTheDocument();

    // ...then choose a file whose columns are all linkage types, so nothing is
    // disclosed: the chip sentence is withdrawn, but the disclosure stays so the
    // user still learns nothing is sent AND still has the one Advanced Options link.
    fileSeed.content = ["first_name,ssn\n", "Alice,123-45-6789\n"];
    await userEvent.click(page.getByTestId("select-file"));
    await expect
      .element(
        page.getByText("No column values will be sent to your partner.", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(page.getByText(/For each row that matches/).query()).toBeNull();
    await expect
      .element(page.getByText("Advanced Options"))
      .toBeInTheDocument();
  });

  test("on success, transitions to the exchange screen carrying share artifacts, terms, rows, secret", async () => {
    gen.impl = () => Promise.resolve(generated);
    mount();
    await compose();

    // The exchange screen mounts and now owns the share block, so the share
    // artifacts are handed to it rather than rendered by InvitePanel directly.
    await expect.element(page.getByTestId("exchange-view")).toBeInTheDocument();

    // The inviter's run is configured from the returned invitation: the share
    // link/code, the SAME embedded terms object and the SAME parsed rows/columns
    // (no re-derivation, no re-parse), plus the secret and expiry.
    const props = exchange.lastProps;
    expect(props?.role).toBe("inviter");
    expect(props?.partyName).toBe("County Health Dept");
    expect(props?.sharedSecret).toBe(generated.sharedSecret);
    expect(props?.expires).toBe(generated.expires);
    if (props?.role !== "inviter") throw new Error("expected inviter config");
    expect(props.share).toEqual({
      deepLink: generated.deepLink,
      encoded: generated.encoded,
    });
    expect(props.linkageTerms).toBe(generated.linkageTerms);
    expect(props.acquired.rawRows).toBe(generated.rawRows);
    expect(props.acquired.columns).toBe(generated.columns);
  });

  test("forwards the entered name and the selected file to generateInvitation", async () => {
    const calls: Array<{ inviterName: string; file: unknown }> = [];
    gen.impl = (params) => {
      calls.push(params);
      return Promise.resolve(generated);
    };
    mount();
    await compose("  Dr. Jane  ");

    expect(calls).toHaveLength(1);
    // The name is trimmed before it becomes the inviter identity.
    expect(calls[0].inviterName).toBe("Dr. Jane");
    expect(calls[0].file).toBeInstanceOf(File);
  });

  test("an unlinkable file blocks before any exchange, naming the missing fields", async () => {
    gen.impl = () =>
      Promise.reject(
        new InvitationFileError({
          kind: "unlinkable",
          unsatisfied: [
            { name: "ssn", type: "ssn" },
            { name: "firstName", type: "first_name" },
          ],
        }),
      );
    mount();
    await compose();

    await expect
      .element(page.getByText("This file cannot be linked"))
      .toBeInTheDocument();
    expect(document.body.textContent).toContain("ssn (ssn)");
    expect(document.body.textContent).toContain("firstName (first_name)");
    // No exchange screen: nothing was minted, so nothing dials.
    expect(page.getByTestId("exchange-view").query()).toBeNull();
  });

  test("an unreadable file surfaces a read error and no exchange", async () => {
    gen.impl = () =>
      Promise.reject(
        new InvitationFileError({
          kind: "unreadable",
          cause: new Error("the file could not be parsed"),
        }),
      );
    mount();
    await compose();

    await expect
      .element(page.getByText("Could not read your file"))
      .toBeInTheDocument();
    expect(document.body.textContent).toContain("the file could not be parsed");
    expect(page.getByTestId("exchange-view").query()).toBeNull();
  });

  test("an internal failure shows a fixed message and logs only the error type", async () => {
    // The dev-gated console.error carries only the error name; swallow it so the
    // assertion output stays clean.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    gen.impl = () => Promise.reject(new Error("zod boom"));
    mount();
    await compose();

    await expect
      .element(
        page.getByText("Could not generate the invitation. Please try again."),
      )
      .toBeInTheDocument();
    // The raw error text is not echoed into the secret-bearing flow.
    expect(document.body.textContent).not.toContain("zod boom");
    expect(page.getByTestId("exchange-view").query()).toBeNull();
  });

  test("pressing Enter with no file selected prompts for a file, mints nothing", async () => {
    const calls: Array<unknown> = [];
    gen.impl = (params) => {
      calls.push(params);
      return Promise.resolve(generated);
    };
    mount();
    // Name entered, but no file selected: the Generate button stays disabled, and
    // Enter on the name field must say so rather than silently doing nothing.
    await userEvent.fill(page.getByRole("textbox"), "County Health Dept");
    await userEvent.keyboard("{Enter}");

    await expect
      .element(page.getByText("Choose a data file"))
      .toBeInTheDocument();
    // No invitation was generated and no exchange screen appeared.
    expect(calls).toHaveLength(0);
    expect(page.getByTestId("exchange-view").query()).toBeNull();
  });
});
