/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { encodeInvitation, generateSharedSecret } from "@psilink/core";

import {
  clearAcceptHandoff,
  peekAcceptHandoff,
  stashAcceptHandoff,
} from "@components/acceptHandoff";
import { AcceptInvitation } from "@components/AcceptInvitation";

import { expandFieldCards } from "./fieldCards";

import type { Root } from "react-dom/client";

import type { InvitationToken, LinkageTerms } from "@psilink/core";
import type { ExchangeConfig } from "@components/ExchangeView";

// Stub the dialing exchange screen: this suite verifies the REVIEW + PREPARE
// screens -- that the prepare editor mounts only after consent, and the exchange
// screen mounts (carrying the parsed file and the editor's metadata/standardization)
// only after the operator confirms in the editor, never before -- not the exchange
// itself, which would pull in peerjs and the PSI WASM. Capture the props the route
// hands it so the test can assert the bundle, the threaded edits, and the carried
// advisory; the no-dial-before-Start half lives in exchangeView.test.ts. (vitest
// hoists vi.mock above the imports.)
const exchange = vi.hoisted(() => ({
  lastProps: undefined as ExchangeConfig | undefined,
}));
vi.mock("@components/ExchangeView", () => ({
  ExchangeView: (props: ExchangeConfig) => {
    exchange.lastProps = props;
    return createElement(
      "div",
      { "data-testid": "exchange-mounted" },
      "exchange",
    );
  },
}));

// Stub the dropzone with a file counter and two buttons -- one seeds the selected
// file from `harness`, one is the real "Accept and continue" submit (honoring the
// consent gate via submitDisabled). The real FileAcquire still runs the real CSV
// parse on submit; the satisfiability verdict now lives in the prepare editor, not
// here. The counter lets the test wait for the file-state commit before
// submitting, so handleSubmit never reads a stale (empty) selection.
const harness = vi.hoisted(() => ({ files: [] as Array<File> }));
vi.mock("@components/FileSelect", () => ({
  default: (props: {
    submitLabel: string;
    submitted: boolean;
    submitDisabled?: boolean;
    files: Array<File>;
    handleSubmit: () => void;
    setFiles: (files: Array<File>) => void;
  }) =>
    createElement(
      "div",
      null,
      createElement(
        "span",
        { "data-testid": "file-count" },
        String(props.files.length),
      ),
      createElement(
        "button",
        {
          "data-testid": "select",
          onClick: () => props.setFiles(harness.files),
        },
        "select",
      ),
      createElement(
        "button",
        {
          "data-testid": "accept",
          disabled:
            props.submitted || props.files.length === 0 || props.submitDisabled,
          onClick: props.handleSubmit,
        },
        props.submitLabel,
      ),
    ),
}));

// Hold the CSV parse open per-test so the consent state can change WHILE the parse
// is in flight -- the window in which the re-check must read live consent, not the
// value captured when the parse started. With `defer` unset it delegates to the
// real inline loader (every other test's synchronous small-file parse); with it set
// the returned promise settles only when the test calls `resolve`.
const csvLoadHarness = vi.hoisted(() => ({
  defer: false,
  resolve: undefined as ((value: unknown) => void) | undefined,
}));
vi.mock("@psi/csvParseController", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadCSVFileOffMainThread: (file: unknown, options?: unknown) => {
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

// Two single-element linkage keys, one per name field, so a CSV can satisfy both,
// one, or neither -- the three pre-flight outcomes the acceptor distinguishes. The
// identity drives the "Invitation from ..." heading the terms render.
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

// Encode a token WITHOUT schema validation, mirroring encodeInvitation's wire
// format (base64url body plus a 4-byte SHA-256 checksum), so a test can mint a
// checksum-valid string that fails the invitation schema and thus makes
// decodeInvitation throw a ZodError. encodeInvitation itself validates first, so
// it cannot produce a schema-invalid token.
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

// Flip the final checksum character of a valid encoded invitation so the body
// still decodes but the appended checksum no longer matches -- decodeInvitation
// then throws the plain "invitation checksum mismatch" Error (not a ZodError).
function corruptChecksum(encoded: string): string {
  const last = encoded.slice(-1);
  return encoded.slice(0, -1) + (last === "A" ? "B" : "A");
}

function csvFile(content: string): File {
  return new File([content], "data.csv", { type: "text/csv" });
}

let container: HTMLElement | undefined;
let root: Root | undefined;

function mountAcceptRoute() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    createElement(MantineProvider, null, createElement(AcceptInvitation)),
  );
}

