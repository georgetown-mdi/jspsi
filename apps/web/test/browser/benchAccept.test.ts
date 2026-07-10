/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { encodeInvitation, generateSharedSecret } from "@psilink/core";

import { AcceptorBench } from "@bench/AcceptorBench";
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

    expect(navigation.calls).toEqual([{ to: "/bench/accept", hash: "ABC123" }]);
  });

  test("an empty paste shows the inline field error and does not navigate", async () => {
    mount(createElement(BenchLobby));
    await expect
      .element(page.getByLabelText("Invitation link or code"))
      .toBeInTheDocument();

    // A URL with an empty fragment extracts to no token.
    await userEvent.fill(
      page.getByLabelText("Invitation link or code"),
      "https://example.test/accept#",
    );
    await userEvent.click(
      page.getByRole("button", { name: "Review invitation" }),
    );

    const error = page.getByText("An invitation is required");
    await expect.element(error).toBeInTheDocument();
    expect(error.element().getAttribute("role")).toBe("alert");
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

    // The rail walks the acceptor spine with Review terms current.
    const rail = document.querySelector(
      'nav[aria-label="Accept an invitation"]',
    );
    expect(rail).not.toBeNull();
    expect(
      (rail as Element).querySelector('[aria-current="step"]')?.textContent,
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

  test("Reset to recommended restores the file-derived defaults", async () => {
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

    // Reset restores the recommended (file-derived) metadata: back to all-clear.
    await userEvent.click(
      page.getByRole("button", { name: "Reset to recommended" }),
    );
    await expect
      .element(page.getByText("All 2 keys can match"))
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

  test("the Cleaning rail tab opens the acceptor's own cleaning editor", async () => {
    await reachColumns("first_name,last_name\nAlice,Smith\n");
    // The Customize group's Cleaning tab navigates to the cleaning sub-section
    // (the acceptor edits only its own standardization there).
    await userEvent.click(page.getByRole("button", { name: "Cleaning" }));
    await expect
      .element(page.getByRole("heading", { name: "Cleaning" }))
      .toBeInTheDocument();
    // Back returns to the columns confirm surface.
    await userEvent.click(
      page.getByRole("button", { name: "Back to Confirm your columns" }),
    );
    await expect
      .element(page.getByRole("heading", { name: "Confirm your columns" }))
      .toBeInTheDocument();
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
    await vi.waitFor(() => {
      expect(document.querySelector(`.${styles.stageLabel}`)?.textContent).toBe(
        "Connecting to your partner",
      );
    });
    expect(rail().querySelector('[aria-current="step"]')?.textContent).toBe(
      "Connect",
    );

    // A protocol stage flips Connect to done and Confirm protocol to current.
    call.onStage("confirming protocol");
    await vi.waitFor(() => {
      expect(rail().querySelector('[aria-current="step"]')?.textContent).toBe(
        "Confirm protocol",
      );
    });

    // Per-key stages sit under Link keys.
    call.onStage("stage 2 / 2");
    await vi.waitFor(() => {
      expect(document.querySelector(`.${styles.stageLabel}`)?.textContent).toBe(
        "Linking key 2 / 2",
      );
    });
    expect(rail().querySelector('[aria-current="step"]')?.textContent).toBe(
      "Link keys",
    );
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
    expect(another?.getAttribute("href")).toBe("/bench");
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
      // The fresh-start recovery is a lobby link (the acceptor cannot mint).
      const link = Array.from(document.querySelectorAll("a")).find(
        (anchor) => anchor.textContent === "Start over with a fresh invitation",
      );
      expect(link?.getAttribute("href")).toBe("/bench");
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
    // The acceptor cannot mint, so the only recovery is a link to the lobby.
    const link = Array.from(document.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "Start over with a fresh invitation",
    );
    expect(link?.getAttribute("href")).toBe("/bench");
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
    expect(link?.getAttribute("href")).toBe("/bench");
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
    expect(another?.getAttribute("href")).toBe("/bench");
  });

  test("the partial-coverage advisory shows in the rail and the work column", async () => {
    // A partially-covered file (only first_name recognized) raises the WP2
    // warning at launch, which the run surfaces in both the rail's Problems
    // block and a work-column amber alert.
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

    // The advisory shows in BOTH the rail's Problems block and the work column's
    // amber alert. "Partial coverage" appears in both, so scope each query rather
    // than match globally (Playwright strict mode rejects the ambiguity).
    await vi.waitFor(() => {
      const rail = document.querySelector(
        'nav[aria-label="Exchange progress"]',
      );
      const problems = (rail as Element).querySelector(
        'section[aria-label="Problems"]',
      );
      expect(problems?.textContent).toContain("Partial coverage");
    });
    // The work column (outside the rail) carries the same advisory as an amber
    // alert body -- the message the rail's short label does not.
    const work = document.querySelector("main") as Element;
    expect(work.textContent).toContain("Partial coverage");
    expect(work.textContent).toContain("linkage keys can match with");
  });
});
