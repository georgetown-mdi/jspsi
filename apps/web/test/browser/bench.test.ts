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

import { decodeInvitation } from "@psilink/core";

import { BENCH_STEP_STATE_KEY } from "@bench/stepHistory";
import { BenchLobby } from "@bench/BenchLobby";
import { InvitationFileError } from "@psi/invitation";
import { InviterBench } from "@bench/InviterBench";
import { stagesFor } from "@bench/exchangeRun";
import styles from "@bench/bench.module.css";

import type { PreparedExchange } from "@psilink/core";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// Stub the router seam the bench components touch (the lobby's Links). This
// suite asserts the bench's structure, landmarks, and tokens, not navigation
// -- the appShell.test.ts pattern. vitest hoists the mock above the imports,
// so the components pick up the stub.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    ...rest
  }: {
    to?: string;
    children?: ReactNode;
    [prop: string]: unknown;
  }) =>
    // Forward the remaining props (className plus the data-* attributes Mantine
    // sets from its polymorphic component, e.g. the `inherit` marker) so a
    // rendered Anchor styled via those attributes is faithful, not stripped.
    createElement(
      "a",
      { ...rest, href: typeof to === "string" ? to : "#" },
      children,
    ),
  useNavigate: () => () => undefined,
}));

// Swap the mint per-test to drive the create action's failure paths, which a
// real (validated-before-arming) mint cannot reach deterministically. With
// `fail` unset it delegates to the real generateInvitation, so the happy-path
// create below runs against the real mint boundary (the csvLoad pattern from
// fileAcquire.test.ts).
const mintHarness = vi.hoisted(() => ({
  fail: undefined as Error | undefined,
}));
vi.mock("@psi/invitation", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    generateInvitation: (params: unknown) =>
      mintHarness.fail !== undefined
        ? Promise.reject(mintHarness.fail)
        : (actual.generateInvitation as (p: unknown) => Promise<unknown>)(
            params,
          ),
  };
});

// Defer or fail the CSV parse per-test to observe in-flight state (the
// Continue gate, the abort signal) and the read-failure path, which a real
// parse of an inline File cannot reach deterministically. With both knobs
// unset it delegates to the real loader.
const csvLoadHarness = vi.hoisted(() => ({
  defer: false,
  fail: undefined as Error | undefined,
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
// reads `process` (absent in the browser runner). Its listen function only
// runs inside the run lifecycle's acquire closure, which the lifecycle stub
// below never invokes (the exchangeView.test.ts pattern).
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));

// Stub the run lifecycle so creating an invitation never dials: record each
// invocation's options so a test can drive the captured onStages/onStage/
// onResult/onError seams -- the same seams the real lifecycle fires -- and
// assert the bench's post-create screens against them.
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

const EM_DASH = "\u2014";

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(content: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(createElement(MantineProvider, null, content));
}

afterEach(async () => {
  // Backstop for the fake-Date test below: a failure between useFakeTimers and
  // its finally must not leak a frozen clock into the rest of the suite.
  vi.useRealTimers();
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  mintHarness.fail = undefined;
  csvLoadHarness.defer = false;
  csvLoadHarness.fail = undefined;
  csvLoadHarness.lastSignal = undefined;
  csvLoadHarness.resolve = undefined;
  lifecycleHarness.calls.length = 0;
  // The bench reads the viewport width to choose its wide vs narrow layout, so
  // a test that narrows the page must not leak that width into the next:
  // restore the browser project's configured wide default (vite.config.ts).
  await page.viewport(1280, 800);
});

// Walk the spine to a sealed invitation: name, file, straight through to
// Review & create, then the real mint (the lifecycle beneath it is stubbed,
// so nothing dials).
async function createSealedInvitation() {
  mount(createElement(InviterBench));
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
  await page.getByRole("button", { name: "Create the invitation" }).click();
  await expect
    .element(page.getByRole("heading", { level: 1 }))
    .toHaveTextContent("Your invitation is ready");
  // The run starts from an effect after the invitation lands; wait for it so
  // callers can drive the captured lifecycle seams right away.
  await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(1));
}

// Walk the spine to Review & create WITHOUT creating: name, file, straight
// through to the review step, ready to choose a transport. Shared by the
// command-line-transport tests below.
async function reachReviewCreate() {
  mount(createElement(InviterBench));
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

// The download the save handler triggers: a synthetic anchor is created,
// clicked, and removed within one turn, so a DOM query cannot catch it. Capture
// it at click time -- the download filename and the blob text the object URL
// points at, read back before the deferred revoke.
interface CapturedDownload {
  fileName: string;
  text: string;
}
function captureDownloads(): {
  captured: Array<CapturedDownload>;
  restore: () => void;
} {
  const captured: Array<CapturedDownload> = [];
  const original = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
    if (this.download !== "" && this.href.startsWith("blob:")) {
      const href = this.href;
      const fileName = this.download;
      // The blob is still alive here (revoke is deferred well past the click);
      // pull its text synchronously enough via the object URL.
      captured.push({ fileName, text: "" });
      const index = captured.length - 1;
      void fetch(href)
        .then((response) => response.text())
        .then((text) => {
          captured[index].text = text;
        });
    }
    // Do not invoke the real click: a jsdom/browser navigation to a blob URL is
    // pointless here and can warn. The capture above is the whole point.
  };
  return {
    captured,
    restore: () => {
      HTMLAnchorElement.prototype.click = original;
    },
  };
}

// stagesFor reads only the linkage terms off the prepared exchange (the unit
// suite's stand-in), so the tests can hand the captured onStages the real
// derived tree.
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

describe("bench quick path", () => {
  test("renders the quick-path structure with one main and one h1", async () => {
    mount(createElement(BenchLobby));

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("psilink - private record linkage");

    expect(document.querySelectorAll("main").length).toBe(1);
    expect(document.querySelectorAll("h1").length).toBe(1);

    const cardHeadings = Array.from(document.querySelectorAll("h3")).map(
      (heading) => heading.textContent,
    );
    expect(cardHeadings).toEqual([
      "Invite someone to exchange data",
      "Accept an invitation you were sent",
    ]);

    // The in-browser processing assurance is a preserved invariant of the
    // redesign; assert the exact copy so a rewording is a deliberate act.
    await expect
      .element(
        page.getByText(
          "Your file is processed entirely in your browser and it is never uploaded to our server.",
        ),
      )
      .toBeInTheDocument();

    const setUpLink = Array.from(document.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "Create an invitation",
    );
    expect(setUpLink?.getAttribute("href")).toBe("/exchange");

    await expect
      .element(page.getByLabelText("Invitation link or code"))
      .toBeInTheDocument();

    // Verifying a receipt is a secondary action below the two cards, not a
    // third card of equal billing.
    await expect
      .element(page.getByRole("link", { name: "Verify a receipt" }))
      .toBeInTheDocument();
  });

  test("applies the bench surface tokens", async () => {
    mount(createElement(BenchLobby));

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toBeInTheDocument();

    const surface = document.querySelector(`.${styles.page}`);
    expect(surface).not.toBeNull();
    // Light-scheme --bench-surface (#f6f5f1): the warm paper ground. Proves
    // tokens.css is wired through the module, not just present on disk.
    expect(getComputedStyle(surface as Element).backgroundColor).toBe(
      "rgb(246, 245, 241)",
    );
  });

  test("the sample-data line and the verify link both sit at the small-print size", async () => {
    mount(createElement(BenchLobby));

    const demoLink = page.getByRole("button", {
      name: "Start with sample data",
    });
    await expect.element(demoLink).toBeInTheDocument();
    const verifyLink = page.getByRole("link", { name: "Verify a receipt" });
    await expect.element(verifyLink).toBeInTheDocument();

    // Each link's enclosing small-print paragraph, and the link itself, share
    // one font size: the `inherit` fix keeps the Anchor from rendering larger.
    const demoElement = demoLink.element() as HTMLElement;
    const verifyElement = verifyLink.element() as HTMLElement;
    const paragraphSize = (element: HTMLElement) =>
      getComputedStyle(element.closest("p") as Element).fontSize;
    const linkSize = (element: HTMLElement) =>
      getComputedStyle(element).fontSize;

    expect(paragraphSize(demoElement)).toBe("14px");
    expect(linkSize(demoElement)).toBe(paragraphSize(demoElement));
    expect(paragraphSize(verifyElement)).toBe("14px");
    expect(linkSize(verifyElement)).toBe(paragraphSize(verifyElement));
  });
});

