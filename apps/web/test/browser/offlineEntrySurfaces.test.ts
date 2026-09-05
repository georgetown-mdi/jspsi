/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import {
  acceptorColumnsEditorState,
  acceptorInitialColumnsState,
  acceptorVerdict,
} from "@exchange/acceptorColumnsModel";
import { AcceptorColumnsStep } from "@exchange/AcceptorColumnsStep";
import { Lobby } from "@exchange/Lobby";

import { DIRECT_LINKAGE_STRATEGY_DEFAULT } from "@exchange/directExchangeModel";
import { DirectConfirmSection } from "@exchange/DirectConfirmSection";
import { InviterScreen } from "@exchange/InviterScreen";
import { OFFLINE_EXCHANGE_REASON } from "@psi/offlineExchangeGate";
import styles from "@styles/app.module.css";

import { restoreConnectivity, setConnectivity } from "./connectivity";
import { createAppMount } from "./renderApp";

import type { LinkageTerms } from "@psilink/core";
import type { ProfiledJobInput } from "@psi/jobClient/workInputClient";

// The block sits on the control that begins a live run -- the inviter's create,
// the acceptor's launch, the console's direct run -- each held with the same
// named reason while offline, and live again once the browser is not. The
// lobby's entries only navigate or read, and a create that only saves a file
// connects to nothing, so both stay open under an advisory instead. The managed
// re-run's own gate, the pattern these follow, is covered in offlineShell.test.ts.
//
// Chromium is where this belongs: `navigator.onLine` and its events are the
// platform signal under test, and a disabled state is a rendering fact rather
// than a model one.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

// The inviter screen transitively imports the rendezvous module, whose top-level
// config load reads `process`; nothing here opens a transport.
vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

const app = createAppMount();

afterEach(() => {
  app.unmount();
  restoreConnectivity();
});

