/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

// Load Mantine's stylesheet so components render with their real
// geometry: without it the Stepper's completed-step icon has no size
// bound and blankets the top bar, intercepting unrelated clicks.
import "@mantine/core/styles.css";

import { MantineProvider } from "@mantine/core";

import {
  encodeInvitation,
  generateSharedSecret,
  sanitizeForDisplay,
} from "@psilink/core";

import {
  acceptorColumnsEditorState,
  acceptorInitialColumnsState,
  acceptorVerdict,
} from "@bench/acceptorColumnsModel";
import { AcceptorBench } from "@bench/AcceptorBench";
import { AcceptorColumnsStep } from "@bench/AcceptorColumnsStep";
import { BENCH_STEP_STATE_KEY } from "@bench/stepHistory";
import { BenchLobby } from "@bench/BenchLobby";
import { stagesFor } from "@bench/exchangeRun";
import styles from "@bench/bench.module.css";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import type {
  InvitationToken,
  LinkageTerms,
  PreparedExchange,
} from "@psilink/core";

// Stub the router seam. useNavigate returns a captured spy so the lobby paste
// test can assert the navigation target and hash; Link renders a plain anchor.
// (vitest hoists vi.mock above the imports.)
const navigation = vi.hoisted(() => ({
  calls: [] as Array<unknown>,
}));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    className,
    children,
  }: {
    to?: string;
    className?: string;
    children?: ReactNode;
  }) =>
    createElement(
      "a",
      { href: typeof to === "string" ? to : "#", className },
      children,
    ),
  useNavigate: () => (options: unknown) => {
    navigation.calls.push(options);
    return undefined;
  },
}));

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
vi.mock("@psi/csvParseController", async (importOriginal) => {
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

// Stub the rendezvous module: importing it runs a top-level config load that
// reads `process` (absent in the browser runner). Its dial function only runs
// inside the run lifecycle's acquire closure, which the lifecycle stub below
// never invokes (the bench.test.ts pattern).
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));

