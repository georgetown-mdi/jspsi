/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so components render with their real
// geometry: without it the Stepper's completed-step icon has no size
// bound and blankets the top bar, intercepting unrelated clicks.
import "@mantine/core/styles.css";

import {
  encodeInvitation,
  generateSharedSecret,
  sanitizeForDisplay,
} from "@psilink/core";

import {
  acceptorColumnsEditorState,
  acceptorInitialColumnsState,
  acceptorVerdict,
} from "@exchange/acceptorColumnsModel";
import { ACCEPTOR_NAME_CONTROL_CHAR_PROBLEM } from "@exchange/acceptorModel";
import { AcceptorScreen } from "@exchange/AcceptorScreen";

import { AcceptorColumnsStep } from "@exchange/AcceptorColumnsStep";
import { STEP_STATE_KEY } from "@exchange/stepHistory";

import { Lobby } from "@exchange/Lobby";
import { stagesFor } from "@exchange/exchangeRun";
import styles from "@styles/app.module.css";

// Assertions below derive their expected string from this function, so they pin
// that a string sink has the same form the panel does, not what that form is;
// the literal FSI/PDI/marker expectations live in
// apps/web/test/unit/columnNameDisplay.test.ts, which is critical for all of
// them.
import { isolatedColumnName } from "@components/ColumnName";

import { createAppMount } from "./renderApp";
import { visualOrderWithin } from "./visualOrder";

import type {
  InvitationToken,
  LinkageTerms,
  PreparedExchange,
} from "@psilink/core";

// Capture what the router boundary was navigated to, so the lobby paste test
// can assert the target and hash.
const navigation = vi.hoisted(() => ({
  calls: [] as Array<unknown>,
}));
vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock({
    onNavigate: (options) => navigation.calls.push(options),
  }),
);

// Defer or fail the CSV parse per-test to observe the parse-behind-consent gate
// (the loader is untouched until "Accept and continue" fires with consent) and
// the read-failure path, which a real parse of an inline File cannot reach
// deterministically. With both knobs unset it delegates to the real loader.
const csvLoadHarness = vi.hoisted(() => ({
  defer: false,
  fail: undefined as Error | undefined,
  called: 0,
  lastSignal: undefined as AbortSignal | undefined,
  resolve: undefined as ((value: unknown) => void) | undefined,
}));
vi.mock("@psi/workers/csvParseController", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadCSVFileOffMainThread: (
      file: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      csvLoadHarness.called += 1;
      csvLoadHarness.lastSignal = options?.signal;
      if (csvLoadHarness.fail !== undefined)
        return Promise.reject(csvLoadHarness.fail);
      if (!csvLoadHarness.defer)
        return (
          actual.loadCSVFileOffMainThread as (
            f: unknown,
            o?: unknown,
          ) => Promise<unknown>
        )(file, options);
      return new Promise((resolve) => {
        csvLoadHarness.resolve = resolve;
      });
    },
  };
});

// The rendezvous dial runs only inside the run lifecycle's acquire closure,
// which the lifecycle stub below never invokes.
vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

// Stub the run lifecycle so launching an exchange never dials: record each
// invocation's options so a test can drive the captured onStages/onStage/
// onResult/onError callbacks -- the same callbacks the real lifecycle fires --
// and assert the acceptor's run/completion screens against them (the
// exchange.test.ts pattern).
interface CapturedLifecycle {
  exchangeRole: "initiator" | "responder";
  sharedSecret: string;
  expires?: string;
  signal: AbortSignal;
  onStages: (stages: Array<unknown>) => void;
  onStage: (stageId: string) => void;
  onResult: (outputs: {
    kind: "matched" | "withheld" | "counted";
    resultsUrl?: string;
    intersectionCount?: number;
    countReportedByPartner?: boolean;
    matchedRecordCount?: number;
    record?: {
      recordUrl: string;
      recordFileName: string;
      keysUrl: string;
      keysFileName: string;
    };
  }) => void;
  onError: (failure: { category: string; error: unknown }) => void;
}
const lifecycleHarness = vi.hoisted(() => ({
  calls: [] as Array<unknown>,
}));
vi.mock("@psi/exchangeLifecycle", () => ({
  runExchangeLifecycle: (options: unknown) => {
    lifecycleHarness.calls.push(options);
    return Promise.resolve();
  },
}));

function lifecycleCall(index: number): CapturedLifecycle {
  return lifecycleHarness.calls[index] as CapturedLifecycle;
}

// stagesFor reads only the linkage terms off the prepared exchange, so a
// terms-only stand-in exercises the real acceptor stage-tree derivation.
function preparedWith(
  linkageStrategy: "cascade" | "single-pass",
  keyCount: number,
): PreparedExchange {
  return {
    linkageTerms: {
      linkageStrategy,
      linkageKeys: Array.from({ length: keyCount }, (_, i) => ({
        name: `key ${i + 1}`,
      })),
    },
  } as unknown as PreparedExchange;
}

// Two single-element keys, one per name field, plus a payload the inviter sends
// and a legal agreement, so the terms render every tier and the ledger every row.
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

async function encodeAcceptToken(
  linkageTerms: LinkageTerms = acceptorTerms,
): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms,
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

// A token holding a future expiry and a disclosed payload subset (the columns
// the inviter will send the acceptor, so the settled ledger's received row names
// them), for the run tests that assert the captured `expires`, the settled
// ledger, and jumping past the deadline to swap Try again for start-over.
async function encodeRunToken(): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: acceptorTerms,
    sharedSecret: generateSharedSecret(),
    expires: new Date(Date.now() + 3600 * 1000).toISOString(),
    disclosedPayloadColumns: ["enrollment_date", "program_code"],
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  };
  return encodeInvitation(token);
}

// Encode a token WITHOUT schema/expiry validation, mirroring encodeInvitation's
// wire format (base64url body plus a 4-byte SHA-256 checksum), so a test can mint
// a checksum-valid string that is already expired -- encodeInvitation itself
// rejects a past `expires`, so it cannot produce one (the acceptConsentGate
// pattern).
async function encodeRaw(obj: unknown): Promise<string> {
  const toBase64Url = (b: Uint8Array): string =>
    btoa(Array.from(b, (x) => String.fromCharCode(x)).join(""))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  const body = toBase64Url(bytes);
  const hashBuf = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return body + toBase64Url(new Uint8Array(hashBuf).slice(0, 4));
}

async function encodeExpiredToken(): Promise<string> {
  return encodeRaw({
    version: "1",
    linkageTerms: acceptorTerms,
    sharedSecret: generateSharedSecret(),
    expires: "2000-01-01T00:00:00.000Z",
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  });
}

function csvFile(content: string): File {
  return new File([content], "cohort_intake.csv", { type: "text/csv" });
}

const app = createAppMount();

afterEach(() => {
  // Safety check for the fake-Date test below: a failure between useFakeTimers
  // and its finally must not leak a frozen clock into the rest of the suite.
  vi.useRealTimers();
  app.unmount();
  navigation.calls.length = 0;
  csvLoadHarness.defer = false;
  csvLoadHarness.fail = undefined;
  csvLoadHarness.called = 0;
  csvLoadHarness.lastSignal = undefined;
  csvLoadHarness.resolve = undefined;
  lifecycleHarness.calls.length = 0;
  window.location.hash = "";
});

// Consent and name -- the full consent action short of choosing a file.
async function consentAndName() {
  await userEvent.click(page.getByRole("checkbox"));
  await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
}

describe("lobby: review invitation", () => {
  test("a pasted token navigates to the acceptor screen with the token in the hash", async () => {
    app.render(createElement(Lobby));
    await expect.element(page.getByLabelText("Invitation")).toBeInTheDocument();

    // A deep-link URL: the token is everything after the first '#'.
    await userEvent.fill(
      page.getByLabelText("Invitation"),
      "https://example.test/accept#ABC123",
    );
    await userEvent.click(
      page.getByRole("button", { name: "Review invitation" }),
    );

    expect(navigation.calls).toEqual([{ to: "/accept", hash: "ABC123" }]);
  });

  test("Review invitation is disabled until the field holds a usable token", async () => {
    app.render(createElement(Lobby));
    const review = page.getByRole("button", { name: "Review invitation" });
    // Empty field: nothing to review, so the action is withheld.
    await expect.element(review).toBeDisabled();

    await userEvent.fill(page.getByLabelText("Invitation"), "MYTOKEN");
    await expect.element(review).toBeEnabled();

    // Whitespace alone is not a usable token (tokenFromInput trims), so the gate
    // closes again rather than offering an action that would no-op.
    await userEvent.fill(page.getByLabelText("Invitation"), "   ");
    await expect.element(review).toBeDisabled();

    // A URL whose fragment is empty also extracts to no token.
    await userEvent.fill(
      page.getByLabelText("Invitation"),
      "https://example.test/accept#",
    );
    await expect.element(review).toBeDisabled();

    // No navigation happened while the field was empty or whitespace-only.
    expect(navigation.calls).toEqual([]);
  });
});