/** Walk the inviter spine to Review & create, where the create action lives. */
async function reachReviewCreate() {
  app.render(createElement(InviterScreen));
  await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
  await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
  const fileInput = document.querySelector('input[type="file"]');
  await userEvent.upload(
    page.elementLocator(fileInput as HTMLElement),
    new File(
      [
        "client_id,first_name,last_name,dob,program_code\n" +
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
    .getByRole("button", { name: "Continue to review & create" })
    .click();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("Review & create");
}

/** The create step's blocked-reason line, or the empty string once it is clear. */
function createStatusLine(): string {
  return (
    app.container.querySelector(`.${styles.statusLine}`)?.textContent ?? ""
  );
}

/** The acceptor step's blocked-reason line, empty exactly when nothing blocks. */
function launchBlockedReason(): string {
  return (
    app.container.querySelector('[data-testid="launch-blocked-reason"]')
      ?.textContent ?? ""
  );
}

// Two single-element keys, one per name field, so the file below satisfies both
// and connectivity is the only thing that can close the launch.
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

function mountAcceptorColumnsStep() {
  const columns = ["first_name", "last_name"];
  const rows = [Object.fromEntries(columns.map((column) => [column, "x"]))];
  const columnsState = acceptorInitialColumnsState(columns);
  const editorState = acceptorColumnsEditorState(
    columnsState,
    acceptorTerms,
    rows,
  );
  const noop = () => undefined;
  app.render(
    createElement(AcceptorColumnsStep, {
      linkageTerms: acceptorTerms,
      columns,
      columnsState,
      editorState,
      verdict: acceptorVerdict(columns, acceptorTerms, editorState),
      onMetadataChange: noop,
      onRemap: noop,
      onReset: noop,
      onLaunch: noop,
      onBack: noop,
    }),
  );
}

// A mounted file the console already profiled, whose columns infer a linkable
// set of terms, so connectivity is the only thing that can close the direct run.
const directProfile: ProfiledJobInput = {
  name: "clients.csv",
  sizeBytes: 4096,
  modifiedAt: 1_700_000_000_000,
  rowCount: 2,
  columns: ["client_id", "first_name", "last_name", "dob", "program_code"],
  columnSamples: new Map([
    ["client_id", ["1", "2"]],
    ["first_name", ["Ann", "Bo"]],
    ["last_name", ["Lee", "Ray"]],
    ["dob", ["01/02/1990", "03/04/1985"]],
    ["program_code", ["A", "B"]],
  ]),
};

/** The direct-exchange confirm step with the trust affirmation already given, so
 * nothing but connectivity stands between the operator and the run. */
function mountDirectConfirmSection() {
  const noop = () => undefined;
  app.render(
    createElement(DirectConfirmSection, {
      profile: directProfile,
      identity: "",
      onIdentity: noop,
      linkageStrategy: DIRECT_LINKAGE_STRATEGY_DEFAULT,
      onLinkageStrategy: noop,
      affirmed: true,
      onAffirm: noop,
      onRun: noop,
      onBack: noop,
      running: false,
    }),
  );
}

describe("the lobby's two ways into an exchange", () => {
  test("stay open offline under an advisory the connection clears", async () => {
    setConnectivity(false);

    app.render(createElement(Lobby));
    await userEvent.fill(page.getByLabelText("Invitation"), "an-invitation");

    // Neither entry runs anything: one navigates to the authoring spine, whose
    // save-a-file transports connect to nothing, and the other reads an
    // invitation this browser already holds. Holding them here would refuse the
    // offline-safe work as well.
    await expect
      .element(page.getByRole("link", { name: "Create an invitation" }))
      .toBeInTheDocument();
    const review = page.getByRole("button", { name: "Review invitation" });
    await expect.element(review).toBeEnabled();

    // The screen still says what cannot happen, so the operator is not walked to
    // a gate they meet only after choosing a file.
    await expect
      .element(page.getByText(OFFLINE_EXCHANGE_REASON, { exact: false }))
      .toBeInTheDocument();

    setConnectivity(true);

    await expect.element(review).toBeEnabled();
    await expect
      .element(page.getByText(OFFLINE_EXCHANGE_REASON, { exact: false }))
      .not.toBeInTheDocument();
  });
});

describe("the inviter's create action", () => {
  test("is held with the named reason offline, and comes back with the connection", async () => {
    setConnectivity(false);
    await reachReviewCreate();

    const create = page.getByRole("button", { name: "Create the invitation" });
    await expect.element(create).toBeDisabled();
    expect(createStatusLine()).toBe(OFFLINE_EXCHANGE_REASON);

    setConnectivity(true);

    await expect.element(create).toBeEnabled();
    expect(createStatusLine()).toBe("Ready to create.");
  });

  test("stays open offline for a transport that saves a file, which connects to nothing", async () => {
    setConnectivity(false);
    await reachReviewCreate();

    // The command-line transports seal the terms and hand an exchange file to
    // the operator's own tool: no listener, no dial, nothing this device's
    // connectivity decides.
    await page
      .getByLabelText("Over SFTP, run by the psilink command-line tool")
      .click();

    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeEnabled();
    expect(createStatusLine()).toBe("Ready to create.");
  });
});

describe("the acceptor's launch", () => {
  test("is held with the named reason offline, and comes back with the connection", async () => {
    setConnectivity(false);
    mountAcceptorColumnsStep();

    const launch = page.getByRole("button", { name: "Start the exchange" });
    await expect.element(launch).toBeDisabled();
    expect(launchBlockedReason()).toBe(OFFLINE_EXCHANGE_REASON);

    setConnectivity(true);

    await expect.element(launch).toBeEnabled();
    expect(launchBlockedReason()).toBe("");
  });
});

describe("the console's direct run", () => {
  test("is held with the named reason offline, and comes back with the connection", async () => {
    setConnectivity(false);
    mountDirectConfirmSection();

    const run = page.getByRole("button", { name: "Run the exchange" });
    await expect.element(run).toBeDisabled();
    await expect
      .element(page.getByText(OFFLINE_EXCHANGE_REASON, { exact: false }))
      .toBeInTheDocument();

    setConnectivity(true);

    await expect.element(run).toBeEnabled();
    await expect
      .element(page.getByText(OFFLINE_EXCHANGE_REASON, { exact: false }))
      .not.toBeInTheDocument();
  });
});
