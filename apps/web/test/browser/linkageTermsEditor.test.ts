/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { INVITATION_LIFETIME_SECONDS } from "@psilink/core";

import { seedAdvancedInvite } from "@psi/advancedInvite";

import { LinkageTermsEditor } from "@components/LinkageTermsEditor";

import type { Root } from "react-dom/client";

import type { LinkageTerms } from "@psilink/core";

import type { AdvancedInviteSeed } from "@psi/advancedInvite";

// A file carrying every default linkage column, so the seed keeps the full key set.
const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

let container: HTMLElement | undefined;
let root: Root | undefined;
const onGenerate =
  vi.fn<(terms: LinkageTerms, lifetimeSeconds: number) => void>();

function mount(initialIdentity = "County Health Dept"): AdvancedInviteSeed {
  const { seed } = seedAdvancedInvite(initialIdentity, ALL_COLUMNS);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    createElement(
      MantineProvider,
      null,
      createElement(LinkageTermsEditor, { seed, initialIdentity, onGenerate }),
    ),
  );
  return seed;
}

const nameField = () => page.getByRole("textbox", { name: "Your name" });
const generateButton = () =>
  page.getByRole("button", { name: "Generate invitation" });

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  onGenerate.mockReset();
});

describe("LinkageTermsEditor", () => {
  test("renders seeded with a live preview and an enabled Generate", async () => {
    mount();
    await expect.element(nameField()).toHaveValue("County Health Dept");
    // The live preview is the acceptor consent renderer in the proposing view.
    await expect
      .element(page.getByText("Terms you are proposing"))
      .toBeInTheDocument();
    await expect.element(generateButton()).toBeEnabled();
  });

  test("Generate yields both-receive psi terms and the chosen lifetime", async () => {
    mount();
    await userEvent.click(generateButton());
    expect(onGenerate).toHaveBeenCalledTimes(1);
    const [terms, lifetime] = onGenerate.mock.calls[0];
    // The controls the editor does not expose stay at their safe defaults.
    expect(terms.output).toEqual({
      expectsOutput: true,
      shareWithPartner: true,
    });
    expect(terms.algorithm).toBe("psi");
    expect(terms.deduplicate).toBe(false);
    expect(lifetime).toBe(INVITATION_LIFETIME_SECONDS);
  });

  test("choosing 'Only your partner' yields partner-only output terms", async () => {
    // The 3-way output control is wired to the built terms: selecting the
    // partner-only direction produces the corresponding one-sided output pair (the
    // editor never offers the forbidden "neither receives" combination).
    mount();
    // Wait for the editor to finish its initial render/hydration before driving
    // the Select, so the click does not race an unmounted control under load.
    await expect.element(generateButton()).toBeEnabled();
    // Mantine's Select input has role=combobox; target it by role+name rather than
    // by label, since the open options listbox shares the same aria label (a
    // getByLabelText would match both). Clicking opens the dropdown.
    await userEvent.click(
      page.getByRole("combobox", { name: "Who receives the matched results" }),
    );
    // Target the dropdown option by role, not text: the Select's description also
    // contains the substring "only your partner".
    await userEvent.click(
      page.getByRole("option", { name: "Only your partner" }),
    );
    await userEvent.click(generateButton());
    const [terms] = onGenerate.mock.calls[0];
    expect(terms.output).toEqual({
      expectsOutput: false,
      shareWithPartner: true,
    });
  });

  test("Reset to recommended restores the output direction to both-receive", async () => {
    // The output direction is the headline new control, so pin that reset returns
    // it to the symmetric default (asserted via Generate, not the Select display).
    mount();
    await expect.element(generateButton()).toBeEnabled();
    await userEvent.click(
      page.getByRole("combobox", { name: "Who receives the matched results" }),
    );
    await userEvent.click(
      page.getByRole("option", { name: "Only your partner" }),
    );
    await userEvent.click(
      page.getByRole("button", { name: "Reset to recommended" }),
    );
    await userEvent.click(generateButton());
    const [terms] = onGenerate.mock.calls[0];
    expect(terms.output).toEqual({
      expectsOutput: true,
      shareWithPartner: true,
    });
  });

  test("clearing the name disables Generate and shows an inline error", async () => {
    mount();
    await userEvent.clear(nameField());
    await expect.element(generateButton()).toBeDisabled();
    await expect
      .element(page.getByText("Enter a name to identify yourself."))
      .toBeInTheDocument();
  });

  test("Reset to recommended restores the seeded name after an edit", async () => {
    mount();
    await userEvent.clear(nameField());
    await userEvent.fill(nameField(), "Changed Name");
    await userEvent.click(
      page.getByRole("button", { name: "Reset to recommended" }),
    );
    await expect.element(nameField()).toHaveValue("County Health Dept");
  });

  test("a keyboard move control reorders the linkage keys", async () => {
    const seed = mount();
    const firstName = seed.terms.linkageKeys[0].name;
    // Keyboard-operable reorder (move controls, not drag): send the first key
    // later, then generate and confirm the embedded order changed.
    await userEvent.click(
      page.getByRole("button", { name: `Move ${firstName} later` }),
    );
    await userEvent.click(generateButton());
    const [terms] = onGenerate.mock.calls[0];
    expect(terms.linkageKeys[0].name).not.toBe(firstName);
    expect(terms.linkageKeys[1].name).toBe(firstName);
  });

  test("attaching a legal agreement requires a future-dated, complete block", async () => {
    mount();
    await userEvent.click(page.getByText("Attach a legal agreement"));
    // Incomplete -> Generate blocked.
    await expect.element(generateButton()).toBeDisabled();
    await userEvent.fill(
      page.getByRole("textbox", { name: "Agreement reference" }),
      "MOU-2025-0042",
    );
    await userEvent.fill(
      page.getByRole("textbox", { name: "Purpose of the disclosure" }),
      "Program evaluation",
    );
    await userEvent.fill(page.getByLabelText("Expiration date"), "2099-01-01");
    await expect.element(generateButton()).toBeEnabled();
    await userEvent.click(generateButton());
    const [terms] = onGenerate.mock.calls[0];
    expect(terms.legalAgreement?.reference).toBe("MOU-2025-0042");
  });
});