describe("acceptor screen: decode gate", () => {
  test("an expired invitation renders the focused cannot-accept alert", async () => {
    window.location.hash = await encodeExpiredToken();
    app.render(createElement(AcceptorScreen));

    const alert = page.getByText("Cannot accept this invitation");
    await expect.element(alert).toBeInTheDocument();
    await expect
      .element(page.getByText("This invitation has expired", { exact: false }))
      .toBeInTheDocument();
    // The alert receives focus so a screen-reader user is taken to the failure.
    await vi.waitFor(() => {
      expect(
        (document.activeElement as HTMLElement | null)?.textContent,
      ).toContain("Cannot accept this invitation");
    });
    // No rail or ledger on a failed decode -- nothing to review.
    expect(document.querySelector("nav")).toBeNull();
    expect(document.querySelector("aside")).toBeNull();
  });

  test("an empty fragment renders the cannot-accept alert", async () => {
    window.location.hash = "";
    app.render(createElement(AcceptorScreen));
    await expect
      .element(page.getByText("Cannot accept this invitation"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("No invitation was found", { exact: false }))
      .toBeInTheDocument();
  });

  test("a ready decode moves focus to the terms heading", async () => {
    window.location.hash = await encodeAcceptToken();
    app.render(createElement(AcceptorScreen));
    const heading = page.getByText("Invitation from County Health Department");
    await expect.element(heading).toBeInTheDocument();
    // headingRef + tabIndex=-1 on InvitationTerms's own heading, so a
    // keyboard/screen-reader user lands on the revealed terms rather than the
    // spinner that preceded them.
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(heading.element());
    });
  });

  test("a schema-failure decode renders the collapsed one-line error", async () => {
    // A checksum-valid token that fails the invitation schema (an invalid
    // sharedSecret) makes decodeInvitation throw a ZodError. The acceptor must
    // see the collapsed `<path>: <message>` one-liner from describeDecodeError,
    // never Zod's serialized issues blob.
    window.location.hash = await encodeRaw({
      version: "1",
      linkageTerms: acceptorTerms,
      sharedSecret: "not-a-valid-shared-secret",
      connectionEndpoint: {
        channel: "webrtc",
        host: "127.0.0.1",
        port: 3000,
        path: "/api/",
      },
    });
    app.render(createElement(AcceptorScreen));

    await expect
      .element(page.getByText("Cannot accept this invitation"))
      .toBeInTheDocument();
    const text = document.body.textContent;
    expect(text).toContain("sharedSecret:");
    // The raw blob is `JSON.stringify(issues)`, which always has a "code"
    // key; the readable one-liner never does.
    expect(text).not.toContain('"code"');
  });
});

describe("acceptor screen: review terms", () => {
  test("renders the full expanded terms with the unverified-name note and no condensation toggle", async () => {
    window.location.hash = await encodeAcceptToken();
    app.render(createElement(AcceptorScreen));

    // The terms heading names the partner and takes focus on ready.
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    // The review-only unverified-identity note travels with the terms.
    await expect
      .element(page.getByText("psilink has not verified it", { exact: false }))
      .toBeInTheDocument();

    // Never condensed at the consent decision point: no "See the full terms"
    // fold, and a lower tier is always-visible unaided.
    expect(
      page.getByRole("button", { name: "See the full terms" }).query(),
    ).toBeNull();
    await expect
      .element(page.getByRole("heading", { name: "How records are matched" }))
      .toBeInTheDocument();

    // The ledger mirrors the proposal with the proposer tag and the trust line.
    await expect
      .element(page.getByText("Proposed by County Health Department"))
      .toBeInTheDocument();
    const ledger = document.querySelector('aside[aria-label="This exchange"]');
    expect(ledger?.textContent).toContain(
      "PII for linkage is encrypted locally before leaving your machine.",
    );

    // The top bar walks the acceptor spine with Review the terms current;
    // the step indicators share the button's text, so read the label node.
    const rail = document.querySelector(
      'nav[aria-label="Accept an invitation"]',
    );
    expect(rail).not.toBeNull();
    expect(
      (rail as Element).querySelector(
        '[aria-current="step"] .mantine-Stepper-stepLabel',
      )?.textContent,
    ).toBe("Review the terms");
  });

  test("Continue advances to the consent step", async () => {
    window.location.hash = await encodeAcceptToken();
    app.render(createElement(AcceptorScreen));
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    await userEvent.click(
      page.getByRole("button", { name: "Continue: consent & your file" }),
    );
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Consent & your file");
  });
});

describe("acceptor screen: consent gate and parse-behind-consent", () => {
  async function reachConsent() {
    window.location.hash = await encodeAcceptToken();
    app.render(createElement(AcceptorScreen));
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Continue: consent & your file" }),
    );
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Consent & your file");
  }

  test("the submit is disabled until both consent and a name are supplied", async () => {
    await reachConsent();
    const accept = page.getByRole("button", { name: "Accept and continue" });
    await expect.element(accept).toBeDisabled();

    // Consent alone is not enough.
    await userEvent.click(page.getByRole("checkbox"));
    await expect.element(accept).toBeDisabled();

    // A name completes the gate.
    await userEvent.fill(page.getByLabelText("Your name"), "Sam Alvarez");
    await expect.element(accept).toBeEnabled();

    // Clearing consent re-disables it.
    await userEvent.click(page.getByRole("checkbox"));
    await expect.element(accept).toBeDisabled();
  });

  test("a name holding a control character is refused at the field", async () => {
    await reachConsent();
    const accept = page.getByRole("button", { name: "Accept and continue" });
    await userEvent.click(page.getByRole("checkbox"));

    // A name pasted out of a spreadsheet cell, still holding the separator.
    // The run adopts this value as this party's terms identity, which core
    // refuses outright -- so the fault is named at the field the operator can
    // still fix rather than showing up once the exchange is under way.
    await userEvent.fill(page.getByLabelText("Your name"), "County\tHealth");
    await expect
      .element(page.getByText(ACCEPTOR_NAME_CONTROL_CHAR_PROBLEM))
      .toBeInTheDocument();
    await expect.element(accept).toBeDisabled();

    // Correcting it clears the refusal and re-opens the gate.
    await userEvent.fill(page.getByLabelText("Your name"), "County Health");
    await expect.element(accept).toBeEnabled();
    expect(app.container.textContent).not.toContain(
      ACCEPTOR_NAME_CONTROL_CHAR_PROBLEM,
    );
  });

  test("the file is not parsed until Accept fires with the gate satisfied", async () => {
    await reachConsent();

    // Choose a file BEFORE consent: the loader is still untouched (selection is
    // not a parse -- parsing stays behind the gate).
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      csvFile("first_name,last_name\nAlice,Smith\n"),
    );
    await expect
      .element(page.getByText("cohort_intake.csv"))
      .toBeInTheDocument();
    expect(csvLoadHarness.called).toBe(0);

    // Consent + name enable the action; still no parse.
    await consentAndName();
    expect(csvLoadHarness.called).toBe(0);

    // Accept and continue is the first thing that parses, and only then advances.
    await userEvent.click(
      page.getByRole("button", { name: "Accept and continue" }),
    );
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Confirm your columns");
    expect(csvLoadHarness.called).toBe(1);
  });

  test("the filecard shows the file's size, not a row count", async () => {
    await reachConsent();
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      csvFile("first_name,last_name\nAlice,Smith\nBob,Jones\n"),
    );
    await expect
      .element(page.getByText("cohort_intake.csv"))
      .toBeInTheDocument();
    // The metadata line names a byte size (KB/MB), never a "rows" count -- the
    // file is held unparsed, so no row count exists at this step.
    const fileCard = document.querySelector('[class*="fileCard"]');
    expect(fileCard?.textContent).toMatch(/\d+\s*(KB|MB)/);
    expect(fileCard?.textContent).not.toMatch(/rows/);
  });

  test("an unreadable CSV shows the could-not-read alert and preserves every input", async () => {
    await reachConsent();
    await consentAndName();
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      csvFile("first_name,last_name\nAlice,Smith\n"),
    );
    await expect
      .element(page.getByText("cohort_intake.csv"))
      .toBeInTheDocument();

    // The parse fails; the alert appears and no step transition occurs.
    csvLoadHarness.fail = new Error("torn mid-read");
    await userEvent.click(
      page.getByRole("button", { name: "Accept and continue" }),
    );
    await expect
      .element(page.getByText("Could not read your file"))
      .toBeInTheDocument();
    expect(
      page.getByRole("heading", { name: "Confirm your columns" }).query(),
    ).toBeNull();

    // The inputs survive the failure: consent still checked, name still filled,
    // the file card still shown.
    expect(
      (page.getByRole("checkbox").element() as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (page.getByLabelText("Your name").element() as HTMLInputElement).value,
    ).toBe("Sam Alvarez");
    await expect
      .element(page.getByText("cohort_intake.csv"))
      .toBeInTheDocument();
  });
});

