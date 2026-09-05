/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement, useEffect, useState } from "react";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import {
  IDENTITY_LABEL_REQUIRED_REASON,
  RECEIPTS_DEFAULT,
} from "@bench/receiptsModel";
import { ReceiptsCard } from "@bench/ReceiptsCard";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { JobRendezvousConfig } from "@psi/workInputClient";
import type { ReactElement } from "react";
import type { ReceiptsDraft } from "@bench/receiptsModel";

// The console's receipts card against a stubbed signing endpoint. What
// `receiptsModel` decides is pinned by the unit suite; what this one covers is the
// card's own behaviour around a request that takes real time -- the console
// spawns the CLI's `fingerprint` child -- while the operator keeps editing beside
// it. The draft is REPLACED wholesale by `onChange`, so a resolution that
// committed the draft it was started with would silently undo an edit made while
// it ran, up to and including putting back a mode the operator had left.

/** A canonical 43-character fingerprint: the final character comes from the
 * aligned set core's regex requires. */
const FINGERPRINT = "B".repeat(42) + "A";

const IDENTITY_FILE = ".psilink-signing-identity.json";
const CERTIFICATE_FILE = "psilink-certificate.json";

/** The exchange's `linkage_terms.identity`, the one value the request holds. */
const IDENTITY = "Dana Okafor, Riverside Health";

const NOTE = "Filed in the association database; purged after six years.";

/** The card's copy for a `409`, which is what the stale-failure test looks for. */
const BUSY_FAILURE = "Another fingerprint request is still running.";

interface StubbedResponse {
  status?: number;
  body?: unknown;
}

interface StubOptions {
  /** The responses the endpoint gives, in request order; the last one repeats. */
  responses?: Array<StubbedResponse>;
  /** Gates the responses wait on, taken in request order: the nth request settles
   * when the nth promise does, so a test can drive the card while a request is
   * genuinely in flight. A request past the end of the list settles at once. */
  gates?: Array<Promise<void>>;
}

/** The server's `200` envelope for an attempt that produced a fingerprint. */
function okBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "ok",
    fingerprint: FINGERPRINT,
    created: true,
    identityFileName: IDENTITY_FILE,
    ...overrides,
  };
}

/** One held-open response, standing in for the seconds the real request spends
 * spawning and waiting on the CLI child. */
function createGate(): { promise: Promise<void>; settle: () => void } {
  let settle = (): void => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/** The console's signing endpoint, stubbed at the global fetch boundary the card
 * reaches through, recording each request body so a test can assert what crossed. */
function stubSigningApi(options: StubOptions = {}): { bodies: Array<string> } {
  const bodies: Array<string> = [];
  const realFetch = window.fetch.bind(window);
  const responses = options.responses ?? [{ body: okBody() }];
  let requests = 0;

  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url !== "/api/jobs/signing/fingerprint")
        return realFetch(input, init);
      const index = requests++;
      bodies.push(typeof init?.body === "string" ? init.body : "");
      const answer = responses[Math.min(index, responses.length - 1)];
      const respond = (): Response =>
        answer.body === undefined
          ? new Response(null, { status: answer.status ?? 200 })
          : new Response(JSON.stringify(answer.body), {
              status: answer.status ?? 200,
              headers: { "Content-Type": "application/json" },
            });
      const gate = options.gates?.[index];
      return gate !== undefined
        ? gate.then(respond)
        : Promise.resolve(respond());
    },
  );

  return { bodies };
}

/** The draft the harness last held, so a test can assert on the value a bench
 * would include in the run intent as well as on what is rendered. */
let latestDraft: ReceiptsDraft = RECEIPTS_DEFAULT;

/** The default console layout: one mount, so the rendezvous holds the working
 * directory and the card's whole advisory set is on show. */
const SINGLE_MOUNT_RENDEZVOUS: JobRendezvousConfig = {
  configured: true,
  locator: "psilink",
  folderName: "psilink",
  sharesDataRoot: true,
  sharesDataRootUncertain: false,
};

/**
 * The card wired the way both benches wire it -- `AcceptorBench` directly and
 * `InviterBench` through `ReviewCreateSection` -- with a bare `useState` setter as
 * `onChange`. That is the contract the concurrent-edit tests turn on: the setter
 * REPLACES the whole draft, so whatever the card passes is the whole of what
 * survives.
 */
function ReceiptsHarness({ identity }: { identity: string }): ReactElement {
  const [draft, setDraft] = useState<ReceiptsDraft>(RECEIPTS_DEFAULT);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    latestDraft = draft;
  }, [draft]);
  return createElement(ReceiptsCard, {
    draft,
    identity,
    rendezvous: SINGLE_MOUNT_RENDEZVOUS,
    open,
    onToggleOpen: setOpen,
    onChange: setDraft,
  });
}

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  latestDraft = RECEIPTS_DEFAULT;
  vi.unstubAllGlobals();
});

const modeSelect = () => page.getByLabelText("What this exchange produces");

const retentionNote = () =>
  page.getByLabelText("Retention note for your own record");

const createButton = () =>
  page.getByRole("button", { name: "Create or show my fingerprint" });

async function renderCard(identity: string = IDENTITY): Promise<void> {
  app.render(createElement(ReceiptsHarness, { identity }));
  await expect.element(modeSelect()).toBeInTheDocument();
}

