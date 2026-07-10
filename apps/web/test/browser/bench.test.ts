/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import { AcceptUnderConstruction } from "@bench/placeholders";
import { BenchLobby } from "@bench/BenchLobby";
import { InvitationFileError } from "@psi/invitation";
import { InviterBench } from "@bench/InviterBench";
import { stagesFor } from "@bench/exchangeRun";
import styles from "@bench/bench.module.css";

import type { PreparedExchange } from "@psilink/core";
import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// Stub the router seam the bench components touch (the lobby's and the
// placeholders' Links). This suite asserts the bench's structure, landmarks,
// and tokens, not navigation -- the appShell.test.ts pattern. vitest hoists
// the mock above the imports, so the components pick up the stub.
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

afterEach(() => {
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

describe("bench lobby", () => {
  test("renders the landing structure with one main and one h1", async () => {
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
      "Set up an exchange",
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
      (anchor) => anchor.textContent === "Set up an exchange",
    );
    expect(setUpLink?.getAttribute("href")).toBe("/bench/exchange");

    await expect
      .element(page.getByLabelText("Invitation link or code"))
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
});

describe("inviter bench", () => {
  test("renders the empty spine: landmarks, placeholder ledger, quiet facts", async () => {
    mount(createElement(InviterBench));

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your file");

    expect(document.querySelectorAll("main").length).toBe(1);

    const rail = document.querySelector('nav[aria-label="Exchange setup"]');
    expect(rail).not.toBeNull();

    const currentSteps = Array.from(
      (rail as Element).querySelectorAll('[aria-current="step"]'),
    );
    expect(currentSteps.map((step) => step.textContent)).toEqual(["Your file"]);

    // Customize facts with no file yet render the em-dash quiet fact.
    const facts = Array.from(
      (rail as Element).querySelectorAll(`.${styles.val}`),
    );
    expect(facts.map((fact) => fact.textContent)).toEqual([
      EM_DASH,
      EM_DASH,
      EM_DASH,
    ]);

    const ledger = document.querySelector('aside[aria-label="This exchange"]');
    expect(ledger).not.toBeNull();

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
      "Transport",
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

    // The file card and the recommended-terms callout appear on read, and the
    // ledger fills in while still on step 1: derivation happens at read time.
    await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
    await expect
      .element(page.getByText("Recommended terms are ready", { exact: false }))
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

    // Retyping the ignored column to the row identifier displaces the inferred
    // one; the displacement is announced.
    await page
      .getByLabelText("Type for program_code")
      .selectOptions("identifier");
    await expect
      .element(
        page.getByText(
          "client_id changed to Ignored - only one column can be the row identifier.",
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
      .getByRole("button", { name: "Choose a single row identifier" })
      .click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Matching & sharing");

    // The conflict's audible half: announced even though the seed mounted
    // already in conflict.
    await expect
      .element(page.getByText("Problem: choose a single row identifier."))
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

    // The check-your-answers table restates the proposal, and the CLI
    // transports are present but disabled with the roadmap tag.
    await expect
      .element(page.getByText("clients.csv - 2 rows"))
      .toBeInTheDocument();
    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    );
    expect(radios).toHaveLength(3);
    expect(radios[0].checked).toBe(true);
    expect(radios[0].disabled).toBe(false);
    expect(radios[1].disabled).toBe(true);
    expect(radios[2].disabled).toBe(true);
    expect(document.querySelectorAll(`.${styles.tagRoadmap}`)).toHaveLength(2);

    // An incoherent direction (payload to a partner receiving no results)
    // surfaces in the rail and refuses to arm the create button.
    await page
      .getByLabelText("Who receives the matched results")
      .selectOptions("inviter");
    await expect
      .element(page.getByText("Resolve the problem in the rail to continue."))
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

    const rail = document.querySelector('nav[aria-label="Exchange progress"]');
    expect(rail).not.toBeNull();
    const current = (rail as Element).querySelector('[aria-current="step"]');
    expect(current?.textContent).toBe("Share");
    expect((rail as Element).querySelectorAll("button")).toHaveLength(0);

    const ledger = document.querySelector('aside[aria-label="This exchange"]');
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

    // The rail's Customize facts are links once the file is read; the open
    // tab carries aria-current="true" (spine steps use "step").
    await page.getByRole("button", { name: "Matching keys" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Matching keys");
    expect(document.querySelector('[aria-current="true"]')?.textContent).toBe(
      "Matching keys",
    );

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
    await page.getByRole("button", { name: "Legal agreement" }).click();
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
    await page.getByRole("button", { name: "Reset to recommended" }).click();
    await expect
      .element(page.getByText("Reset to the recommended settings."))
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
    const facts = Array.from(
      document.querySelectorAll(
        `nav[aria-label="Exchange setup"] .${styles.val}`,
      ),
    );
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

    // Both copy artifacts render, the link wrapping the code's token, each
    // with its copy action; the one-time-secret guidance and the expiry sit
    // on the thing being shared.
    const codeBlocks = Array.from(
      document.querySelectorAll(`.${styles.codeBlock}`),
    ).map((block) => block.textContent);
    expect(codeBlocks).toHaveLength(2);
    expect(codeBlocks[0]).toContain("/accept#");
    expect(codeBlocks[1].length).toBeGreaterThan(0);
    expect(codeBlocks[0]).toContain(codeBlocks[1]);
    await expect
      .element(page.getByRole("button", { name: "Copy invitation link" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Copy invitation code" }))
      .toBeInTheDocument();
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
      .element(page.getByText("Terms sealed at create"))
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
      (rail as Element).querySelector('[aria-current="step"]')?.textContent,
    ).toBe("Share");
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
    expect(rail().querySelector('[aria-current="step"]')?.textContent).toBe(
      "Confirm protocol",
    );

    // Per-key stages sit under Link keys; the history keeps the completed
    // stages with their times, and the progress bar tracks the position.
    call.onStage("stage 2 / 2");
    await vi.waitFor(() => {
      expect(document.querySelector(`.${styles.stageLabel}`)?.textContent).toBe(
        "Linking key 2 / 2",
      );
    });
    expect(rail().querySelector('[aria-current="step"]')?.textContent).toBe(
      "Link keys",
    );
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
    expect(another?.getAttribute("href")).toBe("/bench");
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
    // artifacts on screen: the same link stays valid for another attempt.
    await expect.element(page.getByText("Exchange failed")).toBeInTheDocument();
    await vi.waitFor(() => {
      expect(
        (document.activeElement as HTMLElement | null)?.textContent,
      ).toContain("Exchange failed");
    });
    await expect
      .element(page.getByText("Share this invitation"))
      .toBeInTheDocument();

    await page.getByRole("button", { name: "Try again" }).click();
    await vi.waitFor(() => expect(lifecycleHarness.calls).toHaveLength(2));
    expect(lifecycleCall(1).sharedSecret).toBe(lifecycleCall(0).sharedSecret);
    expect(page.getByText("Exchange failed").query()).toBeNull();
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
    expect(page.getByText("Terms sealed at create").query()).toBeNull();
  });

  test("collapses to the single-column layout without rail and ledger", async () => {
    mount(createElement(AcceptUnderConstruction));

    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Accept an invitation");

    expect(document.querySelectorAll("main").length).toBe(1);
    expect(document.querySelectorAll("nav").length).toBe(0);
    expect(document.querySelectorAll("aside").length).toBe(0);
    expect(document.querySelector(`.${styles.gridPlain}`)).not.toBeNull();

    const homeLink = Array.from(document.querySelectorAll("a")).find(
      (anchor) => anchor.textContent === "current app",
    );
    expect(homeLink?.getAttribute("href")).toBe("/");
  });
});