describe("acceptor screen: consent-step legal-agreement display", () => {
  // acceptorTerms has no agreement, so the display tests mint their own
  // agreement-bearing terms; the shared fixture keeps the no-fieldset case.
  const agreementTerms: LinkageTerms = {
    ...acceptorTerms,
    legalAgreement: {
      reference: "MOU-2025-0042",
      purpose: "Program evaluation",
      expirationDate: "2026-12-31",
    },
  };

  async function reachConsentWith(terms: LinkageTerms) {
    window.location.hash = await encodeAcceptToken(terms);
    app.render(createElement(AcceptorScreen));
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Continue: consent & your file" }),
    );
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Consent & your file");
  }

  test("an agreement-bearing invitation shows the three values, read-only", async () => {
    await reachConsentWith(agreementTerms);
    const fieldset = document.querySelector("fieldset");
    expect(fieldset).not.toBeNull();
    expect(fieldset?.querySelector("legend")?.textContent).toBe(
      "Legal agreement",
    );
    expect(fieldset?.textContent).toContain(
      "Check these values against your signed agreement",
    );
    expect(fieldset?.textContent).toContain("MOU-2025-0042");
    // The purpose keeps its provenance marker: partner-attested free text,
    // never presented as psilink-endorsed (the InvitationTerms convention).
    expect(fieldset?.textContent).toContain(
      "Stated purpose of the disclosure: Program evaluation",
    );
    expect(fieldset?.textContent).toContain("2026-12-31");
    // Display only: nothing to type, so the fieldset holds no inputs.
    expect(fieldset?.querySelector("input")).toBeNull();
    // Plain-ASCII values read exactly as authored, so no escaping caveat.
    expect(fieldset?.textContent).not.toContain("shown as escape codes");

    // And it adds no precondition: consent plus a name still completes the gate.
    await consentAndName();
    await expect
      .element(page.getByRole("button", { name: "Accept and continue" }))
      .toBeEnabled();
  });

  test("a non-ASCII agreement value renders escaped, with the caveat line", async () => {
    // An accented purpose is legitimate authored text, but sanitizeForDisplay
    // escapes every non-ASCII code point -- the display cannot visually match
    // the signed document, so the caveat line must accompany the escaped form.
    await reachConsentWith({
      ...agreementTerms,
      legalAgreement: {
        reference: "MOU-2025-0042",
        purpose: "Evaluaci\u00f3n del programa",
        expirationDate: "2026-12-31",
      },
    });
    const fieldset = document.querySelector("fieldset");
    expect(fieldset).not.toBeNull();
    // The escaped form displays; the raw accented character never renders.
    expect(fieldset?.textContent).toContain("Evaluaci\\xf3n del programa");
    expect(fieldset?.textContent).not.toContain("\u00f3");
    expect(fieldset?.textContent).toContain(
      "shown as escape codes because they fall outside plain ASCII",
    );
  });

  test("an agreement-less invitation shows no legal-agreement fieldset", async () => {
    await reachConsentWith(acceptorTerms);
    expect(document.querySelector("fieldset")).toBeNull();
  });
});