function exchangeMounted(): boolean {
  return document.querySelector('[data-testid="exchange-mounted"]') !== null;
}

// Consent, name, and choose a file -- the full review action short of pressing
// "Accept and continue". Waits for the file-state commit so the submit reads it.
async function reviewAndChoose(file: File) {
  await userEvent.click(page.getByRole("checkbox"));
  await userEvent.fill(page.getByRole("textbox"), "Dana");
  harness.files = [file];
  await userEvent.click(page.getByTestId("select"));
  await expect.element(page.getByTestId("file-count")).toHaveTextContent("1");
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  harness.files = [];
  exchange.lastProps = undefined;
  csvLoadHarness.defer = false;
  csvLoadHarness.resolve = undefined;
  window.location.hash = "";
  // Drop any accept hand-off a test stashed, so it cannot leak into the next mount.
  clearAcceptHandoff();
});

describe("accept review screen (consent + file before any connection)", () => {
  test("mounts the prepare editor, not the exchange, after consent and Accept", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();

    // The decoded terms render once the async decode resolves.
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // Pre-consent: the affirmative action is present but disabled, and neither the
    // editor nor the dialing exchange screen has mounted.
    const accept = page.getByTestId("accept");
    await expect.element(accept).toBeDisabled();
    expect(exchangeMounted()).toBe(false);

    // Consent + name + a parsed file enables the action.
    await reviewAndChoose(csvFile("first_name,last_name\nAlice,Smith\n"));
    await expect.element(accept).toBeEnabled();

    // Accept moves to the "Prepare your data" editor -- NOT straight to the
    // exchange. Nothing dials yet.
    await userEvent.click(accept);
    await expect
      .element(page.getByRole("heading", { name: "Prepare your data" }))
      .toBeInTheDocument();
    expect(exchangeMounted()).toBe(false);
  });

  test("a file chosen on the home page pre-fills the dropzone but still waits for consent", async () => {
    window.location.hash = await encodeAcceptToken();
    // The acceptor dropped their file on the home page before pressing "Review
    // invitation"; it rides here as a hand-off (a File handle, never parsed yet).
    stashAcceptHandoff(csvFile("first_name,last_name\nAlice,Smith\n"));
    mountAcceptRoute();

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // The hand-off seeded the dropzone selection without a click here -- the user
    // need not re-drop the same file.
    await expect.element(page.getByTestId("file-count")).toHaveTextContent("1");

    // The module stash is consumed exactly once on mount: a later back/forward
    // navigation to /accept finds nothing and falls back to the picker rather than
    // re-seeding from this now-captured file. (afterEach also clears it, so this
    // asserts the component did the consume, not the cleanup.)
    expect(peekAcceptHandoff()).toBeUndefined();

    // But the file is only SELECTED, not parsed: with no consent yet the action
    // stays disabled and nothing has transitioned, so the consent gate is intact.
    await expect.element(page.getByTestId("accept")).toBeDisabled();
    expect(exchangeMounted()).toBe(false);
    expect(document.body.textContent).not.toContain("Prepare your data");

    // Consent + name then enables it, exactly as a re-dropped file would.
    await userEvent.click(page.getByRole("checkbox"));
    await userEvent.fill(page.getByRole("textbox"), "Dana");
    await expect.element(page.getByTestId("accept")).toBeEnabled();
  });

  test("after acquiring, a back edge does not re-seed the stale home-page file", async () => {
    window.location.hash = await encodeAcceptToken();
    stashAcceptHandoff(csvFile("first_name,last_name\nAlice,Smith\n"));
    mountAcceptRoute();

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    // Seeded from the hand-off on the first mount.
    await expect.element(page.getByTestId("file-count")).toHaveTextContent("1");

    // Consent, name, accept -> reaches the prepare editor (the seed is now consumed).
    await userEvent.click(page.getByRole("checkbox"));
    await userEvent.fill(page.getByRole("textbox"), "Dana");
    await expect.element(page.getByTestId("accept")).toBeEnabled();
    await userEvent.click(page.getByTestId("accept"));
    await expect
      .element(page.getByRole("heading", { name: "Prepare your data" }))
      .toBeInTheDocument();

    // Back to the review screen: the dropzone must start EMPTY, not resurrect the
    // home-page file over whatever the operator would now choose. Re-seeding here
    // would silently revert an in-route file change to the original hand-off.
    await userEvent.click(
      page.getByRole("button", { name: "Choose a different file" }),
    );
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    await expect.element(page.getByTestId("file-count")).toHaveTextContent("0");
  });

  // Settle the deferred parse with a satisfiable two-name result, letting the
  // acquire handler's consent re-check run against whatever consent state the test
  // has since set.
  function resolveParse() {
    if (csvLoadHarness.resolve === undefined)
      throw new Error("the deferred parse has not started");
    csvLoadHarness.resolve({
      data: [{ first_name: "Alice", last_name: "Smith" }],
      errors: [],
      meta: { fields: ["first_name", "last_name"] },
    });
  }

  test("revoking consent while the parse is in flight blocks the commit", async () => {
    window.location.hash = await encodeAcceptToken();
    csvLoadHarness.defer = true;
    mountAcceptRoute();

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    await reviewAndChoose(csvFile("first_name,last_name\nAlice,Smith\n"));
    await userEvent.click(page.getByTestId("accept"));

    // The parse is now in flight (its promise is held open). Revoke consent before
    // it resolves: the checkbox is still live.
    await expect.poll(() => csvLoadHarness.resolve !== undefined).toBe(true);
    await userEvent.click(page.getByRole("checkbox"));
    await expect.element(page.getByRole("checkbox")).not.toBeChecked();

    // The parse now resolves against revoked consent. The re-check reads the live
    // (revoked) consent, so nothing commits.
    resolveParse();

    // Committing would swap the review panel for the prepare editor and unmount the
    // consent checkbox. Assert the POSITIVE, stable signal that the review screen
    // stands -- the checkbox is still present -- rather than racing the absence of a
    // heading that a wrong commit would mount only after a further render. Poll long
    // enough that a mis-fired commit would have transitioned by now.
    for (let i = 0; i < 20; i++) {
      expect(page.getByRole("checkbox").elements()).toHaveLength(1);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(document.body.textContent).not.toContain("Prepare your data");
    expect(exchangeMounted()).toBe(false);
  });

  test("re-consenting after a blocked commit lets the operator resubmit the same file in place", async () => {
    window.location.hash = await encodeAcceptToken();
    csvLoadHarness.defer = true;
    mountAcceptRoute();

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    await reviewAndChoose(csvFile("first_name,last_name\nAlice,Smith\n"));
    await userEvent.click(page.getByTestId("accept"));

    // Revoke consent while the parse is in flight, then let it resolve: the
    // re-check reads the revoked consent, so the commit is blocked and the acquire
    // phase must reset -- otherwise "accept" stays stuck disabled below.
    await expect.poll(() => csvLoadHarness.resolve !== undefined).toBe(true);
    await userEvent.click(page.getByRole("checkbox"));
    await expect.element(page.getByRole("checkbox")).not.toBeChecked();
    resolveParse();

    // The blocked handoff must not dead-end the control: consent is still off here,
    // so "accept" stays disabled by the live consent gate (submitDisabled), not by
    // a stuck `submitted` -- re-consenting (the name is untouched throughout) makes
    // it interactive again with no remount and no page reload.
    const accept = page.getByTestId("accept");
    await userEvent.click(page.getByRole("checkbox"));
    await expect.element(page.getByRole("checkbox")).toBeChecked();
    await expect.element(accept).toBeEnabled();

    // Resubmitting the SAME file (still selected; reviewAndChoose is not called
    // again) now commits and reaches the prepare editor. Let this second parse
    // resolve inline (the first is already spent) so the resubmit does not hang on
    // another deferred promise the test would otherwise have to resolve.
    csvLoadHarness.defer = false;
    await userEvent.click(accept);
    await expect
      .element(page.getByRole("heading", { name: "Prepare your data" }))
      .toBeInTheDocument();
    expect(exchangeMounted()).toBe(false);
  });

  test("consent kept through the parse commits and reaches the prepare editor", async () => {
    window.location.hash = await encodeAcceptToken();
    csvLoadHarness.defer = true;
    mountAcceptRoute();

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    await reviewAndChoose(csvFile("first_name,last_name\nAlice,Smith\n"));
    await userEvent.click(page.getByTestId("accept"));

    // Consent is given and kept through the deferred parse; resolving it commits and
    // advances to the prepare editor.
    await expect.poll(() => csvLoadHarness.resolve !== undefined).toBe(true);
    resolveParse();
    await expect
      .element(page.getByRole("heading", { name: "Prepare your data" }))
      .toBeInTheDocument();
    expect(exchangeMounted()).toBe(false);
  });

  test("does not enable accept (or mount anything) without consent", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();

    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // A name and a file, but consent unchecked: the action stays disabled and
    // nothing transitions.
    await userEvent.fill(page.getByRole("textbox"), "Dana");
    harness.files = [csvFile("first_name,last_name\nAlice,Smith\n")];
    await userEvent.click(page.getByTestId("select"));
    await expect.element(page.getByTestId("file-count")).toHaveTextContent("1");

    await expect.element(page.getByTestId("accept")).toBeDisabled();
    expect(exchangeMounted()).toBe(false);
    expect(document.body.textContent).not.toContain("Prepare your data");
  });
});

