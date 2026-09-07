/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so components render with their real geometry (the
// exchange browser suites' shared discipline).
import "@mantine/core/styles.css";

import { MAX_NAME_LENGTH } from "@psilink/core";

import { InviterScreen } from "@exchange/InviterScreen";

import { isolatedColumnName } from "@components/ColumnName";

import { createAppMount } from "./renderApp";

// The recurring-save offer's refusal disables its own deposit, so it must not
// outlive the exchange it was about. The screen keeps one component instance
// across the browser Back that reaches Review & create, which is the documented
// way back to fix a header, so a refusal left standing there would disable Save
// for the rest of the session with nothing on screen to explain it.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

// The rendezvous listen runs only inside the run lifecycle's acquire closure,
// which the lifecycle stub below never invokes.
vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

vi.mock("@psi/exchangeLifecycle", () => ({
  runExchangeLifecycle: () => Promise.resolve(),
}));

/** A header past the wire ceiling: admitted at intake (core's inference bounds
 * only the empty name), refused by the stored record's schema, and left out of
 * the send set below so the mint itself has nothing to refuse. */
const OVERLONG_HEADER = "diagnosis_code_".padEnd(MAX_NAME_LENGTH + 1, "x");

const app = createAppMount();

afterEach(app.unmount);

const saveButton = () =>
  page.getByRole("button", { name: "Save as a recurring exchange" });

/** Walk the spine to a minted invitation over a file whose last header is
 * oversized, with that column set so it is never sent. */
async function mintOverOverlongHeader() {
  app.render(createElement(InviterScreen));
  await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
  await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
  const fileInput = document.querySelector('input[type="file"]');
  await userEvent.upload(
    page.elementLocator(fileInput as HTMLElement),
    new File(
      [
        `client_id,first_name,last_name,dob,${OVERLONG_HEADER}\n` +
          "1,Ann,Lee,01/02/1990,A\n2,Bo,Ray,03/04/1985,B\n",
      ],
      "clients.csv",
      { type: "text/csv" },
    ),
  );
  await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
  await page
    .getByRole("button", { name: "Continue to matching & sharing" })
    .click();
  await page
    .getByLabelText(`How ${isolatedColumnName(OVERLONG_HEADER)} is used`)
    .selectOptions("ignored");
  await page
    .getByRole("button", { name: "Continue to review & create" })
    .click();
  await page.getByRole("button", { name: "Create the invitation" }).click();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("Your invitation is ready");
}

describe("the recurring-save offer after a refused deposit", () => {
  test("a re-mint reached by browser Back opens the offer clear", async () => {
    await mintOverOverlongHeader();

    // The stored record bounds every declared name, sent or not, so the deposit
    // is refused over the header and the offer names the column.
    await saveButton().click();
    await expect
      .element(page.getByText("Column 5", { exact: false }))
      .toBeInTheDocument();
    await expect.element(saveButton()).toBeDisabled();

    // The way back to the header row, which the screen keeps state across.
    window.history.back();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Review & create");

    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your invitation is ready");

    // The fresh exchange's offer is open again, and the refusal it would
    // otherwise be blocked by is gone from the screen.
    await expect.element(saveButton()).toBeEnabled();
    expect(page.getByText("Column 5", { exact: false }).query()).toBeNull();
  });
});