describe("acceptor screen: confirm your columns (verdict, mapper, launch)", () => {
  // Consent, name, choose a file, and press Accept to land on the columns step.
  async function reachColumns(content: string) {
    window.location.hash = await encodeAcceptToken();
    app.render(createElement(AcceptorScreen));
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Continue: consent & your file" }),
    );
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Consent & your file");
    await consentAndName();
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      csvFile(content),
    );
    await expect
      .element(page.getByText("cohort_intake.csv"))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Accept and continue" }),
    );
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
  }

  test("a blocked file shows the exact block copy and disables Start the exchange", async () => {
    await reachColumns("notes\nhello\n");
    await expect
      .element(page.getByText("This file cannot match yet"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeDisabled();

    // The verdict is announced from a separate stable polite region, not the
    // visible (presentation) alert.
    const verdict = document.querySelector('[data-testid="verdict"]');
    expect(verdict?.getAttribute("role")).toBeNull();
    expect(
      verdict?.querySelector('[role="alert"], [role="status"]'),
    ).toBeNull();
    const announcement = page.getByTestId("verdict-announcement");
    await expect
      .element(announcement)
      .toHaveTextContent(
        "No agreed linkage key can be satisfied by your columns",
      );
    expect(announcement.element().getAttribute("role")).toBe("status");
    expect(announcement.element().getAttribute("aria-live")).toBe("polite");
  });

  test("a partially-covered file shows the N-of-M copy and blocks launch", async () => {
    await reachColumns("first_name,notes\nAlice,vip\n");
    await expect
      .element(page.getByText("1 of 2 keys can match"))
      .toBeInTheDocument();
    // An exchange runs every agreed key, so the run boundary refuses this file --
    // and the launch says so here, where the operator can still act on it.
    await expect
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeDisabled();
    await expect
      .element(page.getByTestId("launch-blocked-reason"))
      .toHaveTextContent("Cover the remaining agreed linkage keys above");
  });

  test("a fully-covered file is all-clear with the exact body copy and no mapper", async () => {
    await reachColumns("first_name,last_name\nAlice,Smith\n");
    await expect
      .element(page.getByText("All 2 keys can match"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Every key in the invitation is covered by your columns.",
        ),
      )
      .toBeInTheDocument();
    // Nothing is missing, so the quick-fix mapper is absent.
    expect(
      page.getByText("Map a column to each missing field").query(),
    ).toBeNull();
    await expect
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeEnabled();
  });

  test("mapping the missing fields flips partial -> all-clear and voices the announcement", async () => {
    // Both columns are unrecognized (inferred payload), so the file is blocked and
    // the mapper offers one Select per missing type.
    await reachColumns("alpha,beta\nAlice,Smith\n");
    await expect
      .element(page.getByText("This file cannot match yet"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Map a column to each missing field"))
      .toBeInTheDocument();

    // Map alpha -> First name: the field becomes satisfiable, so the verdict
    // advances to partial (proof the column was re-roled to linkage, not retyped).
    // The mapper is a native <select>, chosen via selectOptions.
    await userEvent.selectOptions(
      page.getByRole("combobox", { name: "First name", exact: true }),
      "alpha",
    );
    await expect
      .element(page.getByText("1 of 2 keys can match"))
      .toBeInTheDocument();
    await expect
      .element(page.getByTestId("verdict-announcement"))
      .toHaveTextContent(
        "1 of 2 linkage keys can be satisfied by your columns",
      );

    // Map beta -> Last name: every key satisfiable, block gone, launch enabled.
    await userEvent.selectOptions(
      page.getByRole("combobox", { name: "Last name", exact: true }),
      "beta",
    );
    await expect
      .element(page.getByText("All 2 keys can match"))
      .toBeInTheDocument();
    await expect
      .element(page.getByTestId("verdict-announcement"))
      .toHaveTextContent("All 2 linkage keys can be satisfied by your columns");
    await expect
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeEnabled();
  });

  test("the blocked-reason region is mounted and silent while nothing blocks launch", async () => {
    // The region exists before it has anything to say: assistive tech observes a
    // live region from the moment it is in the document, so a reason that arrives
    // later is an empty -> non-empty transition rather than a region mounting with
    // its text already in place, which is announced unreliably.
    await reachColumns("first_name,last_name\nAlice,Smith\n");
    const region = page.getByTestId("launch-blocked-reason");
    await expect.element(region).toBeInTheDocument();
    expect(region.element().getAttribute("role")).toBe("status");
    expect(region.element().textContent).toBe("");
    // Nothing blocks, so the button is live and describes itself with nothing.
    const start = page.getByRole("button", { name: "Start the exchange" });
    await expect.element(start).toBeEnabled();
    expect(start.element().getAttribute("aria-describedby")).toBeNull();
  });

  test("a reason arising mid-session lands in the region already mounted", async () => {
    await reachColumns("first_name,last_name\nAlice,Smith\n");
    const region = page.getByTestId("launch-blocked-reason").element();
    expect(region.textContent).toBe("");

    // Retype both matching columns to Other: no key can match, so a gate the
    // operator opened themselves closes the launch after the step was mounted.
    for (const columnName of ["first_name", "last_name"]) {
      await userEvent.click(
        page.getByRole("combobox", {
          name: `Type for column ${isolatedColumnName(columnName)}`,
          exact: true,
        }),
      );
      await userEvent.click(
        page.getByRole("option", { name: "Other (not used for matching)" }),
      );
    }
    await expect
      .element(page.getByText("This file cannot match yet"))
      .toBeInTheDocument();

    // The SAME node, not a replacement: a remounted region is a fresh one whose
    // text was present at mount, which is the announcement this fix exists to
    // avoid, and an identity check is the only thing that tells the two apart.
    expect(page.getByTestId("launch-blocked-reason").element()).toBe(region);
    expect(region.textContent).toBe(
      "Set your columns to the missing field types above before you can start.",
    );
    const start = page.getByRole("button", { name: "Start the exchange" });
    await expect.element(start).toBeDisabled();
    expect(
      document.getElementById(
        start.element().getAttribute("aria-describedby") ?? "",
      ),
    ).toBe(region);
  });

  test("a two-identifier file says which rule to resolve at the disabled button", async () => {
    // A model-side gate with no transport in it: the keys are all satisfiable and
    // the invitation accepts what is marked, so the identifier rule alone closes
    // the launch -- and the button states its sentence rather than falling silent.
    await reachColumns("id,identifier,first_name,last_name\n1,2,Alice,Smith\n");
    const start = page.getByRole("button", { name: "Start the exchange" });
    await expect.element(start).toBeDisabled();
    const reasonId = start.element().getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId!)?.textContent).toBe(
      "Choose a single record identifier column above before you can start.",
    );

    // Resolving it empties the region in place and re-opens the launch.
    await userEvent.click(
      page.getByRole("combobox", {
        name: `Type for column ${isolatedColumnName("identifier")}`,
        exact: true,
      }),
    );
    await userEvent.click(
      page.getByRole("option", { name: "Other (not used for matching)" }),
    );
    await expect.element(start).toBeEnabled();
    expect(
      page.getByTestId("launch-blocked-reason").element().textContent,
    ).toBe("");
    expect(start.element().getAttribute("aria-describedby")).toBeNull();
  });

  test("Reset to defaults restores the file-derived defaults", async () => {
    await reachColumns("first_name,last_name\nAlice,Smith\n");
    await expect
      .element(page.getByText("All 2 keys can match"))
      .toBeInTheDocument();

    // Retype first_name to a non-matching type via the grid, dropping a key.
    const typeSelect = page.getByRole("combobox", {
      name: `Type for column ${isolatedColumnName("first_name")}`,
    });
    await userEvent.click(typeSelect);
    await userEvent.click(
      page.getByRole("option", { name: "Other (not used for matching)" }),
    );
    await expect
      .element(page.getByText("1 of 2 keys can match"))
      .toBeInTheDocument();

    // Reset restores the default (file-derived) metadata: back to all-clear.
    await userEvent.click(
      page.getByRole("button", { name: "Reset to defaults" }),
    );
    await expect
      .element(page.getByText("All 2 keys can match"))
      .toBeInTheDocument();
  });

  test("a two-identifier file ties the conflict error to the offending Type controls", async () => {
    // `id` and `identifier` both infer to role: identifier, so the file seeds a
    // single-identifier conflict the grid shows (inferMetadata seeds it; the
    // mutators never create it).
    await reachColumns("id,identifier,first_name,last_name\n1,2,Alice,Smith\n");
    const conflict = page.getByTestId("identifier-conflict");
    await expect.element(conflict).toBeInTheDocument();
    const errorId = conflict.element().getAttribute("id");
    expect(errorId).toBeTruthy();

    // Both offending Type controls have the control-level error signal and
    // point their description at the visible error element. (exact: true, kept
    // because the labels here name `id` and `identifier`: the isolate closing
    // each name is what separates the two, and an inexact match would not say
    // whether it read that or the shorter name's prefix.)
    for (const columnName of ["id", "identifier"]) {
      const control = page.getByRole("combobox", {
        name: `Type for column ${isolatedColumnName(columnName)}`,
        exact: true,
      });
      expect(control.element().getAttribute("aria-invalid")).toBe("true");
      expect(control.element().getAttribute("aria-describedby")).toBe(errorId);
    }

    // A non-identifier Type control has no stale error association.
    const bystander = page.getByRole("combobox", {
      name: `Type for column ${isolatedColumnName("first_name")}`,
      exact: true,
    });
    expect(bystander.element().getAttribute("aria-invalid")).toBeNull();
    expect(bystander.element().getAttribute("aria-describedby")).toBeNull();

    // Retype one identifier to Other: the conflict clears and no control keeps a
    // stale aria-invalid/association.
    const idControl = page.getByRole("combobox", {
      name: `Type for column ${isolatedColumnName("identifier")}`,
      exact: true,
    });
    await userEvent.click(idControl);
    await userEvent.click(
      page.getByRole("option", { name: "Other (not used for matching)" }),
    );
    expect(page.getByTestId("identifier-conflict").query()).toBeNull();
    const survivor = page.getByRole("combobox", {
      name: `Type for column ${isolatedColumnName("id")}`,
      exact: true,
    });
    expect(survivor.element().getAttribute("aria-invalid")).toBeNull();
    expect(survivor.element().getAttribute("aria-describedby")).toBeNull();
  });

  test("the ledger's You will send names the extra disclosed column, not the invitation's request", async () => {
    // The invitation requests no payload from the acceptor (acceptorTerms has no
    // payload.receive), so its terms name nothing to send. The file has an
    // unrecognized `comment` column that infers to role: payload, so the acceptor
    // transmits it for matched rows. The ledger's "You will send" must name that
    // column (what actually leaves), not read "No additional columns" off the
    // inviter's empty request.
    await reachColumns("first_name,last_name,comment\nAlice,Smith,ok\n");
    const ledger = document.querySelector(
      'aside[aria-label="This exchange"]',
    ) as Element;
    // Assert the disclosed column appears in the send row's OWN value cell, not
    // merely somewhere in the ledger: find the ledger row whose label is "You will
    // send" and read its <dd>.
    const sendRow = Array.from(ledger.querySelectorAll("div")).find(
      (row) => row.querySelector("dt")?.textContent === "You will send",
    );
    expect(sendRow).toBeDefined();
    expect(sendRow?.querySelector("dd")?.textContent).toContain("comment");
    expect(sendRow?.querySelector("dd")?.textContent).not.toContain(
      "No additional columns",
    );
    // And the confirm step's own summary, the surface that already told the truth,
    // agrees -- the two no longer contradict.
    await expect
      .element(page.getByText("For each matched row: comment."))
      .toBeInTheDocument();
  });

  test("the ledger's send row shows a header as the step's panel does, and contains it", async () => {
    // The step's panel and this ledger row name the SAME disclosed set, side by
    // side on the one screen where the operator decides what leaves the machine, so
    // a header escaped in one and verbatim in the other reads two ways at once. The
    // row holds the step's isolation as characters instead: a ledger value is a
    // string sink, where no element can hold it.
    const hostile = "notes\u202Eevil";
    await reachColumns(
      `first_name,last_name,pre,${hostile},post\nAlice,Smith,a,b,c\n`,
    );
    const ledger = document.querySelector(
      'aside[aria-label="This exchange"]',
    ) as Element;
    const sendValue = Array.from(ledger.querySelectorAll("div"))
      .find((row) => row.querySelector("dt")?.textContent === "You will send")
      ?.querySelector("dd");
    expect(sendValue?.textContent).toBe(
      ["pre", hostile, "post"].map(isolatedColumnName).join(", "),
    );
    // And nowhere on the screen is the escaped form: the panel and this row name
    // the same set, so an escape on either is the disagreement this pins.
    expect(document.body.textContent).not.toContain(
      sanitizeForDisplay(hostile),
    );

    // And the isolate characters do the work the <bdi> does in the panel: the tail
    // of the override-bearing name stays ahead of the name listed after it, which
    // is what an unterminated override moves. Measured through a Range, since the
    // whole row is one text node with no element to take a box.
    const value = sendValue?.firstChild;
    expect(value).toBeInstanceOf(Text);
    expect(visualOrderWithin(value as Text, ["pre", "evil", "post"])).toEqual([
      "pre",
      "evil",
      "post",
    ]);
  });

  test("the step-3 ledger footer swaps to the local-only line", async () => {
    await reachColumns("first_name,last_name\nAlice,Smith\n");
    const ledger = document.querySelector('aside[aria-label="This exchange"]');
    expect(ledger?.textContent).toContain(
      "Column typing and cleaning stay on your device. Your partner sees " +
        "matches, never these settings.",
    );
    expect(ledger?.textContent).not.toContain(
      "PII for linkage is encrypted locally before leaving your machine.",
    );
  });

  test("Start the exchange launches the minimal run stub holding the edited spec", async () => {
    await reachColumns("first_name,last_name\nAlice,Smith\n");
    await userEvent.click(
      page.getByRole("button", { name: "Start the exchange" }),
    );
    // The columns package's terminal stub -- the next package replaces it.
    await expect
      .element(page.getByRole("heading", { name: "Exchange in progress" }))
      .toBeInTheDocument();
  });

  test("the backlink returns to consent preserving the file, then re-enters reseeded", async () => {
    await reachColumns("first_name,last_name,comment\nAlice,Smith,ok\n");
    // The unrecognized comment column is the inferred payload; the columns step's
    // "what you will send" summary names it.
    await expect
      .element(page.getByText("For each matched row: comment."))
      .toBeInTheDocument();

    // Back to consent: the terms are gone from view but the file card survives
    // (consent + name + file all preserved on the consent step).
    await userEvent.click(
      page.getByRole("button", { name: "Choose a different file" }),
    );
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Consent & your file");
    await expect
      .element(page.getByText("cohort_intake.csv"))
      .toBeInTheDocument();
    // No re-parse happened on the way back.
    expect(
      page.getByRole("heading", { name: "Confirm your columns" }).query(),
    ).toBeNull();
  });

  test("the ledger's Cleaning row opens the acceptor's own cleaning editor", async () => {
    await reachColumns("first_name,last_name\nAlice,Smith\n");
    // The ledger's Customize row navigates to the cleaning sub-section (the
    // acceptor edits only its own standardization there), and the open tab's
    // row has aria-current.
    await userEvent.click(page.getByRole("button", { name: /Cleaning/ }));
    await expect
      .element(page.getByRole("heading", { name: "Cleaning" }))
      .toBeInTheDocument();
    expect(
      document.querySelector(
        'aside[aria-label="This exchange"] button[aria-current="true"]',
      )?.textContent,
    ).toContain("Cleaning");
    // Back returns to the columns confirm surface.
    await userEvent.click(
      page.getByRole("button", { name: "Back to Confirm your columns" }),
    );
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
  });

  test("browser Back walks the acceptor steps in place, including the cleaning tab", async () => {
    await reachColumns("first_name,last_name\nAlice,Smith\n");
    await userEvent.click(page.getByRole("button", { name: /Cleaning/ }));
    await expect
      .element(page.getByRole("heading", { name: "Cleaning" }))
      .toBeInTheDocument();

    // Back leaves the Cleaning tab for the columns confirm surface -- the
    // sub-section is part of the restored position, not just the step.
    window.history.back();
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();

    // Back again lands on consent with every input intact: the file card, the
    // name, and the checked consent all survive in place.
    window.history.back();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Consent & your file");
    await expect
      .element(page.getByText("cohort_intake.csv"))
      .toBeInTheDocument();
    await expect
      .element(page.getByLabelText("Your name"))
      .toHaveValue("Sam Alvarez");

    // Forward reverses the same transitions, back into the Cleaning tab, and
    // the file was never re-parsed along the way (one parse at Accept).
    window.history.forward();
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
    window.history.forward();
    await expect
      .element(page.getByRole("heading", { name: "Cleaning" }))
      .toBeInTheDocument();
    expect(csvLoadHarness.called).toBe(1);
  });
});