// Stub the run lifecycle so launching an exchange never dials: record each
// invocation's options so a test can drive the captured onStages/onStage/
// onResult/onError seams -- the same seams the real lifecycle fires -- and assert
// the acceptor's run/completion screens against them (the bench.test.ts pattern).
interface CapturedLifecycle {
  exchangeRole: "initiator" | "responder";
  sharedSecret: string;
  expires?: string;
  signal: AbortSignal;
  onStages: (stages: Array<unknown>) => void;
  onStage: (stageId: string) => void;
  onResult: (outputs: {
    resultsUrl?: string;
    resultWithheld?: boolean;
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

// A token carrying a future expiry and a disclosed payload subset (the columns
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

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(content: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(MantineProvider, null, content));
}

afterEach(() => {
  // Backstop for the fake-Date test below: a failure between useFakeTimers and
  // its finally must not leak a frozen clock into the rest of the suite.
  vi.useRealTimers();
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
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

describe("bench lobby: review invitation", () => {
  test("a pasted token navigates to the accept bench with the token in the hash", async () => {
    mount(createElement(BenchLobby));
    await expect
      .element(page.getByLabelText("Invitation link or code"))
      .toBeInTheDocument();

    // A deep-link URL: the token is everything after the first '#'.
    await userEvent.fill(
      page.getByLabelText("Invitation link or code"),
      "https://example.test/accept#ABC123",
    );
    await userEvent.click(
      page.getByRole("button", { name: "Review invitation" }),
    );

    expect(navigation.calls).toEqual([{ to: "/accept", hash: "ABC123" }]);
  });

  test("Review invitation is disabled until the field holds a usable token", async () => {
    mount(createElement(BenchLobby));
    const review = page.getByRole("button", { name: "Review invitation" });
    // Empty field: nothing to review, so the action is withheld.
    await expect.element(review).toBeDisabled();

    await userEvent.fill(
      page.getByLabelText("Invitation link or code"),
      "MYTOKEN",
    );
    await expect.element(review).toBeEnabled();

    // Whitespace alone is not a usable token (tokenFromInput trims), so the gate
    // closes again rather than offering an action that would no-op.
    await userEvent.fill(page.getByLabelText("Invitation link or code"), "   ");
    await expect.element(review).toBeDisabled();

    // A URL whose fragment is empty also extracts to no token.
    await userEvent.fill(
      page.getByLabelText("Invitation link or code"),
      "https://example.test/accept#",
    );
    await expect.element(review).toBeDisabled();

    // No navigation happened while the field was empty or whitespace-only.
    expect(navigation.calls).toEqual([]);
  });
});

describe("acceptor bench: decode gate", () => {
  test("an expired invitation renders the focused cannot-accept alert", async () => {
    window.location.hash = await encodeExpiredToken();
    mount(createElement(AcceptorBench));

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
    mount(createElement(AcceptorBench));
    await expect
      .element(page.getByText("Cannot accept this invitation"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("No invitation was found", { exact: false }))
      .toBeInTheDocument();
  });

  test("a ready decode moves focus to the terms heading", async () => {
    window.location.hash = await encodeAcceptToken();
    mount(createElement(AcceptorBench));
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
    mount(createElement(AcceptorBench));

    await expect
      .element(page.getByText("Cannot accept this invitation"))
      .toBeInTheDocument();
    const text = document.body.textContent;
    expect(text).toContain("sharedSecret:");
    // The raw blob is `JSON.stringify(issues)`, which always carries a "code"
    // key; the readable one-liner never does.
    expect(text).not.toContain('"code"');
  });
});

describe("acceptor bench: review terms", () => {
  test("renders the full expanded terms with the unverified-name note and no condensation toggle", async () => {
    window.location.hash = await encodeAcceptToken();
    mount(createElement(AcceptorBench));

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
      "These terms are your partner's proposal, read-only.",
    );

    // The top bar walks the acceptor spine with Review terms current; the
    // step indicators share the button's text, so read the label node.
    const rail = document.querySelector(
      'nav[aria-label="Accept an invitation"]',
    );
    expect(rail).not.toBeNull();
    expect(
      (rail as Element).querySelector(
        '[aria-current="step"] .mantine-Stepper-stepLabel',
      )?.textContent,
    ).toBe("Review terms");
  });

  test("Continue advances to the consent step", async () => {
    window.location.hash = await encodeAcceptToken();
    mount(createElement(AcceptorBench));
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

describe("acceptor bench: consent gate and parse-behind-consent", () => {
  async function reachConsent() {
    window.location.hash = await encodeAcceptToken();
    mount(createElement(AcceptorBench));
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

describe("acceptor bench: consent-step legal-agreement display", () => {
  // acceptorTerms carries no agreement, so the display tests mint their own
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
    mount(createElement(AcceptorBench));
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

describe("acceptor bench: confirm your columns (verdict, mapper, launch)", () => {
  // Consent, name, choose a file, and press Accept to land on the columns step.
  async function reachColumns(content: string) {
    window.location.hash = await encodeAcceptToken();
    mount(createElement(AcceptorBench));
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

  test("a partially-covered file warns with the N-of-M copy and still enables launch", async () => {
    await reachColumns("first_name,notes\nAlice,vip\n");
    await expect
      .element(page.getByText("1 of 2 keys can match"))
      .toBeInTheDocument();
    // Partial coverage warns, never blocks.
    await expect
      .element(page.getByRole("button", { name: "Start the exchange" }))
      .toBeEnabled();
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

  test("Reset to defaults restores the file-derived defaults", async () => {
    await reachColumns("first_name,last_name\nAlice,Smith\n");
    await expect
      .element(page.getByText("All 2 keys can match"))
      .toBeInTheDocument();

    // Retype first_name to a non-matching type via the grid, dropping a key.
    const typeSelect = page.getByRole("combobox", {
      name: "Type for column first_name",
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
    // single-identifier conflict the grid surfaces (inferMetadata seeds it; the
    // mutators never create it).
    await reachColumns("id,identifier,first_name,last_name\n1,2,Alice,Smith\n");
    const conflict = page.getByTestId("identifier-conflict");
    await expect.element(conflict).toBeInTheDocument();
    const errorId = conflict.element().getAttribute("id");
    expect(errorId).toBeTruthy();

    // Both offending Type controls carry the control-level error signal and
    // point their description at the visible error element. (exact: true --
    // "Type for column id" is a substring of "Type for column identifier".)
    for (const columnName of ["id", "identifier"]) {
      const control = page.getByRole("combobox", {
        name: `Type for column ${columnName}`,
        exact: true,
      });
      expect(control.element().getAttribute("aria-invalid")).toBe("true");
      expect(control.element().getAttribute("aria-describedby")).toBe(errorId);
    }

    // A non-identifier Type control carries no stale error association.
    const bystander = page.getByRole("combobox", {
      name: "Type for column first_name",
      exact: true,
    });
    expect(bystander.element().getAttribute("aria-invalid")).toBeNull();
    expect(bystander.element().getAttribute("aria-describedby")).toBeNull();

    // Retype one identifier to Other: the conflict clears and no control keeps a
    // stale aria-invalid/association.
    const idControl = page.getByRole("combobox", {
      name: "Type for column identifier",
      exact: true,
    });
    await userEvent.click(idControl);
    await userEvent.click(
      page.getByRole("option", { name: "Other (not used for matching)" }),
    );
    expect(page.getByTestId("identifier-conflict").query()).toBeNull();
    const survivor = page.getByRole("combobox", {
      name: "Type for column id",
      exact: true,
    });
    expect(survivor.element().getAttribute("aria-invalid")).toBeNull();
    expect(survivor.element().getAttribute("aria-describedby")).toBeNull();
  });

  test("the ledger's You will send names the extra disclosed column, not the invitation's request", async () => {
    // The invitation requests no payload from the acceptor (acceptorTerms has no
    // payload.receive), so its terms name nothing to send. But the file carries an
    // unrecognized `comment` column, which infers to role: payload -- the acceptor
    // transmits it for matched rows. The ledger's "You will send" must name that
    // column (what actually leaves), not read "No additional columns" off the
    // inviter's empty request. This is the consent-truthfulness defect the security
    // panel proved false on the ledger.
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
    // The old bug read the empty invitation request as "No additional columns".
    expect(sendRow?.querySelector("dd")?.textContent).not.toContain(
      "No additional columns",
    );
    // And the confirm step's own summary, the surface that already told the truth,
    // agrees -- the two no longer contradict.
    await expect
      .element(page.getByText("For each matched row: comment."))
      .toBeInTheDocument();
  });

  test("the step-3 ledger footer swaps to the local-only line", async () => {
    await reachColumns("first_name,last_name\nAlice,Smith\n");
    const ledger = document.querySelector('aside[aria-label="This exchange"]');
    expect(ledger?.textContent).toContain(
      "Column typing and cleaning stay on your device. Your partner sees " +
        "matches, never these settings.",
    );
    expect(ledger?.textContent).not.toContain(
      "These terms are your partner's proposal, read-only.",
    );
  });

  test("Start the exchange launches the minimal run stub carrying the edited spec", async () => {
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
    // row carries aria-current.
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

describe("acceptor columns step: disclosure summary sanitization", () => {
  test("a disclosed column name carrying a bidi override renders escaped, never raw", async () => {
    // The operator's own CSV header is untrusted display input: a bidi override
    // (U+202E, right-to-left override) embedded in a column name must not
    // reorder the summary of what leaves the machine. The name is unrecognized,
    // so it infers to role: payload -- the disclosed set -- while
    // first_name/last_name satisfy both keys, so the "What you will send" panel
    // renders instead of the mapper.
    const bidiColumn = "notes\u202Eevil";
    const columns = ["first_name", "last_name", bidiColumn];
    const rows = [Object.fromEntries(columns.map((c) => [c, "x"]))];
    const columnsState = acceptorInitialColumnsState(columns);
    const editorState = acceptorColumnsEditorState(
      columnsState,
      acceptorTerms,
      rows,
    );
    const verdict = acceptorVerdict(columns, acceptorTerms, editorState);
    const noop = () => undefined;
    mount(
      createElement(AcceptorColumnsStep, {
        linkageTerms: acceptorTerms,
        columns,
        columnsState,
        editorState,
        verdict,
        onMetadataChange: noop,
        onRemap: noop,
        onReset: noop,
        onLaunch: noop,
        onBack: noop,
      }),
    );

    // Scoped to the summary panel: the metadata grid on the same step renders
    // the raw column name (a distinct surface), so a document-wide raw-character
    // check would not pin this panel's escaping.
    const summary = page.getByText("For each matched row:", { exact: false });
    await expect.element(summary).toBeInTheDocument();
    const text = summary.element().textContent;
    // The escaped form sanitizeForDisplay produces (a visible backslash-u
    // literal), never the raw override character.
    expect(text).toContain(
      `For each matched row: ${sanitizeForDisplay(bidiColumn)}.`,
    );
    expect(text).not.toContain("\u202E");
  });
});

describe("acceptor bench: run and completion", () => {
  // Consent, name, a fully-covered file, then Start the exchange -- the columns
  // step's launch, which auto-starts the run. The run token carries a future
  // expiry and an empty disclosed set (the lock-in the hook threads in). Returns
  // once the captured lifecycle exists so callers can drive its seams right away.
  async function reachRun(hash?: string) {
    window.location.hash = hash ?? (await encodeRunToken());
    mount(createElement(AcceptorBench));
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

  test("completion offers downloads and settles the past-tense ledger", async () => {
    await reachRun();
    const call = lifecycleCall(0);
    call.onStages(stagesFor(preparedWith("cascade", 2), "acceptor"));
    call.onStage("waiting for peer");
    call.onStage("confirming protocol");
    call.onResult({
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

    // The timeline finishes whole (nothing current), and the ledger settles: the
    // tag names who it was agreed with, rows relabel past tense, and the trust
    // line changes.
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
    mount(createElement(AcceptorBench));
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
      resultWithheld: true,
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

  test("a config failure surfaces its message and returns to the columns step", async () => {
    await reachRun();
    lifecycleCall(0).onError({
      category: "config",
      error: new Error("standardization output name contradicts the terms"),
    });

    // The prepare-time fault names only local config, so the message is
    // surfaced, and the recovery returns to Confirm your columns with state
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
        (window.history.state as Record<string, unknown>)[BENCH_STEP_STATE_KEY],
      ).toBe("columns");
    });
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
    expect(
      page.getByRole("heading", { name: "Exchange in progress" }).query(),
    ).toBeNull();

    // Forward then Back does not resurrect the dead entry either. Both entries
    // now carry the same columns marker, so each move is awaited on its own
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
      .element(
        page.getByText(
          /generating the results file failed: blob quota exceeded/,
        ),
      )
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

  test("the partial-coverage advisory shows in Problems and the work column", async () => {
    // A partially-covered file (only first_name recognized) raises the
    // partial-coverage advisory at launch, which the run surfaces in both the
    // work column's Problems block and its own amber alert.
    window.location.hash = await encodeRunToken();
    mount(createElement(AcceptorBench));
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
    await userEvent.click(
      page.getByRole("button", { name: "Start the exchange" }),
    );
    await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(1));

    // The advisory shows in BOTH the work column's Problems block (the short
    // label) and its own amber alert (the fuller message) -- scope each query
    // rather than match globally (Playwright strict mode rejects the
    // ambiguity).
    await vi.waitFor(() => {
      const problems = document.querySelector('section[aria-label="Problems"]');
      expect(problems?.textContent).toContain("Partial coverage");
    });
    const work = document.querySelector("main") as Element;
    expect(work.textContent).toContain("Partial coverage");
    expect(work.textContent).toContain("linkage keys can match with");
  });
});