async function chooseCertificateMode(): Promise<void> {
  await userEvent.selectOptions(modeSelect(), "certificate");
  await expect.element(createButton()).toBeInTheDocument();
}

/** Lets a settled response finish crossing the client -- the fetch, the JSON read,
 * and the render either schedules -- before a test asserts on what did NOT
 * happen. A positive assertion polls and needs none of this. */
async function drainSettledResponse(): Promise<void> {
  await flushPendingUpdates();
  await flushPendingUpdates();
  await flushPendingUpdates();
}

describe("ReceiptsCard: asking the console for this party's fingerprint", () => {
  test("shows the value to share and names the file it landed in", async () => {
    const stub = stubSigningApi();
    await renderCard();
    await chooseCertificateMode();

    await createButton().click();

    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .toHaveTextContent(FINGERPRINT);
    expect(app.container.textContent).toContain(
      "Your signing identity was created",
    );
    expect(app.container.textContent).toContain(IDENTITY_FILE);
    expect(latestDraft.ownFingerprint).toBe(FINGERPRINT);
    // The request holds the label and nothing else while the export is off.
    expect(JSON.parse(stub.bodies[0])).toEqual({ identity: IDENTITY });
    // Create-or-reuse, so the action renames itself once a value is on screen.
    await expect
      .element(page.getByRole("button", { name: "Show it again" }))
      .toBeInTheDocument();
  });

  test("distinguishes an identity that was already there", async () => {
    stubSigningApi({ responses: [{ body: okBody({ created: false }) }] });
    await renderCard();
    await chooseCertificateMode();

    await createButton().click();

    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .toHaveTextContent(FINGERPRINT);
    expect(app.container.textContent).toContain(
      "Your signing identity was already set up",
    );
  });

  test("holds the export toggle and names what it wrote", async () => {
    const stub = stubSigningApi({
      responses: [{ body: okBody({ certificateFileName: CERTIFICATE_FILE }) }],
    });
    await renderCard();
    await chooseCertificateMode();

    await page.getByLabelText("Also write out my public certificate").click();
    await createButton().click();

    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .toHaveTextContent(FINGERPRINT);
    expect(app.container.textContent).toContain(
      `Your public certificate is in ${CERTIFICATE_FILE}.`,
    );
    expect(JSON.parse(stub.bodies[0])).toEqual({
      identity: IDENTITY,
      exportCertificate: true,
    });
  });

  test("withholds the request while this exchange states no identity", async () => {
    stubSigningApi();
    await renderCard("");
    await chooseCertificateMode();

    await expect.element(createButton()).toBeDisabled();
    expect(app.container.textContent).toContain(IDENTITY_LABEL_REQUIRED_REASON);
    // The reason is wired to the control, so an operator who lands on the
    // disabled button hears why rather than finding it inert.
    const describedBy = createButton()
      .element()
      .getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      IDENTITY_LABEL_REQUIRED_REASON,
    );
  });
});

describe("ReceiptsCard: a request that resolves while the operator edits", () => {
  test("merges the fingerprint into the draft the operator has by then", async () => {
    const gate = createGate();
    stubSigningApi({ gates: [gate.promise] });
    await renderCard();
    await chooseCertificateMode();

    await createButton().click();
    // The child is still running; the operator keeps authoring beside it.
    await userEvent.fill(retentionNote(), NOTE);
    gate.settle();

    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .toHaveTextContent(FINGERPRINT);
    await expect.element(retentionNote()).toHaveValue(NOTE);
    expect(latestDraft.retentionDisposition).toBe(NOTE);
    expect(latestDraft.ownFingerprint).toBe(FINGERPRINT);
  });

  test("never resurrects a mode the operator switched away from", async () => {
    const gate = createGate();
    stubSigningApi({ gates: [gate.promise] });
    await renderCard();
    await chooseCertificateMode();

    await createButton().click();
    await userEvent.selectOptions(modeSelect(), "none");
    gate.settle();
    await drainSettledResponse();

    await expect.element(modeSelect()).toHaveValue("none");
    expect(latestDraft.mode).toBe("none");
    expect(latestDraft.ownFingerprint).toBeUndefined();
    expect(app.container.textContent).not.toContain(FINGERPRINT);

    // Returning re-asks the console rather than showing a value the switch
    // discarded, which is what the create-or-show wording means here.
    await userEvent.selectOptions(modeSelect(), "certificate");
    await expect.element(createButton()).toBeInTheDocument();
  });
});

describe("ReceiptsCard: a failed request", () => {
  test("leaves no stale failure for the next visit to certificate mode", async () => {
    stubSigningApi({ responses: [{ status: 409 }, { body: okBody() }] });
    await renderCard();
    await chooseCertificateMode();

    await createButton().click();
    await expect
      .element(page.getByText(BUSY_FAILURE, { exact: false }))
      .toBeInTheDocument();

    await userEvent.selectOptions(modeSelect(), "none");
    await userEvent.selectOptions(modeSelect(), "certificate");

    await expect.element(createButton()).toBeInTheDocument();
    expect(app.container.textContent).not.toContain(BUSY_FAILURE);

    // And a fresh attempt starts from no failure either.
    await createButton().click();
    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .toHaveTextContent(FINGERPRINT);
    expect(app.container.textContent).not.toContain(BUSY_FAILURE);
  });
});