describe("acceptor columns step: one column name across the screen", () => {
  // The screen where the operator decides what leaves the machine names the same
  // header in four places -- the grid row, the grid's two control labels, and the
  // disclosed-columns panel -- and they have to be the same name. These names are
  // the operator's own CSV header, so they are shown verbatim inside a bidi
  // isolate rather than escaped; what the isolate contains and what it does not is
  // on @components/ColumnName.
  function mountStep(columns: Array<string>) {
    const rows = [Object.fromEntries(columns.map((c) => [c, "x"]))];
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

  /** The grid's row headers, in row order. */
  function rowHeaderNames(): Array<string> {
    return [...app.container.querySelectorAll('th[scope="row"]')].map(
      (element) => element.textContent,
    );
  }

  test("a header holding a bidi override reads alike in the grid row and the panel", async () => {
    // A right-to-left override (U+202E) and a zero-width joiner (U+200D): the two
    // classes that make a name read differently from its bytes. The name is
    // unrecognized, so it infers to role: payload -- the disclosed set -- while
    // first_name/last_name satisfy both keys, so the "What you will send" panel
    // renders instead of the mapper.
    const bidiColumn = "notes\u202Eevil\u200D";
    mountStep(["first_name", "last_name", bidiColumn]);
    await expect
      .element(page.getByText("For each matched row:", { exact: false }))
      .toBeInTheDocument();

    // The grid's row header and the panel's entry are the SAME string, and it is
    // the header the operator's file has -- the disagreement this pins is a
    // name that reads one way in the row the operator marks and another in the
    // sentence stating what that mark sends.
    const panel = page
      .getByText("For each matched row:", { exact: false })
      .element();
    expect(rowHeaderNames()).toEqual(["first_name", "last_name", bidiColumn]);
    expect(panel.textContent).toBe(`For each matched row: ${bidiColumn}.`);

    // Both sit in a <bdi> the browser actually isolates, which is what keeps the
    // override off the copy around them: asserted through the computed style, so
    // a <bdi> the engine does not isolate fails here rather than passing on the
    // element name alone.
    const isolates = [...app.container.querySelectorAll("bdi")];
    expect(isolates.map((element) => element.textContent)).toEqual([
      bidiColumn,
      "first_name",
      "last_name",
      bidiColumn,
    ]);
    for (const element of isolates) {
      expect(getComputedStyle(element).unicodeBidi).toBe("isolate");
    }

    // The two control labels are strings, so they have the isolate as characters
    // instead. Read off the DOM rather than through a role query, since what is
    // pinned is the label the app emits.
    const labels = [
      ...app.container.querySelectorAll("[aria-label^='Type for column ']"),
      ...app.container.querySelectorAll("[aria-label^='How column ']"),
    ].map((element) => element.getAttribute("aria-label"));
    expect(labels).toContain(
      `Type for column ${isolatedColumnName(bidiColumn)}`,
    );
    expect(labels).toContain(
      `How column ${isolatedColumnName(bidiColumn)} is used`,
    );

    // And nothing anywhere on the step shows the escaped form -- the whole step,
    // not one panel, since what holds the surfaces together is that none of them
    // escapes: a single site put back on sanitizeForDisplay fails here.
    expect(app.container.textContent).not.toContain(
      sanitizeForDisplay(bidiColumn),
    );
  });

  test("the quick-fix mapper offers the header isolated and binds it raw", async () => {
    // Neither column infers to a linkage type, so the mapper takes the panel's
    // slot with one native select per missing field. An <option> cannot hold a
    // <bdi>, so its label has the isolate as characters -- while its VALUE
    // stays the raw header, since that is the identity the remap binds and a
    // display form there would bind a column the file does not have.
    const bidiColumn = "notes\u202Eevil";
    mountStep([bidiColumn, "other"]);
    await expect
      .element(page.getByText("Map a column to each missing field"))
      .toBeInTheDocument();

    const options = [...app.container.querySelectorAll("option")].filter(
      (option) => option.value !== "",
    );
    expect(options.map((option) => option.value)).toContain(bidiColumn);
    expect(options.map((option) => option.textContent)).toContain(
      isolatedColumnName(bidiColumn),
    );
  });

  test("a header behind an unmatched PDI reorders the panel's own sentence", async () => {
    // The isolate class is the isolation's residual (UAX #9 BD9/X6a); this panel's
    // copy sits in one text block with the names, so the residual is reachable here
    // (other sinks of that shape are measured in inviterSharing). The unmatched
    // PDI ends the <bdi>'s isolation after "pre", so the override written after that
    // break moves the name's tail past the name listed after it -- within the trust
    // basis @components/ColumnName records: these are the operator's own headers.
    const residual = "pre\u2069mid\u202Eevil";
    mountStep(["first_name", "last_name", residual, "post"]);
    await expect
      .element(page.getByText("For each matched row:", { exact: false }))
      .toBeInTheDocument();
    const panel = page
      .getByText("For each matched row:", { exact: false })
      .element();
    expect(visualOrderWithin(panel, ["pre", "evil", "post"])).toEqual([
      "pre",
      "post",
      "evil",
    ]);
  });

  test("two long headers sharing a prefix stay distinct in the grid", async () => {
    // Why the grid isolates rather than escapes: sanitizeForDisplay bounds its
    // OUTPUT, and a code point past U+00FF escapes to six characters, so two
    // schema-valid headers (MAX_NAME_LENGTH is 256) sharing a long non-Latin
    // prefix collapse to the same truncated string -- the equality below. An
    // operator reading that would be marking two grid rows that look like one.
    const sharedPrefix = "\u0444".repeat(45);
    const first = `${sharedPrefix}_a`;
    const second = `${sharedPrefix}_b`;
    expect(sanitizeForDisplay(first)).toBe(sanitizeForDisplay(second));

    mountStep(["first_name", "last_name", first, second]);
    await expect
      .element(page.getByText("For each matched row:", { exact: false }))
      .toBeInTheDocument();

    expect(rowHeaderNames()).toEqual([
      "first_name",
      "last_name",
      first,
      second,
    ]);
    // Whole and unescaped, so a non-Latin header displays as itself on the
    // operator's own authoring surface rather than as a run of escapes.
    expect(app.container.textContent).not.toContain("\\u0444");
  });

  // What the checks below measure is ORDER, not layout: an unterminated RLE or RLI
  // still shifts the glyphs after it along the line, isolated or not. And what
  // contains a class whose order holds either way is the computed
  // `unicode-bidi: isolate` asserted above and the PDI semantics ColumnName cites
  // (UAX #9), neither of which this measurement stands in for.
  const RIGHT_TO_LEFT_OVERRIDE = "\u202E";

  function namesCarrying(marker: string): Array<string> {
    return ["pre", `notes${marker}evil`, "post"];
  }

  const PANEL_NAMES = namesCarrying(RIGHT_TO_LEFT_OVERRIDE);

  /** The visual order of the three names in the sentence the panel renders, laid
   * out with none of the isolation the panel gives them. */
  async function unisolatedVisualOrder(marker: string): Promise<Array<string>> {
    app.render(
      createElement(
        "p",
        null,
        "For each matched row: ",
        ...namesCarrying(marker).flatMap((name, index) => [
          index > 0 ? ", " : "",
          createElement("span", { key: name }, name),
        ]),
        ".",
      ),
    );
    await expect
      .element(page.getByText("For each matched row:", { exact: false }))
      .toBeInTheDocument();
    const paragraph = app.container.querySelector("p") as Element;
    return visualOrderWithin(paragraph, ["pre", "evil", "post"]);
  }

  test("an unterminated override leaves the names beside it where the panel lists them", async () => {
    mountStep(["first_name", "last_name", ...PANEL_NAMES]);
    await expect
      .element(page.getByText("For each matched row:", { exact: false }))
      .toBeInTheDocument();
    const panel = page
      .getByText("For each matched row:", { exact: false })
      .element();
    expect(visualOrderWithin(panel, ["pre", "evil", "post"])).toEqual([
      "pre",
      "evil",
      "post",
    ]);
  });

  test("the same measurement sees the reordering the isolation prevents", async () => {
    // The control for the check above: it asserts a layout property, and is worth
    // nothing unless the instrument can see that property break. Stripped of the
    // isolation the panel renders them with, the same names in the same sentence
    // come out in a visual order the DOM does not hold -- the override moves
    // "evil" past the name listed after it.
    expect(await unisolatedVisualOrder(RIGHT_TO_LEFT_OVERRIDE)).toEqual([
      "pre",
      "post",
      "evil",
    ]);
  });

  // Why that pair uses an RLO and no other class: with all-Latin neighbours in an
  // LTR sentence, each class below leaves the names where the panel lists them even
  // unisolated, so an order assertion on it would hold with the isolation gone and
  // measure nothing.
  const OTHER_UNCLOSED_CLASSES = [
    { className: "a left-to-right override (U+202D)", marker: "\u202D" },
    { className: "a right-to-left embedding (U+202B)", marker: "\u202B" },
    { className: "a left-to-right embedding (U+202A)", marker: "\u202A" },
    { className: "a right-to-left isolate (U+2067)", marker: "\u2067" },
    { className: "a left-to-right isolate (U+2066)", marker: "\u2066" },
    { className: "a first-strong isolate (U+2068)", marker: "\u2068" },
    { className: "a stray PDF (U+202C)", marker: "\u202C" },
  ];

  test.each(OTHER_UNCLOSED_CLASSES)(
    "$className leaves the names where the panel lists them, unisolated",
    async ({ marker }) => {
      expect(await unisolatedVisualOrder(marker)).toEqual([
        "pre",
        "evil",
        "post",
      ]);
    },
  );
});

describe("acceptor columns step: the send summary is gated on the inviting party receiving a result", () => {
  // The payload step transmits only to a partner entitled to the result, putting an
  // empty message on the wire otherwise, so an invitation that gives the inviting
  // party no result sends no column whatever this operator marks here. This is the
  // screen where those marks are being set, so a summary listing them would promise
  // a disclosure the run does not make at the moment the operator is deciding it.
  //
  // The acceptor's partner IS the inviting party, so the fact is the invitation's own
  // expectsOutput -- the same fact the consent screen's outbound block reads
  // (apps/web/test/browser/invitationTerms.test.ts pins it there), rendering the same
  // sentence from @psilink/core.
  const noResultForInviter: LinkageTerms = {
    ...acceptorTerms,
    output: { expectsOutput: false, shareWithPartner: true },
  };
  // Spelled out rather than imported, so a copy edit fails here as it does on the
  // consent screen instead of moving both assertions at once.
  const noPayloadSentence =
    "Your partner receives no result from this exchange, so no columns are " +
    "sent to them -- whatever your file contains.";

  // A file whose columns cover both keys and disclose one payload column, so the
  // send summary renders (not the mapper) with a non-empty set to suppress.
  function mountStep(linkageTerms: LinkageTerms) {
    const columns = ["first_name", "last_name", "risk_score"];
    const rows = [Object.fromEntries(columns.map((c) => [c, "x"]))];
    const columnsState = acceptorInitialColumnsState(columns);
    const editorState = acceptorColumnsEditorState(
      columnsState,
      linkageTerms,
      rows,
    );
    const noop = () => undefined;
    app.render(
      createElement(AcceptorColumnsStep, {
        linkageTerms,
        columns,
        columnsState,
        editorState,
        verdict: acceptorVerdict(columns, linkageTerms, editorState),
        onMetadataChange: noop,
        onRemap: noop,
        onReset: noop,
        onLaunch: noop,
        onBack: noop,
      }),
    );
  }

  test("the disclosed set is not listed, and the panel states why", async () => {
    mountStep(noResultForInviter);
    // Under the same caption the list takes, so the fact occupies the panel rather
    // than leaving it blank.
    await expect
      .element(page.getByText("What you will send to your partner"))
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(noPayloadSentence);
    expect(app.container.textContent).not.toContain("For each matched row:");
    // The step's own lead-in drops its "except the columns you mark as shared"
    // clause with the disclosure it would have promised.
    expect(app.container.textContent).toContain(
      "Nothing here is sent to your partner.",
    );
    // And the spoken account with it: the grid's live region at the disclosure
    // controls is what a screen-reader user hears when they mark a column, and a
    // region still naming the set would leave one operator told nothing is sent
    // while another is told their columns are, on the same screen. Queried by
    // testid because the sentence is on this screen twice -- here and in the
    // visible panel above -- so a getByText would not say which one it read.
    const announcement = page.getByTestId("disclosure-summary-announcement");
    await expect.element(announcement).toHaveTextContent(noPayloadSentence);
    expect(announcement.element().textContent).not.toContain("risk_score");
  });

  test("a two-sided invitation still lists the disclosed set", async () => {
    // The direction is the whole of the gate: the same file and marks under terms
    // that give the inviting party a result render the list in full.
    mountStep(acceptorTerms);
    // Awaited first: the announcement is debounced, so settling it here is what
    // puts the spoken copy inside the container check below rather than reading it
    // while the region is still empty.
    await expect
      .element(page.getByTestId("disclosure-summary-announcement"))
      .toHaveTextContent(
        `Columns sent to your partner: ${isolatedColumnName("risk_score")}.`,
      );
    expect(app.container.textContent).not.toContain(noPayloadSentence);
    await expect
      .element(page.getByText("For each matched row:", { exact: false }))
      .toHaveTextContent("risk_score");
    expect(app.container.textContent).toContain(
      "Nothing here is sent to your partner except the columns you mark as shared.",
    );
  });

  test("the acceptor's own withheld result does not suppress its send", async () => {
    // The direction control. Terms that share nothing back still have this party
    // sending -- the inviting party receives -- so a panel gated on the mirrored
    // field (this party's own receipt) would hide a disclosure that does happen,
    // which is the one way to get the direction wrong that costs the operator
    // something.
    mountStep({
      ...acceptorTerms,
      output: { expectsOutput: true, shareWithPartner: false },
    });
    // The region reads the same field as the panel, so the control holds for the
    // spoken copy too: silence here would be the suppression that costs most, an
    // operator hearing nothing where a disclosure does happen.
    await expect
      .element(page.getByTestId("disclosure-summary-announcement"))
      .toHaveTextContent(
        `Columns sent to your partner: ${isolatedColumnName("risk_score")}.`,
      );
    expect(app.container.textContent).not.toContain(noPayloadSentence);
    await expect
      .element(page.getByText("For each matched row:", { exact: false }))
      .toHaveTextContent("risk_score");
  });
});

describe("acceptor columns step: the columns the invitation will not accept", () => {
  // An invitation holding a present-but-empty `payload.receive` is the inviting
  // party declaring it takes no column; core mirrors that onto this party as an
  // empty `payload.send` and refuses the run against disclosed metadata, so the
  // conflict is stated on this screen, where the marks that decide it are set.
  const acceptsNoColumns: LinkageTerms = {
    ...acceptorTerms,
    payload: { receive: [] },
  };

  // The name fields satisfy both keys and the unrecognized column infers to role:
  // payload, so this conflict is the only thing that can close the launch. That
  // column has a bidi override (U+202E) because the alert names it beside the
  // grid row the operator has to change, and the two must name it alike.
  const bidiColumn = "notes\u202Eevil";

  function mountStep(linkageTerms: LinkageTerms) {
    const columns = ["first_name", "last_name", bidiColumn];
    const rows = [Object.fromEntries(columns.map((c) => [c, "x"]))];
    const columnsState = acceptorInitialColumnsState(columns);
    const editorState = acceptorColumnsEditorState(
      columnsState,
      linkageTerms,
      rows,
    );
    const noop = () => undefined;
    app.render(
      createElement(AcceptorColumnsStep, {
        linkageTerms,
        columns,
        columnsState,
        editorState,
        verdict: acceptorVerdict(columns, linkageTerms, editorState),
        onMetadataChange: noop,
        onRemap: noop,
        onReset: noop,
        onLaunch: noop,
        onBack: noop,
      }),
    );
  }

  test("names the column as the grid does, disables launch, and says why at the button", async () => {
    mountStep(acceptsNoColumns);
    await expect
      .element(page.getByText("Your partner will not accept this column"))
      .toBeInTheDocument();

    // The alert tells the operator which grid row to change, so it names the
    // column exactly as that row does -- isolated, never escaped. An entry
    // reading differently from the row it points at is the failure here.
    const item = app.container.querySelector<HTMLElement>("li bdi");
    expect(item?.textContent).toBe(bidiColumn);
    const rowHeaders = [
      ...app.container.querySelectorAll('th[scope="row"]'),
    ].map((element) => element.textContent);
    expect(rowHeaders).toContain(bidiColumn);
    expect(app.container.textContent).not.toContain(
      sanitizeForDisplay(bidiColumn),
    );

    // The gate itself, and the reason a keyboard/screen-reader user at the button
    // hears: resolved through the button's own description, so a reason rendered
    // but never associated fails here.
    const start = page.getByRole("button", { name: "Start the exchange" });
    await expect.element(start).toBeDisabled();
    const reasonId = start.element().getAttribute("aria-describedby");
    expect(reasonId).toBeTruthy();
    expect(document.getElementById(reasonId!)?.textContent).toBe(
      "Resolve the columns your partner will not accept above before you can start.",
    );
  });

  test("an invitation that declares no payload set leaves the launch open", async () => {
    // The declaration is the whole of the gate: the same file and marks under an
    // invitation that names no payload set render no panel and no reason, and the
    // launch stays available.
    mountStep(acceptorTerms);
    await expect
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeEnabled();
    expect(
      page.getByText("Your partner will not accept this column").query(),
    ).toBeNull();
    expect(app.container.textContent).not.toContain("before you can start");
    // Silent, not absent: the region stands ready for a reason arising later.
    await expect
      .element(page.getByTestId("launch-blocked-reason"))
      .toBeInTheDocument();
    expect(
      page
        .getByRole("button", { name: "Start the exchange" })
        .element()
        .getAttribute("aria-describedby"),
    ).toBeNull();
  });
});

describe("acceptor screen: run and completion", () => {
  // Consent, name, a fully-covered file, then Start the exchange -- the columns
  // step's launch, which auto-starts the run. The run token has a future expiry
  // and an empty disclosed set (the commitment the hook threads in). Returns
  // once the captured lifecycle exists so callers can drive its callbacks right
  // away.
  async function reachRun(hash?: string) {
    window.location.hash = hash ?? (await encodeRunToken());
    app.render(createElement(AcceptorScreen));
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Continue: consent & your file" }),
    );
    await consentAndName();
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      csvFile("first_name,last_name\nAlice,Smith\n"),
    );
    await expect
      .element(page.getByText("cohort_intake.csv"))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Accept and continue" }),
    );
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Start the exchange" }),
    );
    await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(1));
  }

  test("launch auto-starts as the PSI initiator on the token's secret and expiry", async () => {
    await reachRun();

    // The run started as the initiator (the acceptor dials) the moment the launch
    // appeared -- no second press -- on the token's secret and expiry.
    expect(lifecycleHarness.calls).toHaveLength(1);
    const call = lifecycleCall(0);
    expect(call.exchangeRole).toBe("initiator");
    expect(call.sharedSecret.length).toBeGreaterThan(0);
    expect(call.expires).toBeDefined();
    expect(call.signal.aborted).toBe(false);

    // The run column opens at "Exchange in progress" and its heading takes focus.
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange in progress");
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toBe("Exchange in progress");
    });
  });

  test("the timeline advances with the acceptor labels", async () => {
    await reachRun();
    const call = lifecycleCall(0);
    call.onStages(stagesFor(preparedWith("cascade", 2), "acceptor"));
    call.onStage("waiting for peer");

    // The acceptor's rail timeline opens at Connect, current while connecting,
    // and the waiting stage's label is the acceptor's, not the inviter's. Read
    // the label node (the class), since the history row repeats the text.
    const rail = () =>
      document.querySelector('nav[aria-label="Exchange progress"]') as Element;
    const currentStepLabel = () =>
      rail().querySelector('[aria-current="step"] .mantine-Stepper-stepLabel')
        ?.textContent;
    await vi.waitFor(() => {
      expect(document.querySelector(`.${styles.stageLabel}`)?.textContent).toBe(
        "Connecting to your partner",
      );
    });
    expect(currentStepLabel()).toBe("Connect");

    // A protocol stage flips Connect to done and Confirm protocol to current.
    call.onStage("confirming protocol");
    await vi.waitFor(() => {
      expect(currentStepLabel()).toBe("Confirm protocol");
    });

    // Per-key stages sit under Link keys.
    call.onStage("stage 2 / 2");
    await vi.waitFor(() => {
      expect(document.querySelector(`.${styles.stageLabel}`)?.textContent).toBe(
        "Linking key 2 / 2",
      );
    });
    expect(currentStepLabel()).toBe("Link keys");
  });

  test("completion offers downloads and fixes the past-tense ledger", async () => {
    await reachRun();
    const call = lifecycleCall(0);
    call.onStages(stagesFor(preparedWith("cascade", 2), "acceptor"));
    call.onStage("waiting for peer");
    call.onStage("confirming protocol");
    call.onResult({
      kind: "matched" as const,
      resultsUrl: URL.createObjectURL(new Blob(["a,b\n"])),
      matchedRecordCount: 1847,
      record: {
        recordUrl: URL.createObjectURL(new Blob(["{}"])),
        recordFileName: "psilink-record-2026-07-08T14-32.json",
        keysUrl: URL.createObjectURL(new Blob(["{}"])),
        keysFileName: "psilink-record-2026-07-08T14-32.keys.json",
      },
    });

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange complete");
    await expect
      .element(page.getByText(/1,847.*matched records/))
      .toBeInTheDocument();
    await expect.element(page.getByText(/^Finished /)).toBeInTheDocument();
    // The status label's live region reaches the final "Done".
    expect(document.querySelector(`.${styles.stageLabel}`)?.textContent).toBe(
      "Done",
    );

    // The three downloads with their caveats.
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[download]"),
    );
    expect(links.map((link) => link.textContent)).toEqual([
      "results.csv",
      "psilink-record-2026-07-08T14-32.json",
      "psilink-record-2026-07-08T14-32.keys.json",
    ]);
    expect(links[2].getAttribute("aria-label")).toBe(
      "Download verification keys (keep private): " +
        "psilink-record-2026-07-08T14-32.keys.json",
    );

    // The timeline finishes whole (nothing current), and the ledger becomes
    // final: the tag names who it was agreed with, rows relabel past tense, and
    // the trust line changes.
    const rail = document.querySelector('nav[aria-label="Exchange progress"]');
    expect((rail as Element).querySelector('[aria-current="step"]')).toBeNull();
    const ledger = document.querySelector(
      'aside[aria-label="This exchange"]',
    ) as Element;
    // The Customize group left the ledger with the launch.
    expect(ledger.textContent).not.toContain("Customize");
    expect(ledger.textContent).toContain(
      "Agreed with County Health Department",
    );
    expect(ledger.textContent).toContain("You sent");
    expect(ledger.textContent).toContain("You received");
    expect(ledger.textContent).toContain("Results went to");
    expect(ledger.textContent).toContain(
      "1,847 matched rows + enrollment_date, program_code",
    );
    expect(ledger.textContent).toContain("Your file never left this browser.");

    const another = Array.from(document.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "Set up another exchange",
    );
    expect(another?.getAttribute("href")).toBe("/quick");
  });

  test("at a narrow viewport the settled share bar keeps the You sent row", async () => {
    // The condensed "What you will share" bar selects rows by the producers'
    // shareBar markers, so the settled ledger's past-tense relabel ("You
    // sent") cannot drop the one row naming what was disclosed to the partner.
    await page.viewport(400, 800);
    try {
      await reachRun();
      const call = lifecycleCall(0);
      call.onStages(stagesFor(preparedWith("cascade", 2), "acceptor"));
      call.onStage("waiting for peer");
      call.onStage("confirming protocol");
      call.onResult({
        kind: "matched" as const,
        resultsUrl: URL.createObjectURL(new Blob(["a,b\n"])),
        matchedRecordCount: 1847,
        record: {
          recordUrl: URL.createObjectURL(new Blob(["{}"])),
          recordFileName: "psilink-record-2026-07-08T14-32.json",
          keysUrl: URL.createObjectURL(new Blob(["{}"])),
          keysFileName: "psilink-record-2026-07-08T14-32.keys.json",
        },
      });
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Exchange complete");

      const shareToggle = page.getByRole("button", {
        name: "What you will share",
      });
      await expect.element(shareToggle).toBeInTheDocument();
      await shareToggle.click();
      await expect
        .element(shareToggle)
        .toHaveAttribute("aria-expanded", "true");

      // The settled condensed subset: what left, what arrived, what matched.
      const shareBar = document.querySelector(`.${styles.shareBar}`) as Element;
      const rows = Array.from(
        shareBar.querySelectorAll(`.${styles.ledgerRow}`),
      ).map((row) => row.querySelector("dt")?.textContent);
      expect(rows).toEqual(["You sent", "You received", "Matched on"]);
      const sentRow = Array.from(
        shareBar.querySelectorAll(`.${styles.ledgerRow}`),
      ).find((row) => row.querySelector("dt")?.textContent === "You sent");
      // This run disclosed no extra columns, and the row says so rather than
      // disappearing.
      expect(sentRow?.querySelector("dd")?.textContent).toBe(
        "No additional columns",
      );
    } finally {
      await page.viewport(1280, 800);
    }
  });

  test("the settled ledger's You sent names the launched disclosed column", async () => {
    // The full flow with an extra unrecognized `comment` column against a run token
    // whose terms request no payload from the acceptor. The column transmits (infers
    // to role: payload), so the settled "You sent" row must name it -- the completion
    // footer attests "the results above are all your partner received about your
    // data," so a ledger that hid this column would make that attestation false.
    window.location.hash = await encodeRunToken();
    app.render(createElement(AcceptorScreen));
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Continue: consent & your file" }),
    );
    await consentAndName();
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      csvFile("first_name,last_name,comment\nAlice,Smith,ok\n"),
    );
    await expect
      .element(page.getByText("cohort_intake.csv"))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Accept and continue" }),
    );
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Start the exchange" }),
    );
    await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(1));

    lifecycleCall(0).onResult({
      kind: "matched" as const,
      resultsUrl: URL.createObjectURL(new Blob(["a,b\n"])),
      matchedRecordCount: 12,
      record: {
        recordUrl: URL.createObjectURL(new Blob(["{}"])),
        recordFileName: "psilink-record.json",
        keysUrl: URL.createObjectURL(new Blob(["{}"])),
        keysFileName: "psilink-record.keys.json",
      },
    });

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange complete");
    const ledger = document.querySelector(
      'aside[aria-label="This exchange"]',
    ) as Element;
    const sentRow = Array.from(ledger.querySelectorAll("div")).find(
      (row) => row.querySelector("dt")?.textContent === "You sent",
    );
    expect(sentRow).toBeDefined();
    expect(sentRow?.querySelector("dd")?.textContent).toContain("comment");
    expect(sentRow?.querySelector("dd")?.textContent).not.toContain(
      "No additional columns",
    );
  });

  test("a withheld result states the caveat and offers only the record downloads", async () => {
    await reachRun();
    const call = lifecycleCall(0);
    call.onStage("waiting for peer");
    call.onResult({
      kind: "withheld" as const,
      record: {
        recordUrl: URL.createObjectURL(new Blob(["{}"])),
        recordFileName: "psilink-record-x.json",
        keysUrl: URL.createObjectURL(new Blob(["{}"])),
        keysFileName: "psilink-record-x.keys.json",
      },
    });

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange complete");
    await expect
      .element(
        page.getByText(
          "Your records contributed to the match. By the agreed terms, you " +
            "receive no result table, so there is nothing to download here.",
        ),
      )
      .toBeInTheDocument();
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[download]"),
    ).map((link) => link.textContent);
    expect(links).toEqual([
      "psilink-record-x.json",
      "psilink-record-x.keys.json",
    ]);
    // The settled receive row reports the withheld caveat.
    expect(
      document.querySelector('aside[aria-label="This exchange"]')?.textContent,
    ).toContain("No result table - withheld by the agreed terms");
  });

  test("a count-only result states its count, not the withheld copy", async () => {
    await reachRun();
    const call = lifecycleCall(0);
    call.onStage("waiting for peer");
    call.onResult({
      kind: "counted" as const,
      intersectionCount: 1847,
      countReportedByPartner: false,
      record: {
        recordUrl: URL.createObjectURL(new Blob(["{}"])),
        recordFileName: "psilink-record-x.json",
        keysUrl: URL.createObjectURL(new Blob(["{}"])),
        keysFileName: "psilink-record-x.keys.json",
      },
    });

    // The count is the run's whole result, stated once where the download would
    // be; the headline names the mode rather than repeating the figure.
    await expect
      .element(page.getByText("Count only", { exact: true }))
      .toBeInTheDocument();
    // Scoped to the inset: the settled ledger states the same count in its own
    // words, so a bare figure match resolves to both.
    await expect
      .element(page.getByText(/1,847\s+records in common\. This exchange/))
      .toBeInTheDocument();
    expect(document.querySelector(`.${styles.bigCount}`)?.textContent).toBe(
      "Exchange complete - count only",
    );
    // Not the withheld helper's outcome: this party received exactly what its
    // terms promised.
    expect(document.body.textContent).not.toContain(
      "Your records contributed to the match",
    );
    // And the count it computed itself has no partner caveat, in the inset or
    // in the ledger's condensed restatement of it.
    expect(document.body.textContent).not.toContain(
      "psilink does not check a count it is sent",
    );
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[download]"),
    ).map((link) => link.textContent);
    expect(links).toEqual([
      "psilink-record-x.json",
      "psilink-record-x.keys.json",
    ]);
    const ledger = document.querySelector(
      'aside[aria-label="This exchange"]',
    )?.textContent;
    expect(ledger).toContain(
      "1,847 records in common - the size of the overlap only",
    );
    expect(ledger).not.toContain("reported by your partner");
  });

  test("a count the partner reported has the trust caveat", async () => {
    // The sender seat's number arrived over the partner's count-report leg and is
    // checked against no round of this party's own, so the reminder lands where
    // the number is read rather than only at consent time.
    await reachRun();
    const call = lifecycleCall(0);
    call.onStage("waiting for peer");
    call.onResult({
      kind: "counted" as const,
      intersectionCount: 1847,
      countReportedByPartner: true,
    });

    await expect
      .element(page.getByText(/1,847\s+records in common\. This exchange/))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "Your partner ran the match and sent you this number. psilink does " +
            "not check a count it is sent against a run of its own, so the " +
            "figure is your partner's word for it.",
        ),
      )
      .toBeInTheDocument();
    // The ledger restates the count in its own words, so it has the row-sized
    // form of the same fact.
    expect(
      document.querySelector('aside[aria-label="This exchange"]')?.textContent,
    ).toContain(
      "1,847 records in common - the size of the overlap only, no matched " +
        "rows and no shared columns; reported by your partner",
    );
  });

  test("a retryable exchange failure offers Try again on the same invitation", async () => {
    await reachRun();
    lifecycleCall(0).onStage("waiting for peer");
    lifecycleCall(0).onError({
      category: "exchange",
      error: new Error("transport"),
    });

    // The alert takes focus and states the temporary nature.
    await expect.element(page.getByText("Exchange failed")).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(
        (document.activeElement as HTMLElement | null)?.textContent,
      ).toContain("Exchange failed");
    });

    await page.getByRole("button", { name: "Try again" }).click();
    await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(2));
    expect(lifecycleCall(1).sharedSecret).toBe(lifecycleCall(0).sharedSecret);
    expect(page.getByText("Exchange failed").query()).toBeNull();
  });

  test("an exchange failure past expiry swaps Try again for start-over", async () => {
    await reachRun();
    lifecycleCall(0).onStage("waiting for peer");

    // Jump past the token's 1-hour expiry (Date only: timers stay real so React
    // scheduling and vi.waitFor's polling keep working), then land a failure that
    // would otherwise be retryable.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
      lifecycleCall(0).onError({
        category: "exchange",
        error: new Error("transport"),
      });

      await vi.waitFor(() => {
        expect(
          Array.from(document.querySelectorAll("a")).some(
            (anchor) =>
              anchor.textContent === "Start over with a fresh invitation",
          ),
        ).toBe(true);
      });
      // The fresh-start recovery is a quick-path link (the acceptor cannot mint).
      const link = Array.from(document.querySelectorAll("a")).find(
        (anchor) => anchor.textContent === "Start over with a fresh invitation",
      );
      expect(link?.getAttribute("href")).toBe("/quick");
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (button) => button.textContent === "Try again",
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("a security failure forbids retry and links to a fresh invitation", async () => {
    await reachRun();
    lifecycleCall(0).onStage("waiting for peer");
    lifecycleCall(0).onError({
      category: "security",
      error: new Error("kex failed"),
    });

    await expect
      .element(page.getByText("Could not verify your partner"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Do not retry", { exact: false }))
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: "Try again" }).query()).toBeNull();
    // The acceptor cannot mint, so the only recovery is a link to the quick path.
    const link = Array.from(document.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "Start over with a fresh invitation",
    );
    expect(link?.getAttribute("href")).toBe("/quick");
  });

  test("an expired-invitation security failure names itself, not the partner", async () => {
    await reachRun();
    lifecycleCall(0).onStage("waiting for peer");
    lifecycleCall(0).onError({
      category: "security",
      error: Object.assign(
        new Error(
          "shared secret expired at 2026-07-08T19:32:00.000Z; obtain a new invitation",
        ),
        { psilinkRecoveryHintEmitted: true },
      ),
    });

    await expect
      .element(page.getByText("This invitation can no longer be used"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("expired at 2026-07-08T19:32:00.000Z", { exact: false }),
      )
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: "Try again" }).query()).toBeNull();
    const link = Array.from(document.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "Start over with a fresh invitation",
    );
    expect(link?.getAttribute("href")).toBe("/quick");
  });

  test("a config failure shows its message and returns to the columns step", async () => {
    await reachRun();
    lifecycleCall(0).onError({
      category: "config",
      error: new Error("standardization output name contradicts the terms"),
    });

    // The prepare-time fault names only local config, so the message is
    // shown, and the recovery returns to Confirm your columns with state
    // intact (the acceptor fixes its own settings there).
    await expect
      .element(page.getByText("Could not prepare the exchange"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("standardization output name contradicts the terms"),
      )
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: "Try again" }).query()).toBeNull();
    await page.getByRole("button", { name: "Back to your columns" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
  });

  test("Back after a back-to-columns recovery lands on columns, not the dead run surface", async () => {
    // Reaching the run pushes a `launched` history entry; the config-failure
    // recovery then clears the launch that entry's work column reads and pushes
    // a fresh columns entry. The `launched` entry is now backed by nothing --
    // pressing Back must not restore a bogus in-progress surface for a run
    // that is not running.
    await reachRun();
    lifecycleCall(0).onError({
      category: "config",
      error: new Error("standardization output name contradicts the terms"),
    });
    await page.getByRole("button", { name: "Back to your columns" }).click();
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();

    // Back lands on the clamped columns step, and the dead entry's marker was
    // rewritten to columns (it read `launched` when Back arrived on it).
    window.history.back();
    await vi.waitFor(() => {
      expect(
        (window.history.state as Record<string, unknown>)[STEP_STATE_KEY],
      ).toBe("columns");
    });
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
    expect(
      page.getByRole("heading", { name: "Exchange in progress" }).query(),
    ).toBeNull();

    // Forward then Back does not resurrect the dead entry either. Both entries
    // now have the same columns marker, so each move is awaited on its own
    // popstate rather than a state change.
    const nextPopState = () =>
      new Promise<void>((resolve) => {
        window.addEventListener("popstate", () => resolve(), { once: true });
      });
    let landed = nextPopState();
    window.history.forward();
    await landed;
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
    landed = nextPopState();
    window.history.back();
    await landed;
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
    expect(
      page.getByRole("heading", { name: "Exchange in progress" }).query(),
    ).toBeNull();
    // The discarded launch never restarted the run.
    expect(lifecycleHarness.calls).toHaveLength(1);
  });

  test("an output failure offers no re-run, only a fresh setup", async () => {
    await reachRun();
    lifecycleCall(0).onStage("waiting for peer");
    lifecycleCall(0).onStage("confirming protocol");
    lifecycleCall(0).onError({
      category: "output",
      error: new Error("blob quota exceeded"),
    });

    // The exchange already succeeded, so the alert must not invite running it
    // again: no Try again, no start-over link -- only the way out to a new
    // exchange.
    await expect
      .element(page.getByText("Results unavailable"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(/a local write failed: blob quota exceeded/))
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: "Try again" }).query()).toBeNull();
    expect(
      Array.from(document.querySelectorAll("a")).some(
        (anchor) => anchor.textContent === "Start over with a fresh invitation",
      ),
    ).toBe(false);
    const another = Array.from(document.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "Set up another exchange",
    );
    expect(another?.getAttribute("href")).toBe("/quick");
  });

  test("a partially-covered file never reaches the run at all", async () => {
    // A partially-covered file never reaches a run: the launch gate refuses it at
    // this seat, so nothing starts and there is no run surface to warn on.
    window.location.hash = await encodeRunToken();
    app.render(createElement(AcceptorScreen));
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Continue: consent & your file" }),
    );
    await consentAndName();
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      csvFile("first_name,notes\nAlice,vip\n"),
    );
    await expect
      .element(page.getByText("cohort_intake.csv"))
      .toBeInTheDocument();
    await userEvent.click(
      page.getByRole("button", { name: "Accept and continue" }),
    );
    await expect
      .element(page.getByText("1 of 2 keys can match"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeDisabled();
    expect(lifecycleHarness.calls).toHaveLength(0);
  });
});
