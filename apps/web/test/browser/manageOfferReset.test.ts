/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so components render with their real geometry (the
// exchange browser suites' shared discipline).
import "@mantine/core/styles.css";

import {
  MAX_NAME_LENGTH,
  encodeInvitation,
  generateSharedSecret,
} from "@psilink/core";

import { AcceptorScreen } from "@exchange/AcceptorScreen";
import { InviterScreen } from "@exchange/InviterScreen";

import { isolatedColumnName } from "@components/ColumnName";

import { createAppMount } from "./renderApp";

import type { InvitationToken, LinkageTerms } from "@psilink/core";

// The recurring-save offer's refusal disables its own deposit, so it must not
// outlive the exchange it was about. Each seat keeps one component instance
// across the browser Back that reaches its own way back to a header fix -- the
// inviter's Review & create, the acceptor's confirm-columns step -- so a refusal
// left standing there would disable Save for the rest of the session with
// nothing on screen to explain it.

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

afterEach(() => {
  app.unmount();
  window.location.hash = "";
});

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

/** The invitation the acceptor seat walks: a webrtc endpoint, since the offer is
 * webrtc-only, over two keys the file below satisfies. */
const acceptorTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
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

async function encodeAcceptToken(): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: acceptorTerms,
    sharedSecret: generateSharedSecret(),
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
  return encodeInvitation(token);
}

/** Walk the acceptor's spine to a launched exchange over a file whose last
 * header is oversized, with that column set so it is never sent -- the launch
 * gate refuses an oversized name the run would transmit. */
async function launchOverOverlongHeader() {
  window.location.hash = await encodeAcceptToken();
  app.render(createElement(AcceptorScreen));
  await expect
    .element(page.getByText("Invitation from County Health Department"))
    .toBeInTheDocument();
  await page
    .getByRole("button", { name: "Continue: consent & your file" })
    .click();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("Consent & your file");
  await userEvent.click(page.getByRole("checkbox"));
  await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
  const fileInput = document.querySelector('input[type="file"]');
  await userEvent.upload(
    page.elementLocator(fileInput as HTMLElement),
    new File(
      [`first_name,last_name,${OVERLONG_HEADER}\nAlice,Smith,A\n`],
      "cohort_intake.csv",
      { type: "text/csv" },
    ),
  );
  await expect.element(page.getByText("cohort_intake.csv")).toBeInTheDocument();
  await page.getByRole("button", { name: "Accept and continue" }).click();
  await expect
    .element(page.getByRole("heading", { name: "Confirm your columns" }))
    .toBeInTheDocument();
  await userEvent.click(
    page.getByRole("combobox", {
      name: `How column ${isolatedColumnName(OVERLONG_HEADER)} is used`,
    }),
  );
  await userEvent.click(page.getByRole("option", { name: "Ignored" }));
  await page.getByRole("button", { name: "Start the exchange" }).click();
  await expect.element(saveButton()).toBeInTheDocument();
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

describe("the acceptor's offer after a refused deposit", () => {
  test("a re-launch reached by browser Back opens the offer clear", async () => {
    await launchOverOverlongHeader();

    // The stored record bounds every declared name, sent or not, so the deposit
    // is refused over the header and the offer names the column.
    await saveButton().click();
    await expect
      .element(page.getByText("Column 3", { exact: false }))
      .toBeInTheDocument();
    await expect.element(saveButton()).toBeDisabled();

    // The way back to the columns step, which the screen keeps state across.
    window.history.back();
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Start the exchange" }).click();

    // The fresh exchange's offer is open again, and the refusal it would
    // otherwise be blocked by is gone from the screen.
    await expect.element(saveButton()).toBeEnabled();
    expect(page.getByText("Column 3", { exact: false }).query()).toBeNull();
  });
});