describe("prepare your data editor (verdict, disclosure, launch)", () => {
  // Consent, name, choose the file, and press Accept to land in the editor.
  async function reachEditor(file: File) {
    await reviewAndChoose(file);
    await userEvent.click(page.getByTestId("accept"));
    await expect
      .element(page.getByRole("heading", { name: "Prepare your data" }))
      .toBeInTheDocument();
  }

  test("the editor's side panel is the shared exchange summary and lists the sent columns as chips", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();
    // `notes` is the unrecognized column inferred as payload, so it is the one this
    // party will send.
    await reachEditor(csvFile("first_name,last_name,notes\nAlice,Smith,vip\n"));
    // The agreed terms sit in the shared ExchangeSummary panel (the side column,
    // mirroring the inviter's Advanced-options layout); for the acceptor the panel's
    // terms heading names the inviter.
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    // The columns this party will send are surfaced there as a chip list (named for
    // assistive tech), with `notes` among the chips.
    const sendChips = page.getByRole("list", {
      name: "What you will send to your partner",
    });
    await expect.element(sendChips).toBeInTheDocument();
    await expect.element(sendChips.getByText("notes")).toBeInTheDocument();
  });

  test("a satisfiable file reaches the exchange on Start exchange, threading the edited spec", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // first_name + last_name satisfy both keys; the extra unrecognized `notes`
    // column is inferred as payload, so the send-column chips name exactly it. (A
    // recognized type such as `zip_code` would infer as linkage and NOT be sent.)
    await reachEditor(csvFile("first_name,last_name,notes\nAlice,Smith,vip\n"));
    await expect
      .element(
        page
          .getByRole("list", { name: "What you will send to your partner" })
          .getByText("notes"),
      )
      .toBeInTheDocument();

    // "Start exchange" launches directly: the old "confirm what you will send"
    // modal is gone (consent was given on the review screen, and the live send
    // chips above are the standing last-look), so the click is the only step before
    // the exchange mounts.
    expect(exchangeMounted()).toBe(false);
    await userEvent.click(page.getByRole("button", { name: "Start exchange" }));

    await expect
      .element(page.getByTestId("exchange-mounted"))
      .toBeInTheDocument();
    if (exchange.lastProps?.role !== "acceptor")
      throw new Error("expected acceptor config");
    expect(exchange.lastProps.partyName).toBe("Dana");
    expect(exchange.lastProps.acquired.columns).toEqual([
      "first_name",
      "last_name",
      "notes",
    ]);
    // The editor's edited metadata and standardization are threaded to the run.
    expect(exchange.lastProps.metadata.map((c) => c.name)).toEqual([
      "first_name",
      "last_name",
      "notes",
    ]);
    expect(exchange.lastProps.standardization.length).toBeGreaterThan(0);
    // A fully satisfiable file carries no partial-coverage advisory.
    expect(exchange.lastProps.initialWarning).toBeUndefined();
  });

  test("the verdict is announced from a separate stable live region, not the visible alert", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    await reachEditor(csvFile("notes\nhello\n"));
    await expect
      .element(page.getByText("This file cannot match yet"))
      .toBeInTheDocument();

    // The VISIBLE verdict container is NOT a live region and its Alert is
    // role="presentation": the colored verdict renders immediately (no flash or
    // shift) but announces nothing directly, so it neither fires on mount against
    // the heading focus nor nests an assertive region. This is the residue that
    // regression guards.
    const verdict = document.querySelector('[data-testid="verdict"]');
    expect(verdict?.getAttribute("role")).toBeNull();
    expect(verdict?.getAttribute("aria-live")).toBeNull();
    expect(
      verdict?.querySelector('[role="alert"], [role="status"]'),
    ).toBeNull();

    // The verdict reaches assistive tech through a SEPARATE, stable polite live
    // region that carries the verdict text (the deferred empty -> non-empty timing
    // that makes a present-on-mount verdict announce is the hook's job and is not
    // observable here; this asserts the channel, the regression-guarded residue).
    const announcement = page.getByTestId("verdict-announcement");
    await expect
      .element(announcement)
      .toHaveTextContent(
        "No agreed linkage key can be satisfied by your columns",
      );
    expect(announcement.element().getAttribute("role")).toBe("status");
    expect(announcement.element().getAttribute("aria-live")).toBe("polite");
  });

  test("Back returns to the review screen and a different file reseeds the editor", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // Reach the editor with a first file; the unrecognized `comment` column is the
    // inferred payload, so it is the lone send-column chip.
    await reachEditor(
      csvFile("first_name,last_name,comment\nAlice,Smith,ok\n"),
    );
    await expect
      .element(
        page
          .getByRole("list", { name: "What you will send to your partner" })
          .getByText("comment"),
      )
      .toBeInTheDocument();

    // Back returns to the review screen (the terms heading shows again) and the
    // editor unmounts -- nothing was committed, and consent is preserved.
    await userEvent.click(
      page.getByRole("button", { name: "Choose a different file" }),
    );
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Prepare your data");
    expect(exchangeMounted()).toBe(false);

    // A different file (consent already given, so only re-select) re-enters the
    // editor reseeded from the NEW columns: `notes` is the payload now, not `comment`.
    harness.files = [csvFile("first_name,last_name,notes\nBob,Jones,hi\n")];
    await userEvent.click(page.getByTestId("select"));
    await expect.element(page.getByTestId("file-count")).toHaveTextContent("1");
    await userEvent.click(page.getByTestId("accept"));
    await expect
      .element(page.getByRole("heading", { name: "Prepare your data" }))
      .toBeInTheDocument();
    await expect
      .element(
        page
          .getByRole("list", { name: "What you will send to your partner" })
          .getByText("notes"),
      )
      .toBeInTheDocument();
  });

  test("a file with two identifier columns gates Start exchange even when keys are satisfiable", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // `id` and `identifier` both infer to role:identifier, so the seed carries two
    // identifiers. The name columns satisfy both keys (not blocked), but the grid
    // flags the ambiguous identifier and "Start exchange" stays disabled until it is
    // fixed.
    await reachEditor(
      csvFile("id,identifier,first_name,last_name\n1,2,Alice,Smith\n"),
    );
    // The VISIBLE error is shown for sighted users (queried by testid -- the
    // announcement carries the same text, so a getByText would be ambiguous).
    await expect
      .element(page.getByTestId("identifier-conflict"))
      .toHaveTextContent(
        "Only one column can be the row identifier. Choose a single identifier.",
      );
    await expect
      .element(page.getByRole("button", { name: "Start exchange" }))
      .toBeDisabled();
    expect(exchangeMounted()).toBe(false);

    // The visible error carries no role of its own, so it neither announces on
    // mount nor double-announces with the channel below.
    expect(
      page.getByTestId("identifier-conflict").element().getAttribute("role"),
    ).toBeNull();

    // The grid's identifier-conflict reaches assistive tech through a SEPARATE,
    // stable, always-present polite live region that carries the message with no
    // nested role="alert" (which would fight the "Prepare your data" heading focus).
    // The deferred empty -> non-empty timing that makes a present-on-mount conflict
    // announce is the hook's job and is not observable here; this asserts the
    // channel. This is the acceptor half of the same fix the inviter test asserts.
    const conflictAnnouncement = page.getByTestId(
      "identifier-conflict-announcement",
    );
    await expect
      .element(conflictAnnouncement)
      .toHaveTextContent(
        "Only one column can be the row identifier. Choose a single identifier.",
      );
    expect(conflictAnnouncement.element().getAttribute("role")).toBe("status");
    expect(conflictAnnouncement.element().getAttribute("aria-live")).toBe(
      "polite",
    );
    expect(
      conflictAnnouncement.element().querySelector('[role="alert"]'),
    ).toBeNull();
  });

  test("a zero-coverage file shows the block and disables Start exchange, so nothing dials", async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // No name columns at all: no linkage key can match. The dead-end is now an
    // editor entry -- the block message shows, "Start exchange" is disabled, and
    // nothing dials -- but the operator can fix it in place rather than being
    // bounced out.
    await reachEditor(csvFile("notes\nhello\n"));
    await expect
      .element(page.getByText("This file cannot match yet"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Start exchange" }))
      .toBeDisabled();
    expect(exchangeMounted()).toBe(false);
  });

  test('"Map a column to each missing field" actually satisfies the field -- the chosen column is made a match column, not just retyped', async () => {
    window.location.hash = await encodeAcceptToken();
    mountAcceptRoute();
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // Both columns are unrecognized, so each infers to role: payload (core
    // inferMetadata's fallback) -- neither matches a first_name/last_name field, so
    // the file is blocked. This is the reported bug's exact shape: the columns the
    // quick-fix offers start at `payload`, and merely retyping one (setColumnType's
    // keep-branch preserves a sent column's disclosure) would leave it role: payload
    // and unusable for linkage, so the verdict would never clear.
    await reachEditor(csvFile("alpha,beta\nAlice,Smith\n"));
    await expect
      .element(page.getByText("This file cannot match yet"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Map a column to each missing field"))
      .toBeInTheDocument();

    // Map `alpha` to First name: the field becomes satisfiable (its remap select
    // unmounts), so the verdict advances to partial rather than staying blocked --
    // proof the column was re-roled to linkage, not just retyped.
    const firstNameSelect = page.getByRole("combobox", {
      name: "First name",
      exact: true,
    });
    await userEvent.click(firstNameSelect);
    await userEvent.click(page.getByRole("option", { name: "alpha" }));
    await expect
      .element(page.getByText("1 of 2 keys can match"))
      .toBeInTheDocument();
    // The verdict transition is also voiced through the separate announcer (the
    // partial-state spoken string, distinct from the visible alert prose).
    await expect
      .element(page.getByTestId("verdict-announcement"))
      .toHaveTextContent(
        "1 of 2 linkage keys can be satisfied by your columns",
      );

    // Map `beta` to Last name: now every key is satisfiable, the block is gone, and
    // "Start exchange" is enabled. Before the fix this remained "This file cannot
    // match yet" no matter how many columns were chosen.
    const lastNameSelect = page.getByRole("combobox", {
      name: "Last name",
      exact: true,
    });
    await userEvent.click(lastNameSelect);
    await userEvent.click(page.getByRole("option", { name: "beta" }));
    await expect
      .element(page.getByText("All 2 keys can match"))
      .toBeInTheDocument();
    // The all-clear transition is voiced through the announcer too -- proof the
    // partial and all-clear announcer strings are wired, not just the blocked one.
    await expect
      .element(page.getByTestId("verdict-announcement"))
      .toHaveTextContent("All 2 linkage keys can be satisfied by your columns");
    await expect
      .element(page.getByRole("button", { name: "Start exchange" }))
      .toBeEnabled();
    // The disclosure consequence of the fix: both columns started as inferred
    // payload (sent); remapping them to match makes them role: linkage / not sent,
    // so nothing is now disclosed. The "what you will send" summary reflects that --
    // proof the remap re-roled the columns rather than leaving them sent.
    await expect
      .element(page.getByText(/No columns\. Only the linkage result/))
      .toBeInTheDocument();
  });

  test("clearing a required param on a recommended step disables Start exchange until it is fixed, so a malformed pipeline never reaches the exchange", async () => {
    // A date_of_birth field, whose recommended pipeline includes parse_date -- a
    // standard-tier step that renders its "Input format" param inline. Editing it
    // exercises the same launch gate the add-menu path would, through the override
    // layer, with a directly visible control.
    const dobTerms: LinkageTerms = {
      version: "1.0.0",
      identity: "County Health Department",
      date: "2026-01-01",
      algorithm: "psi",
      linkageStrategy: "cascade",
      output: { expectsOutput: true, shareWithPartner: true },
      deduplicate: false,
      linkageFields: [{ name: "dob", type: "date_of_birth" }],
      linkageKeys: [{ name: "d", elements: [{ field: "dob" }] }],
    };
    window.location.hash = await encodeAcceptToken(dobTerms);
    mountAcceptRoute();
    await expect
      .element(page.getByText("Invitation from County Health Department"))
      .toBeInTheDocument();

    // A satisfiable file: the launch gate is open before any step edit.
    await reachEditor(csvFile("date_of_birth\n01/02/1990\n"));
    const startButton = page.getByRole("button", {
      name: "Start exchange",
    });
    await expect.element(startButton).toBeEnabled();

    // The field's cleaning card starts collapsed; expand it to reach the step's
    // inline "Input format" param.
    await expandFieldCards();

    // Clear the recommended parse_date step's required "Input format": the step is
    // now mid-edit. A malformed step would run as a silent full-field exclusion or
    // throw at compile, so the gate must close until it is valid again.
    const inputFormat = page.getByRole("textbox", { name: "Input format" });
    await userEvent.clear(inputFormat);
    await expect
      .element(
        page.getByText(
          "Finish or fix the highlighted cleaning steps before continuing.",
        ),
      )
      .toBeInTheDocument();
    await expect.element(startButton).toBeDisabled();

    // Restoring a valid value re-opens the gate and clears the alert.
    await userEvent.fill(inputFormat, "MM/DD/YYYY");
    await expect.element(startButton).toBeEnabled();
    expect(
      page
        .getByText(
          "Finish or fix the highlighted cleaning steps before continuing.",
        )
        .elements(),
    ).toHaveLength(0);
  });
});

describe("decode error rendering", () => {
  test("renders a schema failure as a readable line, not a raw ZodError blob", async () => {
    // A checksum-valid token that fails the invitation schema (an invalid
    // sharedSecret) makes decodeInvitation throw a ZodError. The acceptor must
    // see the collapsed `<path>: <message>` one-liner from describeDecodeError,
    // never Zod's serialized issues blob -- the readability this change delivers.
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
    mountAcceptRoute();

    await expect
      .element(page.getByText("Cannot accept this invitation"))
      .toBeInTheDocument();
    const text = document.body.textContent;
    expect(text).toContain("sharedSecret:");
    // The raw blob is `JSON.stringify(issues)`, which always carries a "code"
    // key; the readable one-liner never does.
    expect(text).not.toContain('"code"');
  });

  test("surfaces a non-ZodError failure's plain message unchanged", async () => {
    // A corrupted checksum is a plain Error, not a ZodError; its fixed message
    // must pass through verbatim.
    window.location.hash = corruptChecksum(await encodeAcceptToken());
    mountAcceptRoute();

    await expect
      .element(page.getByText("invitation checksum mismatch"))
      .toBeInTheDocument();
  });
});
