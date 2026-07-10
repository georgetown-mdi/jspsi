/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { encodeInvitation, generateSharedSecret } from "@psilink/core";

import { AcceptorBench } from "@bench/AcceptorBench";
import { BenchLobby } from "@bench/BenchLobby";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import type { InvitationToken, LinkageTerms } from "@psilink/core";

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
// reads `process` (absent in the browser runner). Nothing in this slice invokes
// its functions, so the stub is inert (the bench.test.ts pattern).
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));

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