describe("inviter bench", () => {
  test("renders the empty spine: landmarks, placeholder ledger, quiet facts", async () => {
    mount(createElement(InviterBench));

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your file");

    expect(document.querySelectorAll("main").length).toBe(1);

    const nav = document.querySelector('nav[aria-label="Exchange setup"]');
    expect(nav).not.toBeNull();

    // The step indicators share the button's text content, so the current
    // step's identity is read off its label node.
    const currentSteps = Array.from(
      (nav as Element).querySelectorAll(
        '[aria-current="step"] .mantine-Stepper-stepLabel',
      ),
    );
    expect(currentSteps.map((step) => step.textContent)).toEqual(["Your file"]);

    const ledger = document.querySelector('aside[aria-label="This exchange"]');
    expect(ledger).not.toBeNull();

    // The ledger hosts the Customize group pre-create; with no file yet each
    // fact renders the em-dash quiet value on a not-yet-reachable row.
    expect((ledger as Element).textContent).toContain("Customize");
    const facts = Array.from(
      (ledger as Element).querySelectorAll(`.${styles.val}`),
    );
    expect(facts.map((fact) => fact.textContent)).toEqual([
      EM_DASH,
      EM_DASH,
      EM_DASH,
    ]);

    const rowLabels = Array.from(
      (ledger as Element).querySelectorAll("dt"),
    ).map((label) => label.childNodes[0].textContent);
    expect(rowLabels).toEqual([
      "You will send",
      "You will receive",
      "Matched on",
      "Expires",
      "Results go to",
      "Agreement",
      "How it runs",
    ]);

    // Every undecided ledger value is the muted em-dash mark.
    const values = Array.from((ledger as Element).querySelectorAll("dd")).map(
      (value) => value.textContent,
    );
    expect(values).toEqual(Array.from({ length: 7 }, () => EM_DASH));
  });

  test("derives terms on read and tracks step-2 edits in the ledger", async () => {
    mount(createElement(InviterBench));

    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");

    const fileInput = document.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
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

    // The file card and the default-terms callout appear on read, and the
    // ledger fills in while still on step 1: derivation happens at read time.
    await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
    await expect
      .element(page.getByText("Using defaults", { exact: false }))
      .toBeInTheDocument();

    const ledger = () =>
      document.querySelector('aside[aria-label="This exchange"]') as Element;
    const ledgerRow = (label: string) =>
      Array.from(ledger().querySelectorAll(`.${styles.ledgerRow}`)).find(
        (row) => row.querySelector("dt")?.childNodes[0].textContent === label,
      );
    expect(ledgerRow("You will send")?.querySelector("dd")?.textContent).toBe(
      "program_code",
    );
    expect(ledgerRow("Expires")?.querySelector("dd")?.textContent).toBe(
      "1 hour after you share",
    );

    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Matching & sharing");

    // Undiscloses the only sent column: the ledger and the empty-state inset
    // track the edit.
    await page
      .getByLabelText("How program_code is used")
      .selectOptions("ignored");
    await expect
      .element(page.getByText("Nothing - matching only"))
      .toBeInTheDocument();
    // The debounced disclosure summary voices the new (empty) send set.
    await expect
      .element(page.getByText("No columns will be sent to your partner."))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("No values will be sent to your partner", {
          exact: false,
        }),
      )
      .toBeInTheDocument();

    // Retyping the ignored column to the record identifier displaces the inferred
    // one; the displacement is announced.
    await page
      .getByLabelText("Type for program_code")
      .selectOptions("identifier");
    await expect
      .element(
        page.getByText(
          "client_id changed to Ignored - only one column can be the record identifier.",
        ),
      )
      .toBeInTheDocument();

    // The layout holds at 400px: no horizontal document overflow.
    await page.viewport(400, 800);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(400);
  });

  test("surfaces a two-identifier file in the rail's Problems block", async () => {
    mount(createElement(InviterBench));

    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText("Your name"), "Dana");

    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(
        ["id,identifier,first_name,last_name,dob\n1,2,Ann,Lee,01/02/1990\n"],
        "twoids.csv",
        { type: "text/csv" },
      ),
    );
    await expect.element(page.getByText("twoids.csv")).toBeInTheDocument();

    // The inferred two-identifier conflict is a rail problem from the moment
    // the file is read, and its entry navigates into step 2 to fix it.
    await page
      .getByRole("button", { name: "Choose a single record identifier" })
      .click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Matching & sharing");

    // The conflict's audible half: announced even though the seed mounted
    // already in conflict.
    await expect
      .element(page.getByText("Problem: choose a single record identifier."))
      .toBeInTheDocument();

    await page
      .getByLabelText("How identifier is used")
      .selectOptions("ignored");
    await expect
      .element(page.getByLabelText("How identifier is used"))
      .toHaveValue("ignored");
    expect(document.querySelector('section[aria-label="Problems"]')).toBeNull();
  });

  test("review restates the proposal, gates on problems, and create seals", async () => {
    mount(createElement(InviterBench));

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

    // The check-your-answers table restates the proposal, and all three
    // transports (browser plus the two command-line transports) are now
    // selectable -- no disabled cards, no roadmap tags.
    await expect
      .element(page.getByText("clients.csv - 2 rows"))
      .toBeInTheDocument();
    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    );
    expect(radios).toHaveLength(3);
    expect(radios[0].checked).toBe(true);
    expect(radios.every((radio) => !radio.disabled)).toBe(true);
    expect(document.querySelectorAll(`.${styles.tagRoadmap}`)).toHaveLength(0);
    // The channel-capability rule stays on the chooser fine print.
    await expect
      .element(
        page.getByText(
          "This browser runs live exchanges only; SFTP and shared-directory",
          { exact: false },
        ),
      )
      .toBeInTheDocument();

    // An incoherent direction (payload to a partner receiving no results)
    // surfaces in the work column's Problems block and refuses to arm the
    // create button.
    await page
      .getByLabelText("Who receives the matched results")
      .selectOptions("inviter");
    await expect
      .element(page.getByText("Resolve the problem above to continue."))
      .toBeInTheDocument();
    expect(
      document.querySelector('section[aria-label="Problems"]'),
    ).not.toBeNull();
    const createButton = page.getByRole("button", {
      name: "Create the invitation",
    });
    await expect.element(createButton).toBeDisabled();

    await page
      .getByLabelText("Who receives the matched results")
      .selectOptions("both");
    await expect
      .element(page.getByText("Ready to create."))
      .toBeInTheDocument();

    // Create mints the real invitation and seals the terms: the rail becomes
    // the protocol timeline (no step links back into editing) and the
    // ledger's expiry turns absolute.
    await createButton.click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your invitation is ready");

    const nav = document.querySelector('nav[aria-label="Exchange progress"]');
    expect(nav).not.toBeNull();
    const current = (nav as Element).querySelector(
      '[aria-current="step"] .mantine-Stepper-stepLabel',
    );
    expect(current?.textContent).toBe("Share");
    // No step links back into editing: every step button is out of tab order.
    expect(
      (nav as Element).querySelectorAll('button[tabindex="0"]'),
    ).toHaveLength(0);

    // Sealed terms: the ledger's Customize group is gone post-create.
    const ledger = document.querySelector('aside[aria-label="This exchange"]');
    expect((ledger as Element).textContent).not.toContain("Customize");
    const expiresRow = Array.from(
      (ledger as Element).querySelectorAll(`.${styles.ledgerRow}`),
    ).find(
      (row) => row.querySelector("dt")?.childNodes[0].textContent === "Expires",
    );
    expect(expiresRow?.querySelector("dd")?.textContent).not.toBe(
      "1 hour after you share",
    );
    expect(expiresRow?.querySelector("dd")?.textContent).toMatch(/20\d\d/);
  });

  test("a silent-empty cleaning field surfaces from anywhere on the bench", async () => {
    mount(createElement(InviterBench));

    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText("Your name"), "Dana");
    const fileInput = document.querySelector('input[type="file"]');
    // The dob column cannot parse as a date, so the date_of_birth pipeline
    // produces no value in any row -- a silent-empty collapse -- while the name
    // fields cover fully, so the file is still linkable.
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(
        [
          "first_name,last_name,dob\n" +
            "Ann,Lee,NOTADATE\nBo,Ray,ALSONOTADATE\n",
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

    // The ledger's Customize Cleaning row is a button whose first span is its
    // label and whose fact span carries the amber attention class when failing.
    const cleaningCustomizeRow = () =>
      Array.from(
        document.querySelectorAll(
          `aside[aria-label="This exchange"] .${styles.customizeRow}`,
        ),
      ).find((row) => row.querySelector("span")?.textContent === "Cleaning");

    // The coverage sweep is debounced (AGGREGATE_DEBOUNCE_MS), so poll until it
    // settles: the Customize Cleaning fact turns amber and names the failing count.
    await vi.waitFor(() => {
      expect(
        cleaningCustomizeRow()?.querySelector(`.${styles.valAttention}`)
          ?.textContent,
      ).toBe("1 field failing");
    });

    // The work column's Problems block names the field (its safe type label) and
    // Create refuses to arm while it is open.
    const problems = document.querySelector('section[aria-label="Problems"]');
    expect(problems?.textContent).toContain(
      'Cleaning: "Date of birth" produces no value in any row',
    );
    await expect
      .element(page.getByText("Resolve the problem above to continue."))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeDisabled();

    // The Problems entry links into the Cleaning tab, where the per-field alarm
    // and the polite coverage announcement surface the same collapse.
    await page
      .getByRole("button", {
        name: 'Cleaning: "Date of birth" produces no value in any row',
      })
      .click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Cleaning");
    await vi.waitFor(() => {
      expect(
        document.querySelector('[data-testid="coverage-silent-empty"]'),
      ).not.toBeNull();
    });
    expect(
      document.querySelector('[role="status"][aria-live="polite"]')
        ?.textContent,
    ).toContain("Coverage warning: Date of birth");
  });

  test("browser Back walks bench steps in place, preserving the file and terms", async () => {
    mount(createElement(InviterBench));

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

    // Walk two steps forward: Your file -> Matching & sharing -> Review &
    // create. Each Continue pushes a history entry.
    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    // On step 2, undisclose the sent column so there is an in-progress edit to
    // pin as surviving the Back.
    await page
      .getByLabelText("How program_code is used")
      .selectOptions("ignored");
    await page
      .getByRole("button", { name: "Continue to review & create" })
      .click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Review & create");

    // Browser Back moves to the previous bench step in place -- the bench never
    // unmounts, so the file and the step-2 edit are intact.
    window.history.back();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Matching & sharing");
    await expect
      .element(page.getByLabelText("How program_code is used"))
      .toHaveValue("ignored");

    // Back again lands on step 1 with the loaded file still shown -- not a
    // remount to an empty Your file step.
    window.history.back();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your file");
    await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
    expect(document.querySelector(`.${styles.fileCard}`)).not.toBeNull();
    await expect
      .element(page.getByLabelText("Your name"))
      .toHaveValue("Dana Okafor");

    // Forward reverses the same transition: back to Matching & sharing with the
    // edit still present.
    window.history.forward();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Matching & sharing");
    await expect
      .element(page.getByLabelText("How program_code is used"))
      .toHaveValue("ignored");
  });

  test("navigation never writes the file to storage or disk", async () => {
    // The participant CSV is deliberately memory-only; walking the bench steps
    // (including the History-integrated Back) must not spill it to IndexedDB,
    // localStorage, or a network write. Assert the runtime invariant rather
    // than trust a comment.
    const SENTINEL = "Quillfeatherxyz";
    const fileText =
      "client_id,first_name,last_name,dob,program_code\n" +
      `1,Zephyrine,${SENTINEL},01/02/1990,A\n`;
    const localWrites: Array<string> = [];
    const sessionWrites: Array<string> = [];
    const originalLocalSet = Storage.prototype.setItem;
    const indexedDbOpen = indexedDB.open.bind(indexedDB);
    let indexedDbOpened = 0;
    Storage.prototype.setItem = function setItem(
      this: Storage,
      key: string,
      value: string,
    ) {
      (this === window.localStorage ? localWrites : sessionWrites).push(value);
      return originalLocalSet.call(this, key, value);
    };
    indexedDB.open = (...args: Parameters<typeof indexedDbOpen>) => {
      indexedDbOpened += 1;
      return indexedDbOpen(...args);
    };
    try {
      mount(createElement(InviterBench));
      await expect
        .element(page.getByLabelText("Your name"))
        .toBeInTheDocument();
      await userEvent.fill(page.getByLabelText("Your name"), "Dana");
      const fileInput = document.querySelector('input[type="file"]');
      await userEvent.upload(
        page.elementLocator(fileInput as HTMLElement),
        new File([fileText], "clients.csv", { type: "text/csv" }),
      );
      await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
      await page
        .getByRole("button", { name: "Continue to matching & sharing" })
        .click();
      window.history.back();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Your file");

      // No storage write anywhere carries the file's contents (a unique cell
      // value stands in for the CSV bytes), and the file's rows never reach
      // IndexedDB (no database was even opened).
      const carries = (value: string) =>
        value.includes(SENTINEL) || value.includes(fileText);
      expect(localWrites.some(carries)).toBe(false);
      expect(sessionWrites.some(carries)).toBe(false);
      expect(indexedDbOpened).toBe(0);
      // The bench pushes only its own marked step entries; none carries the
      // file's contents into the serialized history state.
      expect(JSON.stringify(window.history.state ?? {})).not.toContain(
        SENTINEL,
      );
    } finally {
      Storage.prototype.setItem = originalLocalSet;
      indexedDB.open = indexedDbOpen;
    }
  });

  test("a history entry naming no live section is ignored, not rendered blank", async () => {
    mount(createElement(InviterBench));

    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText("Your name"), "Dana");
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(["first_name,last_name,dob\nAnn,Lee,01/02/1990\n"], "a.csv", {
        type: "text/csv",
      }),
    );
    await expect.element(page.getByText("a.csv")).toBeInTheDocument();
    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Matching & sharing");

    // A popstate into a bench entry whose step no build knows (a tab surviving
    // a deploy that renamed a section) must not clear the work column: the
    // restore is refused and the current section keeps rendering.
    window.dispatchEvent(
      new PopStateEvent("popstate", {
        state: { [BENCH_STEP_STATE_KEY]: "retired-section" },
      }),
    );
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Matching & sharing");
    // The section's own controls keep rendering with their edited state intact.
    await expect
      .element(page.getByLabelText("How first_name is used"))
      .toBeInTheDocument();
  });

  test("Back after a start-over lands on review, not a blank share column", async () => {
    // Reaching the share screen pushes a `share` history entry; start-over then
    // clears the invitation the share work column reads and routes to a fresh
    // review. The `share` entry is now backed by nothing -- pressing Back must
    // not restore a blank share column.
    await createSealedInvitation();
    lifecycleCall(0).onError({
      category: "security",
      error: new Error("kex failed"),
    });
    await page
      .getByRole("button", { name: "Start over with a fresh invitation" })
      .click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Review & create");

    // Back lands on the clamped review, not the dead `share` entry: the heading
    // is Review & create and the share surface never appears.
    window.history.back();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Review & create");
    expect(page.getByText("Share this invitation").query()).toBeNull();
    await expect
      .element(page.getByText("Ready to create."))
      .toBeInTheDocument();
    // The entry was rewritten to review, so Forward then Back does not resurrect
    // the dead share entry either.
    window.history.forward();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Review & create");
    window.history.back();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Review & create");
    expect(page.getByText("Share this invitation").query()).toBeNull();
  });

  test("the unload prompt arms with the file and disarms once the invitation exists", async () => {
    // A cancelable beforeunload dispatched at the window is answered by the
    // same listener the browser consults on a real unload; dispatchEvent
    // returning false means the guard called preventDefault (prompt armed).
    const unloadPrompted = () =>
      !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));

    mount(createElement(InviterBench));
    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
    // No file yet: leaving loses nothing, so no prompt.
    expect(unloadPrompted()).toBe(false);

    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(
        [
          "client_id,first_name,last_name,dob,program_code\n" +
            "1,Ann,Lee,01/02/1990,A\n",
        ],
        "clients.csv",
        { type: "text/csv" },
      ),
    );
    await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
    // A file is loaded and nothing is created yet: leaving would lose it. The
    // guard's listener attaches in a passive effect, so poll past the commit
    // the file-card locator resolved on.
    await vi.waitFor(() => expect(unloadPrompted()).toBe(true));

    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    await page
      .getByRole("button", { name: "Continue to review & create" })
      .click();
    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your invitation is ready");
    // The invitation is minted: leaving costs nothing unsecured, so the
    // prompt disarms (again polled past the commit, for the detach effect).
    await vi.waitFor(() => expect(unloadPrompted()).toBe(false));
  });

  test("the sample-data entry shows only until a file is read, then disappears", async () => {
    mount(createElement(InviterBench));

    // On the empty step 1 the under-dropzone entry is present.
    const sampleEntry = page.getByRole("button", {
      name: "load it into this exchange",
    });
    await expect.element(sampleEntry).toBeInTheDocument();

    // Reading any file removes it -- it is a no-file-state affordance only.
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(["first_name,last_name,dob\nAnn,Lee,01/02/1990\n"], "mine.csv", {
        type: "text/csv",
      }),
    );
    await expect.element(page.getByText("mine.csv")).toBeInTheDocument();
    expect(sampleEntry.query()).toBeNull();
  });

  test("?demo=1 seeds the sample, strips the param, and walks through to a real mint", async () => {
    const before = window.location.href;
    window.history.replaceState(window.history.state, "", "/exchange?demo=1");
    try {
      mount(createElement(InviterBench));

      // The seed lands on step 1 with the sample file read, the sample name
      // filled, and the default-terms callout showing -- Continue is enabled.
      await expect
        .element(page.getByText("psilink-sample-inviter.csv"))
        .toBeInTheDocument();
      await expect
        .element(page.getByLabelText("Your name"))
        .toHaveValue("Sample County Health Dept");
      await expect
        .element(page.getByText("Using defaults", { exact: false }))
        .toBeInTheDocument();
      await expect
        .element(
          page.getByRole("button", { name: "Continue to matching & sharing" }),
        )
        .toBeEnabled();

      // The demo param is stripped without adding a history entry (replaceState).
      expect(window.location.search).toBe("");

      // The visitor drives the real spine by hand from the seeded step 1 through
      // to minting a real invitation -- no demo branch on the mint path.
      await page
        .getByRole("button", { name: "Continue to matching & sharing" })
        .click();
      await page
        .getByRole("button", { name: "Continue to review & create" })
        .click();
      await page.getByRole("button", { name: "Create the invitation" }).click();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Your invitation is ready");
      await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(1));

      // Post-mint the synthetic-data reminder persists (the live invitation
      // was minted from sample records), but the one-click Clear is withheld
      // once the terms seal: tearing down a listening run is startOver's
      // deliberate path.
      const ledger = document.querySelector(
        'aside[aria-label="This exchange"]',
      ) as Element;
      expect(ledger.textContent).toContain("Sample data (synthetic records)");
      expect(page.getByRole("button", { name: "Clear" }).query()).toBeNull();
    } finally {
      window.history.replaceState(window.history.state, "", before);
    }
  });

  test("the sample indicator persists across steps and Clear resets to a fresh exchange", async () => {
    const before = window.location.href;
    window.history.replaceState(window.history.state, "", "/exchange?demo=1");
    try {
      mount(createElement(InviterBench));
      await expect
        .element(page.getByText("psilink-sample-inviter.csv"))
        .toBeInTheDocument();

      const ledger = () =>
        document.querySelector('aside[aria-label="This exchange"]') as Element;
      expect(ledger().textContent).toContain("Sample data (synthetic records)");

      // The indicator rides along as the visitor advances steps.
      await page
        .getByRole("button", { name: "Continue to matching & sharing" })
        .click();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Matching & sharing");
      expect(ledger().textContent).toContain("Sample data (synthetic records)");

      // Clear resets to a fresh step 1: no file read, the sample name gone, the
      // indicator gone.
      await page.getByRole("button", { name: "Clear" }).click();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Your file");
      expect(page.getByText("psilink-sample-inviter.csv").query()).toBeNull();
      await expect.element(page.getByLabelText("Your name")).toHaveValue("");
      expect(ledger().textContent).not.toContain(
        "Sample data (synthetic records)",
      );
      // The sample-data entry is offered again on the fresh step 1.
      await expect
        .element(
          page.getByRole("button", {
            name: "load it into this exchange",
          }),
        )
        .toBeInTheDocument();
    } finally {
      window.history.replaceState(window.history.state, "", before);
    }
  });

  test("the guard stays disarmed for the sample (pristine and edited) and re-arms on a real swap", async () => {
    const unloadPrompted = () =>
      !window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    const before = window.location.href;
    window.history.replaceState(window.history.state, "", "/exchange?demo=1");
    try {
      mount(createElement(InviterBench));
      await expect
        .element(page.getByText("psilink-sample-inviter.csv"))
        .toBeInTheDocument();

      // The sample is loaded but nothing regrets losing it: the guard never arms
      // (the listener attaches in a passive effect, so give it a beat first).
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unloadPrompted()).toBe(false);

      // Editing the sample's terms (undisclose the sent identifier on step 2)
      // does not arm it -- it is still the sample.
      await page
        .getByRole("button", { name: "Continue to matching & sharing" })
        .click();
      await page
        .getByLabelText("How member_id is used")
        .selectOptions("ignored");
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(unloadPrompted()).toBe(false);

      // Swapping in a real file re-arms the guard: there is now unsaved work.
      window.history.back();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Your file");
      const fileInput = document.querySelector('input[type="file"]');
      await userEvent.upload(
        page.elementLocator(fileInput as HTMLElement),
        new File(
          ["first_name,last_name,dob\nAnn,Lee,01/02/1990\n"],
          "mine.csv",
          { type: "text/csv" },
        ),
      );
      await expect.element(page.getByText("mine.csv")).toBeInTheDocument();
      await vi.waitFor(() => expect(unloadPrompted()).toBe(true));
    } finally {
      window.history.replaceState(window.history.state, "", before);
    }
  });

  test("customize tabs: reorder keys, author an agreement, gated settings stay inert", async () => {
    mount(createElement(InviterBench));

    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText("Your name"), "Dana");
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(
        [
          "client_id,first_name,last_name,dob,program_code\n" +
            "1,Ann,Lee,01/02/1990,A\n",
        ],
        "clients.csv",
        { type: "text/csv" },
      ),
    );
    await expect.element(page.getByText("clients.csv")).toBeInTheDocument();

    const ledgerRow = (label: string) =>
      Array.from(
        document.querySelectorAll(
          `aside[aria-label="This exchange"] .${styles.ledgerRow}`,
        ),
      ).find(
        (row) => row.querySelector("dt")?.childNodes[0].textContent === label,
      );

    // The ledger's Customize rows are plain buttons once the file is read;
    // the open tab's row carries aria-current="true" (spine steps use
    // "step"), and each row's accessible name carries its quiet fact.
    await page.getByRole("button", { name: /Matching on/ }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Matching keys");
    expect(
      document.querySelector(
        `aside[aria-label="This exchange"] button[aria-current="true"]`,
      )?.textContent,
    ).toContain("Matching on");

    // Reordering the guided list reorders the ledger's matched-on keys.
    const orderBefore = ledgerRow("Matched on")?.querySelector("dd")
      ?.textContent as string;
    await page
      .getByRole("button", { name: /^Move .+ later$/ })
      .first()
      .click();
    const orderAfter = ledgerRow("Matched on")?.querySelector("dd")
      ?.textContent as string;
    expect(orderAfter).not.toBe(orderBefore);

    // Selecting single-pass flows through the schema-parse guard and
    // surfaces the disclosure warning at the point of choice.
    await page.getByLabelText("Single-pass").click();
    await expect
      .element(page.getByText("Single-pass widens what one of you can observe"))
      .toBeInTheDocument();

    // The gated method and deduplication controls are visible but inert.
    await expect.element(page.getByLabelText("Matching method")).toBeDisabled();
    await expect
      .element(
        page.getByLabelText(
          "Allow several of your records to match one partner record",
        ),
      )
      .toBeDisabled();

    // The agreement authored in its tab reaches the ledger and the review
    // table.
    await page.getByRole("button", { name: /Legal agreement/ }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Legal agreement");
    await page.getByLabelText("Attach a legal agreement").click();
    await userEvent.fill(
      page.getByLabelText("Agreement reference"),
      "MOU-2025-0042",
    );
    await userEvent.fill(
      page.getByLabelText("Purpose of the disclosure"),
      "Program evaluation",
    );
    await userEvent.fill(page.getByLabelText("Expiration date"), "2099-12-31");
    expect(ledgerRow("Agreement")?.querySelector("dd")?.textContent).toBe(
      "MOU-2025-0042",
    );

    // The ported input contracts survive the bench: the expiry is a real
    // date input and the reference keeps its length bound.
    const expiration = document.querySelector('input[type="date"]');
    expect(expiration).not.toBeNull();
    const reference = document.querySelector(
      'input[placeholder="MOU-2025-0042"]',
    );
    expect(reference?.getAttribute("maxlength")).toBe("256");

    await page.getByRole("button", { name: /Back to Review & create/ }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Review & create");

    await expect
      .element(page.getByText("Ready to create."))
      .toBeInTheDocument();
    const agreementRow = Array.from(document.querySelectorAll("th")).find(
      (heading) => heading.textContent === "Legal agreement",
    )?.parentElement;
    expect(agreementRow?.textContent).toContain("MOU-2025-0042");

    // Reset discards the authored terms and announces it politely.
    await page.getByRole("button", { name: "Reset to defaults" }).click();
    await expect
      .element(page.getByText("Reset to the default settings."))
      .toBeInTheDocument();
    expect(
      Array.from(document.querySelectorAll("th")).find(
        (heading) => heading.textContent === "Legal agreement",
      )?.parentElement?.textContent,
    ).toContain("None");
  });

  test("intake surfaces rejections and gates on an in-flight parse", async () => {
    mount(createElement(InviterBench));

    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText("Your name"), "Dana");
    const fileInput = () =>
      document.querySelector('input[type="file"]') as HTMLElement;

    // A refused drop names its reason instead of flashing an icon.
    await userEvent.upload(
      page.elementLocator(fileInput()),
      new File(["x"], "image.png", { type: "image/png" }),
    );
    await expect
      .element(page.getByText("not a supported file type", { exact: false }))
      .toBeInTheDocument();

    // While a parse is in flight Continue stays gated and the read carries an
    // abort signal; unmounting aborts it so the worker tears down.
    csvLoadHarness.defer = true;
    await userEvent.upload(
      page.elementLocator(fileInput()),
      new File(["first_name,last_name,dob\nAnn,Lee,01/02/1990\n"], "a.csv", {
        type: "text/csv",
      }),
    );
    await expect
      .element(
        page.getByRole("button", { name: "Continue to matching & sharing" }),
      )
      .toBeDisabled();
    const signal = csvLoadHarness.lastSignal;
    expect(signal).toBeDefined();
    expect((signal as AbortSignal).aborted).toBe(false);

    root?.unmount();
    root = undefined;
    expect((signal as AbortSignal).aborted).toBe(true);
  });

  test("a failed mint leaves the terms editable and create retryable", async () => {
    mount(createElement(InviterBench));

    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText("Your name"), "Dana");
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      new File(
        ["first_name,last_name,dob\nAnn,Lee,01/02/1990\n"],
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

    // An internal mint failure shows the fixed message (no internals echoed
    // into a secret-bearing flow) and seals nothing: the spine rail survives,
    // so every term is still editable.
    mintHarness.fail = new Error("internal mint failure");
    const createButton = page.getByRole("button", {
      name: "Create the invitation",
    });
    await createButton.click();
    await expect
      .element(page.getByText("Could not create the invitation"))
      .toBeInTheDocument();
    expect(
      document.querySelector('nav[aria-label="Exchange setup"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('nav[aria-label="Exchange progress"]'),
    ).toBeNull();

    // A mint-time file error surfaces the shared user-actionable alert.
    mintHarness.fail = new InvitationFileError({
      kind: "unreadable",
      cause: new Error("gone"),
    });
    await createButton.click();
    await expect
      .element(page.getByText("Could not read your file"))
      .toBeInTheDocument();

    // Clearing the failure retries cleanly: the terms were never sealed.
    mintHarness.fail = undefined;
    await createButton.click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your invitation is ready");
  });

  test("a failed re-read discards the prior file; a good re-read swaps it", async () => {
    mount(createElement(InviterBench));

    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText("Your name"), "Dana");
    const fileInput = () =>
      document.querySelector('input[type="file"]') as HTMLElement;
    const continueButton = page.getByRole("button", {
      name: "Continue to matching & sharing",
    });
    const goodFile = (name: string) =>
      new File(["first_name,last_name,dob\nAnn,Lee,01/02/1990\n"], name, {
        type: "text/csv",
      });

    await userEvent.upload(page.elementLocator(fileInput()), goodFile("a.csv"));
    await expect.element(page.getByText("a.csv")).toBeInTheDocument();
    await expect.element(continueButton).toBeEnabled();

    // A good re-read swaps to the new file.
    await userEvent.upload(page.elementLocator(fileInput()), goodFile("b.csv"));
    await expect.element(page.getByText("b.csv")).toBeInTheDocument();
    expect(document.querySelector(`.${styles.fileName}`)?.textContent).toBe(
      "b.csv",
    );
    await expect.element(continueButton).toBeEnabled();

    // An unnameable-columns re-read discards the prior read: no file card, no
    // recommended-terms callout, Continue disabled, facts back to quiet.
    await userEvent.upload(
      page.elementLocator(fileInput()),
      new File(["a,,b\n1,2,3\n"], "unnamed.csv", { type: "text/csv" }),
    );
    await expect
      .element(page.getByText("This file has an unnamed column"))
      .toBeInTheDocument();
    expect(document.querySelector(`.${styles.fileCard}`)).toBeNull();
    expect(document.querySelector(`.${styles.callout}`)).toBeNull();
    await expect.element(continueButton).toBeDisabled();
    const facts = Array.from(document.querySelectorAll(`.${styles.val}`));
    expect(facts.map((fact) => fact.textContent)).toEqual([
      EM_DASH,
      EM_DASH,
      EM_DASH,
    ]);

    // Readiness comes back with the next good read.
    await userEvent.upload(page.elementLocator(fileInput()), goodFile("c.csv"));
    await expect.element(page.getByText("c.csv")).toBeInTheDocument();
    await expect.element(continueButton).toBeEnabled();

    // A parse failure discards the prior read the same way.
    csvLoadHarness.fail = new Error("torn mid-read");
    await userEvent.upload(page.elementLocator(fileInput()), goodFile("d.csv"));
    await expect
      .element(page.getByText("The file could not be read"))
      .toBeInTheDocument();
    expect(document.querySelector(`.${styles.fileCard}`)).toBeNull();
    expect(document.querySelector(`.${styles.callout}`)).toBeNull();
    await expect.element(continueButton).toBeDisabled();
  });

  test("post-create: the share screen offers the artifacts while listening", async () => {
    await createSealedInvitation();

    // A browser partner accepts by pasting the whole link, so the share
    // screen offers ONE artifact row -- the link -- and no bare-code row.
    expect(document.querySelectorAll(`.${styles.copyRow}`)).toHaveLength(1);
    await expect
      .element(page.getByRole("button", { name: "Copy invitation link" }))
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "Copy invitation code" }).query(),
    ).toBeNull();

    // The reveal expands in place to a readonly textarea holding the full
    // minted deep link; the toggle keeps focus and reports its state.
    const reveal = page.getByRole("button", { name: "Show full link" });
    await expect.element(reveal).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(`.${styles.revealArea}`)).toBeNull();
    await reveal.click();
    await expect.element(reveal).toHaveAttribute("aria-expanded", "true");
    const revealArea = document.querySelector(
      `.${styles.revealArea}`,
    ) as HTMLTextAreaElement;
    expect(revealArea.readOnly).toBe(true);
    const deepLink = revealArea.value;
    expect(deepLink).toContain("/accept#");

    // The visible preview is the real head/tail slices of the minted value:
    // the origin-and-route head in full, then the fragment's first and last
    // eight characters around an ellipsis.
    const hash = deepLink.indexOf("#");
    const fragment = deepLink.slice(hash + 1);
    expect(fragment.length).toBeGreaterThan(17);
    expect(document.querySelector(`.${styles.copyPreview}`)?.textContent).toBe(
      deepLink.slice(0, hash + 1) +
        fragment.slice(0, 8) +
        "\u2026" +
        fragment.slice(-8),
    );

    // Copying announces through the row's polite status region.
    await page.getByRole("button", { name: "Copy invitation link" }).click();
    await vi.waitFor(() => {
      expect(document.querySelector(`.${styles.copyStatus}`)?.textContent).toBe(
        "Copied to clipboard",
      );
    });

    await expect
      .element(page.getByText("It carries a one-time secret", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("This invitation expires", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Keep this tab open."))
      .toBeInTheDocument();

    // The run started as the responder on the minted secret the moment the
    // invitation existed, and the sealed ledger marks the frozen terms.
    expect(lifecycleHarness.calls).toHaveLength(1);
    const call = lifecycleCall(0);
    expect(call.exchangeRole).toBe("responder");
    expect(call.sharedSecret.length).toBeGreaterThan(0);
    expect(call.expires).toBeDefined();
    expect(call.signal.aborted).toBe(false);
    await expect
      .element(page.getByText("Terms locked when the invitation was created"))
      .toBeInTheDocument();

    // The status panel tracks the lifecycle's stage events; Share stays the
    // timeline's current step while the browser waits for the partner. (The
    // label and its history row repeat the text by design, so the assertion
    // reads the label node.)
    call.onStage("waiting for peer");
    await vi.waitFor(() => {
      expect(document.querySelector(`.${styles.stageLabel}`)?.textContent).toBe(
        "Waiting for your partner",
      );
    });
    const rail = document.querySelector('nav[aria-label="Exchange progress"]');
    expect(
      (rail as Element).querySelector(
        '[aria-current="step"] .mantine-Stepper-stepLabel',
      )?.textContent,
    ).toBe("Share");
  });

  test("post-create: the collapsed share screen never carries the full secret", async () => {
    await createSealedInvitation();

    // Read the full value through the explicit reveal, then collapse again.
    const reveal = page.getByRole("button", { name: "Show full link" });
    await reveal.click();
    const deepLink = (
      document.querySelector(`.${styles.revealArea}`) as HTMLTextAreaElement
    ).value;
    expect(deepLink).toContain("/accept#");
    await reveal.click();
    await expect.element(reveal).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector(`.${styles.revealArea}`)).toBeNull();

    // Collapsed, neither the full link nor its whole fragment exists as text
    // anywhere in the document: the preview must be a real slice, never CSS
    // truncation over the full secret (which select-all and screen readers
    // would still receive).
    const fragment = deepLink.slice(deepLink.indexOf("#") + 1);
    expect(document.body.textContent).not.toContain(deepLink);
    expect(document.body.textContent).not.toContain(fragment);
  });

  test("post-create: the timeline advances with the exchange stages", async () => {
    await createSealedInvitation();
    const call = lifecycleCall(0);
    call.onStages(stagesFor(preparedWith("cascade", 2)));
    call.onStage("waiting for peer");

    // The partner connecting moves the run into the protocol stages: the
    // share block leaves (nothing left to share), the heading changes, and
    // the orphaned focus is recovered onto it.
    call.onStage("confirming protocol");
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange in progress");
    expect(page.getByText("Share this invitation").query()).toBeNull();
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toBe("Exchange in progress");
    });

    const rail = () =>
      document.querySelector('nav[aria-label="Exchange progress"]') as Element;
    const currentStepLabel = () =>
      rail().querySelector('[aria-current="step"] .mantine-Stepper-stepLabel')
        ?.textContent;
    expect(currentStepLabel()).toBe("Confirm protocol");

    // Per-key stages sit under Link keys; the history keeps the completed
    // stages with their times, and the progress bar tracks the position.
    call.onStage("stage 2 / 2");
    await vi.waitFor(() => {
      expect(document.querySelector(`.${styles.stageLabel}`)?.textContent).toBe(
        "Linking key 2 / 2",
      );
    });
    expect(currentStepLabel()).toBe("Link keys");
    await expect
      .element(page.getByText(/Waiting for your partner - done/))
      .toBeInTheDocument();
    expect(
      document
        .querySelector('[role="progressbar"]')
        ?.getAttribute("aria-valuenow"),
    ).toBe("80");
  });

  test("post-create: completion offers the three downloads with caveats", async () => {
    await createSealedInvitation();
    const call = lifecycleCall(0);
    call.onStages(stagesFor(preparedWith("cascade", 2)));
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

    // Three artifacts, three verbs: the result, the shareable record, the
    // private keys -- each caveat on the download row itself.
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
    await expect.element(page.getByText("Keep a record.")).toBeInTheDocument();

    // The timeline finishes whole, and the ledger settles what happened: the
    // invitation is consumed and the receive row reports the actual count.
    const rail = document.querySelector('nav[aria-label="Exchange progress"]');
    expect((rail as Element).querySelector('[aria-current="step"]')).toBeNull();
    const ledger = document.querySelector(
      'aside[aria-label="This exchange"]',
    ) as Element;
    expect(ledger.textContent).toContain("Invitation used");
    expect(ledger.textContent).toContain("1,847 matched rows + shared columns");
    expect(ledger.textContent).toContain("Your file never left this browser.");

    const another = Array.from(document.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "Set up another exchange",
    );
    expect(another?.getAttribute("href")).toBe("/quick");
  });

  test("post-create: a one-sided exchange states the withheld-result caveat", async () => {
    await createSealedInvitation();
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
    // No results download and no count -- the caveat states the terms did
    // this, while the record downloads are still offered.
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
    expect(
      document.querySelector('aside[aria-label="This exchange"]')?.textContent,
    ).toContain("No result table - withheld by the agreed terms");
  });

  test("post-create: a retryable failure offers one more try on the same invitation", async () => {
    await createSealedInvitation();
    lifecycleCall(0).onStage("waiting for peer");
    lifecycleCall(0).onError({
      category: "exchange",
      error: new Error("transport"),
    });

    // The alert takes focus, states the temporary nature, and keeps the copy
    // artifacts on screen: the same link stays valid for another attempt. The
    // listening callout leaves, though -- the lifecycle tore down, so nothing
    // is listening while the alert shows.
    await expect.element(page.getByText("Exchange failed")).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(
        (document.activeElement as HTMLElement | null)?.textContent,
      ).toContain("Exchange failed");
    });
    await expect
      .element(page.getByText("Share this invitation"))
      .toBeInTheDocument();
    expect(page.getByText("Keep this tab open.").query()).toBeNull();

    await page.getByRole("button", { name: "Try again" }).click();
    await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(2));
    expect(lifecycleCall(1).sharedSecret).toBe(lifecycleCall(0).sharedSecret);
    expect(page.getByText("Exchange failed").query()).toBeNull();
    // The retry listens again, so the callout's claim is true once more.
    await expect
      .element(page.getByText("Keep this tab open."))
      .toBeInTheDocument();
    // The clicked Try again unmounted with its alert, orphaning focus onto
    // <body>; the recovery lands it back on the heading.
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toBe(
        "Your invitation is ready",
      );
    });
  });

  test("post-create: an output failure offers no re-run, only a fresh setup", async () => {
    await createSealedInvitation();
    lifecycleCall(0).onStage("waiting for peer");
    lifecycleCall(0).onStage("confirming protocol");
    lifecycleCall(0).onError({
      category: "output",
      error: new Error("blob quota exceeded"),
    });

    // The exchange already succeeded, so the alert must not invite running it
    // again: no Try again, no start-over-and-remint -- only the sanitized
    // detail and the way out to a new exchange.
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
      page
        .getByRole("button", { name: "Start over with a fresh invitation" })
        .query(),
    ).toBeNull();
    const another = Array.from(document.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "Set up another exchange",
    );
    expect(another?.getAttribute("href")).toBe("/quick");
  });

  test("post-create: a config failure surfaces its message and starts over", async () => {
    await createSealedInvitation();
    lifecycleCall(0).onError({
      category: "config",
      error: new Error("standardization output name contradicts the terms"),
    });

    // The prepare-time fault names only local config, so the actionable
    // message is surfaced, and the recovery is the start-over path (a retry
    // would fail identically). Nothing will ever serve the link, so the copy
    // artifacts and the listening callout leave with the failure.
    await expect
      .element(page.getByText("Could not prepare the exchange"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText("standardization output name contradicts the terms"),
      )
      .toBeInTheDocument();
    expect(page.getByText("Share this invitation").query()).toBeNull();
    expect(page.getByText("Keep this tab open.").query()).toBeNull();
    expect(page.getByRole("button", { name: "Try again" }).query()).toBeNull();
    await page
      .getByRole("button", { name: "Start over with a fresh invitation" })
      .click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Review & create");
  });

  test("post-create: an expired invitation names itself, not the partner", async () => {
    await createSealedInvitation();
    lifecycleCall(0).onStage("waiting for peer");
    // The tagged expiry error core's guards raise (the tag marks its message
    // as locally-composed recovery guidance, safe to surface).
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
        page.getByText("expired at 2026-07-08T19:32:00.000Z", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(page.getByRole("button", { name: "Try again" }).query()).toBeNull();
    await expect
      .element(
        page.getByRole("button", {
          name: "Start over with a fresh invitation",
        }),
      )
      .toBeInTheDocument();
  });

  test("post-create: an exchange failure past expiry swaps retry for start-over", async () => {
    await createSealedInvitation();
    lifecycleCall(0).onStage("waiting for peer");

    // Jump past the invitation's 1-hour lifetime (Date only: timers stay real
    // so React scheduling and vi.waitFor's polling keep working), then land a
    // failure that would otherwise be retryable.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 2 * 3600 * 1000);
      lifecycleCall(0).onError({
        category: "exchange",
        error: new Error("transport"),
      });

      await vi.waitFor(() => {
        expect(
          Array.from(document.querySelectorAll("button")).some(
            (button) =>
              button.textContent === "Start over with a fresh invitation",
          ),
        ).toBe(true);
      });
      expect(
        Array.from(document.querySelectorAll("button")).some(
          (button) => button.textContent === "Try again",
        ),
      ).toBe(false);
      // The lapsed link is no longer advertised either.
      expect(
        Array.from(document.querySelectorAll("h2")).some(
          (heading) => heading.textContent === "Share this invitation",
        ),
      ).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test("post-create: a security failure forces a fresh invitation, inputs intact", async () => {
    await createSealedInvitation();
    lifecycleCall(0).onStage("waiting for peer");
    lifecycleCall(0).onError({
      category: "security",
      error: new Error("kex failed"),
    });

    // The copy artifacts leave the screen -- a link that failed
    // authentication must not keep being advertised -- and the alert forbids
    // a retry.
    await expect
      .element(page.getByText("Could not verify your partner"))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Do not retry", { exact: false }))
      .toBeInTheDocument();
    expect(page.getByText("Share this invitation").query()).toBeNull();
    expect(page.getByRole("button", { name: "Try again" }).query()).toBeNull();

    // Start over lifts the seal with every input intact: back on Review &
    // create, the spine rail returns and the authored terms still mint.
    await page
      .getByRole("button", { name: "Start over with a fresh invitation" })
      .click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Review & create");
    expect(
      document.querySelector('nav[aria-label="Exchange setup"]'),
    ).not.toBeNull();
    await expect
      .element(page.getByText("Ready to create."))
      .toBeInTheDocument();
    expect(
      page.getByText("Terms locked when the invitation was created").query(),
    ).toBeNull();
  });

  test("choosing SFTP routes Create to the save surface without listening", async () => {
    await reachReviewCreate();

    // Choosing the SFTP transport reflects in the ledger's How it runs row and
    // the answers table before Create.
    await page
      .getByLabelText("Over SFTP, run by the psilink command-line tool")
      .click();
    const ledger = document.querySelector(
      'aside[aria-label="This exchange"]',
    ) as Element;
    expect(ledger.textContent).toContain("SFTP (command-line tool)");

    // Create seals the terms and routes to the save surface -- no roadmap tag,
    // and the browser NEVER started a run for a command-line transport.
    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Save your exchange file");
    expect(document.querySelectorAll(`.${styles.tagRoadmap}`)).toHaveLength(0);
    expect(lifecycleHarness.calls).toHaveLength(0);
    // The save-flow top bar shows the four-step timeline with Save file
    // current.
    const rail = document.querySelector('nav[aria-label="Exchange progress"]');
    expect(
      (rail as Element).querySelector(
        '[aria-current="step"] .mantine-Stepper-stepLabel',
      )?.textContent,
    ).toBe("Save file");
    // The capability statement is explicit on the surface and in the ledger.
    await expect
      .element(
        page.getByText(
          "This browser does not run SFTP exchanges; this file runs in the",
          { exact: false },
        ),
      )
      .toBeInTheDocument();
    expect(ledger.textContent).toContain(
      "PII for linkage is encrypted locally before leaving your machine. Your partner receives only the fields listed under 'you will send' (step 2 above) and only for clients who are in common.",
    );
  });

  test("saving an SFTP exchange downloads a credential-free file and populates the code", async () => {
    const downloads = captureDownloads();
    try {
      await reachReviewCreate();
      await page
        .getByLabelText("Over SFTP, run by the psilink command-line tool")
        .click();
      await page.getByRole("button", { name: "Create the invitation" }).click();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Save your exchange file");

      // The credential alert describes what the operator actually supplies --
      // an SSH username and an @file key/password reference in the config --
      // not a nonexistent CLI-managed key file.
      await expect
        .element(
          page.getByText(
            "You fill in the SSH username and point the config at your key " +
              "or password (an @file reference) before running",
            { exact: false },
          ),
        )
        .toBeInTheDocument();

      // Save is gated on the required host until it is filled.
      const save = page.getByRole("button", { name: "Save exchange file" });
      await expect.element(save).toBeDisabled();
      await userEvent.fill(
        page.getByLabelText("SFTP server host"),
        "sftp.riverbend.example.gov",
      );
      await userEvent.fill(
        page.getByLabelText("Remote directory"),
        "/exchanges/psilink",
      );
      await expect.element(save).toBeEnabled();
      await save.click();

      // The file card and the invitation-code copy row appear together.
      await expect
        .element(page.getByText("Saved to your downloads"))
        .toBeInTheDocument();
      const fileName = document.querySelector(
        `.${styles.fileName}`,
      )?.textContent;
      expect(fileName).toMatch(/^psilink-exchange-\d{4}-\d{2}-\d{2}\.yaml$/);
      await expect
        .element(page.getByRole("button", { name: "Copy invitation code" }))
        .toBeInTheDocument();
      // The one copyable run command names the JUST-minted file with
      // --config-file (the default `./psilink.yaml` would not match it) and
      // carries the --invitation flag.
      await expect
        .element(
          page.getByText(
            `psilink exchange your-data.csv --config-file ${fileName} ` +
              "--invitation @invitation-code.txt",
          ),
        )
        .toBeInTheDocument();

      // The downloaded YAML names the SFTP host and path and carries NO
      // credential material -- the file locates the rendezvous, never
      // authenticates to it.
      await vi.waitFor(() => {
        const download = downloads.captured.find((entry) =>
          entry.fileName.endsWith(".yaml"),
        );
        expect(download?.text.length).toBeGreaterThan(0);
      });
      const yaml = downloads.captured.find((entry) =>
        entry.fileName.endsWith(".yaml"),
      )?.text as string;
      expect(yaml).toContain("channel: sftp");
      expect(yaml).toContain("sftp.riverbend.example.gov");
      expect(yaml).toContain("/exchanges/psilink");
      expect(yaml).not.toMatch(/password/i);
      expect(yaml).not.toMatch(/private_key/i);
      expect(yaml).not.toMatch(/authentication/i);

      // The minted code re-parses through decodeInvitation with the SAME sftp
      // endpoint the file names -- the code and the config point at one
      // rendezvous. The full code lives behind the reveal, not in the row's
      // preview.
      await page.getByRole("button", { name: "Show full code" }).click();
      const encoded = (
        document.querySelector(`.${styles.revealArea}`) as HTMLTextAreaElement
      ).value;
      const token = await decodeInvitation(encoded);
      const endpoint = token.connectionEndpoint;
      expect(endpoint?.channel).toBe("sftp");
      expect((endpoint as { host?: string }).host).toBe(
        "sftp.riverbend.example.gov",
      );

      // Back to Review & create preserves state (terms stay sealed), and the
      // saved artifacts survive the round trip.
      await page
        .getByRole("button", { name: /Back to Review & create/ })
        .click();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Review & create");
      await expect
        .element(page.getByText("Terms locked when the invitation was created"))
        .toBeInTheDocument();
    } finally {
      downloads.restore();
    }
  });

  test("a shared-directory exchange saves end to end", async () => {
    const downloads = captureDownloads();
    try {
      await reachReviewCreate();
      await page
        .getByLabelText("Over a shared directory, run by the command-line tool")
        .click();
      await page.getByRole("button", { name: "Create the invitation" }).click();
      await expect
        .element(page.getByRole("heading", { level: 1 }))
        .toHaveTextContent("Save your exchange file");
      expect(lifecycleHarness.calls).toHaveLength(0);

      // The filedrop field requires an absolute path.
      const save = page.getByRole("button", { name: "Save exchange file" });
      await userEvent.fill(
        page.getByLabelText("Shared directory"),
        "/exchanges/psilink",
      );
      await expect.element(save).toBeEnabled();
      await save.click();

      await expect
        .element(page.getByText("Saved to your downloads"))
        .toBeInTheDocument();
      await vi.waitFor(() => {
        const download = downloads.captured.find((entry) =>
          entry.fileName.endsWith(".yaml"),
        );
        expect(download?.text.length).toBeGreaterThan(0);
      });
      const yaml = downloads.captured.find((entry) =>
        entry.fileName.endsWith(".yaml"),
      )?.text as string;
      expect(yaml).toContain("channel: filedrop");
      expect(yaml).toContain("/exchanges/psilink");
      expect(yaml).not.toMatch(/password/i);
      expect(yaml).not.toMatch(/authentication/i);

      await page.getByRole("button", { name: "Show full code" }).click();
      const encoded = (
        document.querySelector(`.${styles.revealArea}`) as HTMLTextAreaElement
      ).value;
      const token = await decodeInvitation(encoded);
      expect(token.connectionEndpoint?.channel).toBe("filedrop");
    } finally {
      downloads.restore();
    }
  });

  test("re-saving after an edit re-mints the code and file atomically", async () => {
    const downloads = captureDownloads();
    try {
      await reachReviewCreate();
      await page
        .getByLabelText("Over SFTP, run by the psilink command-line tool")
        .click();
      await page.getByRole("button", { name: "Create the invitation" }).click();
      await userEvent.fill(
        page.getByLabelText("SFTP server host"),
        "first.example.gov",
      );
      await page.getByRole("button", { name: "Save exchange file" }).click();
      await expect
        .element(page.getByText("Saved to your downloads"))
        .toBeInTheDocument();
      await page.getByRole("button", { name: "Show full code" }).click();
      const codeValue = () =>
        document.querySelector<HTMLTextAreaElement>(`.${styles.revealArea}`)
          ?.value;
      const firstCode = codeValue();
      expect(firstCode?.length).toBeGreaterThan(0);

      // Edit the host and save again: the code re-mints, so the old code is
      // gone -- the code and file update together.
      await userEvent.fill(
        page.getByLabelText("SFTP server host"),
        "second.example.gov",
      );
      await page.getByRole("button", { name: "Save exchange file" }).click();
      await vi.waitFor(() => {
        expect(codeValue()).not.toBe(firstCode);
      });
      const secondCode = codeValue() as string;
      const token = await decodeInvitation(secondCode);
      expect(
        (token.connectionEndpoint as { host?: string } | undefined)?.host,
      ).toBe("second.example.gov");
    } finally {
      downloads.restore();
    }
  });
});

describe("bench at a narrow viewport", () => {
  const SAMPLE_CSV = new File(
    [
      "client_id,first_name,last_name,dob,program_code\n" +
        "1,Ann,Lee,01/02/1990,A\n2,Bo,Ray,03/04/1985,B\n",
    ],
    "clients.csv",
    { type: "text/csv" },
  );

  // Mount already narrow so the layout hook renders the small-viewport IA from
  // the first paint, read the sample file so the ledger fills and the Customize
  // surfaces become reachable, then walk to Matching & sharing (spine step 2).
  async function reachMatchingSharingNarrow() {
    await page.viewport(400, 800);
    mount(createElement(InviterBench));
    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    const fileInput = document.querySelector('input[type="file"]');
    await userEvent.upload(
      page.elementLocator(fileInput as HTMLElement),
      SAMPLE_CSV,
    );
    await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Matching & sharing");
  }

  test("the spine compresses to a step strip naming the current position", async () => {
    await reachMatchingSharingNarrow();

    // The setup nav no longer renders the full Mantine Stepper (no step-label
    // nodes, the selector the wide-layout tests read); it carries the one-line
    // step strip naming step 2 of the three-step spine.
    const nav = document.querySelector('nav[aria-label="Exchange setup"]');
    expect(nav).not.toBeNull();
    expect(
      (nav as Element).querySelectorAll(".mantine-Stepper-stepLabel"),
    ).toHaveLength(0);
    expect((nav as Element).textContent).toContain(
      "Step 2 of 3 - Matching & sharing",
    );

    // The decorative "N/M" badge is hidden from assistive tech -- the sentence
    // already carries the position.
    const badge = (nav as Element).querySelector('[aria-hidden="true"]');
    expect(badge?.textContent).toBe("2/3");
  });

  test("the Customize tabs fold behind a disclosure keeping each fact value", async () => {
    await reachMatchingSharingNarrow();

    // The optional surfaces are behind a collapsed "Customize" disclosure, not
    // the standing ledger group.
    const customizeToggle = page.getByRole("button", { name: "Customize" });
    await expect.element(customizeToggle).toBeInTheDocument();
    await expect
      .element(customizeToggle)
      .toHaveAttribute("aria-expanded", "false");

    // The group note and each surface's right-aligned fact are inside it.
    await customizeToggle.click();
    await expect
      .element(customizeToggle)
      .toHaveAttribute("aria-expanded", "true");
    await expect
      .element(page.getByText("Filled in from your file."))
      .toBeInTheDocument();
    const cleaningRow = page.getByRole("button", { name: /Cleaning/ });
    await expect.element(cleaningRow).toBeInTheDocument();
    expect((cleaningRow.element() as HTMLElement).textContent).toMatch(
      /Cleaning.*field/,
    );
    const keysRow = page.getByRole("button", { name: /Matching on/ });
    expect((keysRow.element() as HTMLElement).textContent).toMatch(
      /Matching on.*key/,
    );

    // Opening the disclosure reaches each tab: the matching-keys editor opens
    // its work column.
    await keysRow.click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Matching keys");
  });

  test("the share bar is the first interactive element and collapses", async () => {
    await reachMatchingSharingNarrow();

    // The first focusable control on the page is the share bar's toggle: it
    // sits ahead of every work-column control in DOM order, so tabbing from the
    // document start reaches it first. "Interactive" means tab-reachable
    // (tabIndex >= 0), enabled, and laid out -- excluding, e.g., the hidden
    // tabindex="-1" measurement textarea Mantine's autosize input parks on
    // document.body.
    const focusable = Array.from(
      document.querySelectorAll<HTMLElement>(
        "button, a[href], input, select, textarea, [tabindex]",
      ),
    ).filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.matches(":disabled") &&
        element.offsetParent !== null,
    );
    const shareToggle = page.getByRole("button", {
      name: "What you will share",
    });
    await expect.element(shareToggle).toBeInTheDocument();
    // It is the very first focusable control in the document -- nothing
    // interactive precedes the trust surface at any viewport.
    expect(focusable[0]).toBe(shareToggle.element() as HTMLElement);
    // And it precedes the first work-column control in DOM order.
    const firstWorkControl = document.querySelector<HTMLElement>(
      `main.${styles.work} button, main.${styles.work} select, main.${styles.work} input`,
    );
    expect(firstWorkControl).not.toBeNull();
    expect(
      focusable.indexOf(shareToggle.element() as HTMLElement),
    ).toBeLessThan(focusable.indexOf(firstWorkControl as HTMLElement));

    // Present but collapsed: one tap reveals the condensed subset.
    await expect.element(shareToggle).toHaveAttribute("aria-expanded", "false");
    await shareToggle.click();
    await expect.element(shareToggle).toHaveAttribute("aria-expanded", "true");

    // The share bar shows the condensed three-row subset, not the ledger's full
    // seven rows.
    const shareBar = document.querySelector(`.${styles.shareBar}`) as Element;
    const rows = Array.from(
      shareBar.querySelectorAll(`.${styles.ledgerRow}`),
    ).map((row) => row.querySelector("dt")?.childNodes[0].textContent);
    expect(rows).toEqual(["You will send", "Matched on", "Expires"]);

    // Collapsing again reports the closed state.
    await shareToggle.click();
    await expect.element(shareToggle).toHaveAttribute("aria-expanded", "false");
  });

  test("the narrow layout holds without horizontal overflow", async () => {
    await reachMatchingSharingNarrow();

    // Expanding both disclosures must not push the document past the viewport.
    await page.getByRole("button", { name: "What you will share" }).click();
    await page.getByRole("button", { name: "Customize" }).click();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(400);
  });

  test("a live breakpoint crossing preserves the work column's state", async () => {
    // Mounted wide (the project's default viewport) and sealed, with
    // component-local state armed in the work column: the reveal toggle's
    // open textarea, whose state lives inside the copy row, not the bench.
    await createSealedInvitation();
    const reveal = page.getByRole("button", { name: "Show full link" });
    await reveal.click();
    await expect.element(reveal).toHaveAttribute("aria-expanded", "true");
    const revealArea = document.querySelector(
      `.${styles.revealArea}`,
    ) as HTMLTextAreaElement;
    expect(revealArea).not.toBeNull();
    const deepLink = revealArea.value;

    // Crossing to narrow reorders the regions as a keyed move, not a
    // remount: the reveal stays open, on the very same DOM node, while the
    // ledger folds to the share bar.
    await page.viewport(400, 800);
    await expect
      .element(page.getByRole("button", { name: "What you will share" }))
      .toBeInTheDocument();
    await expect.element(reveal).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(`.${styles.revealArea}`)).toBe(revealArea);
    expect(revealArea.value).toBe(deepLink);

    // And back out to wide: the full ledger aside returns, the reveal still
    // open on the same node.
    await page.viewport(1280, 800);
    await expect
      .element(page.getByRole("heading", { name: "This exchange" }))
      .toBeInTheDocument();
    await expect.element(reveal).toHaveAttribute("aria-expanded", "true");
    expect(document.querySelector(`.${styles.revealArea}`)).toBe(revealArea);
  });
});
