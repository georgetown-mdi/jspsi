/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import { decodeInvitation } from "@psilink/core";

import { InviterBench } from "@bench/InviterBench";
import styles from "@bench/bench.module.css";

import { renderApp } from "./renderApp";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// Stub the router seam the bench components touch (the appShell.test.ts pattern).
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

// This suite exercises the CONSOLE build; the hosted-profile behaviors stay pinned
// by bench.test.ts, which runs on the real default profile.
vi.mock("@utils/clientConfig", () => ({
  deploymentProfile: () => "console" as const,
  isConsoleBuild: () => true,
}));

// Stub the rendezvous module: importing it runs a top-level config load that reads
// `process` (absent in the browser runner). Nothing here drives the browser
// transport (it is disabled on the console), so its functions are never called.
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));

const CLIENTS_FILE = {
  name: "clients.csv",
  sizeBytes: 4096,
  modifiedAt: 1_700_000_000_000,
};

const CLIENTS_PROFILE = {
  ...CLIENTS_FILE,
  rowCount: 2,
  columns: ["client_id", "first_name", "last_name", "dob", "program_code"],
  dateInputFormat: "%m/%d/%Y",
  columnSamples: [
    { column: "client_id", values: ["1", "2"] },
    { column: "first_name", values: ["Ann", "Bo"] },
    { column: "last_name", values: ["Lee", "Ray"] },
    { column: "dob", values: ["01/02/1990", "03/04/1985"] },
    { column: "program_code", values: ["A", "B"] },
  ],
};

interface CapturedRequest {
  url: string;
  method: string;
  body?: string;
}

interface StubOptions {
  listing?: unknown;
  profile?: unknown;
  profileStatus?: number;
  remotes?: unknown;
  rendezvous?: unknown;
  coverageStatus?: number;
}

/** The same-origin job API, stubbed at the global fetch seam. Unmatched URLs fall
 * through to the real fetch so the runner's own traffic is untouched. */
function stubJobApi(options: StubOptions = {}): {
  captured: Array<CapturedRequest>;
  setListing: (listing: unknown) => void;
  setProfile: (profile: unknown) => void;
  emitEvent: (event: object) => void;
  closeEvents: () => void;
} {
  const captured: Array<CapturedRequest> = [];
  const encoder = new TextEncoder();
  let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
  const realFetch = window.fetch.bind(window);
  let listing: unknown = options.listing ?? {
    configured: true,
    files: [CLIENTS_FILE],
  };
  let profile: unknown = options.profile ?? CLIENTS_PROFILE;

  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.startsWith("/api/jobs")) return realFetch(input, init);
      captured.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url === "/api/jobs/inputs")
        return Promise.resolve(jsonResponse(listing));
      if (url.startsWith("/api/jobs/inputs/profile"))
        return Promise.resolve(
          options.profileStatus !== undefined
            ? new Response(null, { status: options.profileStatus })
            : jsonResponse(profile),
        );
      if (url === "/api/jobs/inputs/coverage")
        return Promise.resolve(
          options.coverageStatus !== undefined
            ? new Response(null, { status: options.coverageStatus })
            : jsonResponse({ rates: [] }),
        );
      if (url === "/api/jobs/remotes")
        return Promise.resolve(jsonResponse(options.remotes ?? []));
      if (url === "/api/jobs/rendezvous")
        return Promise.resolve(
          jsonResponse(options.rendezvous ?? { configured: false }),
        );
      if (url === "/api/jobs")
        return Promise.resolve(jsonResponse({ id: "job-7" }, 201));
      if (url === "/api/jobs/job-7/events")
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                sse = controller;
              },
            }),
            { status: 200, headers: { "Content-Type": "text/event-stream" } },
          ),
        );
      if (url === "/api/jobs/job-7")
        return Promise.resolve(jsonResponse({ recordAvailable: false }));
      if (url === "/api/jobs/job-7/cancel")
        return Promise.resolve(new Response(null, { status: 200 }));
      return Promise.resolve(new Response(null, { status: 404 }));
    },
  );

  return {
    captured,
    setListing: (next) => {
      listing = next;
    },
    setProfile: (next) => {
      profile = next;
    },
    emitEvent: (event) =>
      sse?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    closeEvents: () => sse?.close(),
  };
}

let container: HTMLElement | undefined;
let root: Root | undefined;

function mount(content: ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(renderApp(content));
}

afterEach(async () => {
  // Let any in-flight fetch resolution and its state update flush before the
  // synchronous unmount, so teardown never races a render (which corrupts React's
  // scheduler for the rest of the file). The picker and coverage seams are
  // fetch-driven, so a resolution can otherwise land exactly at unmount.
  await new Promise((resolve) => setTimeout(resolve, 0));
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
});

/** From an already-mounted bench: fill the name, pick and confirm a file from the
 * mounted directory (the two-stage commit), then walk to Review & create. */
async function reachReviewCreate() {
  await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
  await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
  await page.getByRole("button", { name: "Select clients.csv" }).click();
  await page.getByRole("button", { name: "Use this file" }).click();
  await expect
    .element(
      page.getByRole("button", { name: "Continue to matching & sharing" }),
    )
    .toBeEnabled();
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

describe("console inviter file picker states", () => {
  test("an empty listing shows the no-usable-files state", async () => {
    stubJobApi({ listing: { configured: true, files: [] } });
    mount(createElement(InviterBench));
    await expect
      .element(
        page.getByText("No usable files in the work directory", {
          exact: true,
        }),
      )
      .toBeInTheDocument();
  });

  test("an unconfigured work directory names the env var to set", async () => {
    stubJobApi({ listing: { configured: false, files: [] } });
    mount(createElement(InviterBench));
    // An unset JOB_INPUT_DIR is a deployment-config gap, distinct from an
    // empty-but-mounted directory: name the env var, do not tell the operator to
    // place a file in a directory that is not configured.
    await expect
      .element(page.getByText("No work directory configured", { exact: true }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("Set JOB_INPUT_DIR", { exact: false }))
      .toBeInTheDocument();
    expect(
      page
        .getByText("No usable files in the work directory", { exact: true })
        .query(),
    ).toBeNull();
  });

  test("a populated listing shows the file rows", async () => {
    stubJobApi({ listing: { configured: true, files: [CLIENTS_FILE] } });
    mount(createElement(InviterBench));
    await expect.element(page.getByText("clients.csv")).toBeInTheDocument();
  });
});

describe("console inviter two-stage pick", () => {
  test("selecting a file shows a pre-commit confirm panel with columns, rows, and samples", async () => {
    stubJobApi();
    mount(createElement(InviterBench));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await page.getByRole("button", { name: "Select clients.csv" }).click();

    // The confirm panel appears BEFORE the file becomes the bench's acquired file.
    await expect
      .element(page.getByText("Confirm this file"))
      .toBeInTheDocument();
    // The per-column sample peek shows the profiled sample values (the dob sample
    // appears only here).
    await expect.element(page.getByText("Sample values")).toBeInTheDocument();
    await expect
      .element(page.getByText("01/02/1990", { exact: false }))
      .toBeInTheDocument();

    // Committing seeds the bench: the row is marked Selected and Continue enables.
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect.element(page.getByText("Selected")).toBeInTheDocument();
    await expect
      .element(
        page.getByRole("button", { name: "Continue to matching & sharing" }),
      )
      .toBeEnabled();
  });
});

describe("console inviter transports and sample data", () => {
  test("the Browser card is disabled and the sample seed is hidden", async () => {
    stubJobApi();
    mount(createElement(InviterBench));
    // The in-place sample seed is gone; the download stays.
    await expect
      .element(page.getByRole("button", { name: "download the CSVs" }))
      .toBeInTheDocument();
    expect(
      page.getByRole("button", { name: "load it into this exchange" }).query(),
    ).toBeNull();

    await reachReviewCreate();
    const browser = page.getByLabelText("Live, in this browser");
    await expect.element(browser).toBeDisabled();
    // The disabled card names its in-tab exchange as out of scope on the appliance
    // (this phrasing is unique to the Browser card's description).
    await expect
      .element(page.getByText("the public psilink web app's domain"))
      .toBeInTheDocument();
  });

  test("with provisioned remotes the default transport is SFTP (run here)", async () => {
    stubJobApi({ remotes: [{ name: "prod_east", host: "sftp.example.gov" }] });
    mount(createElement(InviterBench));
    await reachReviewCreate();
    // SFTP is selected by default and shows the run-here copy plus the picker.
    await expect
      .element(page.getByLabelText("Over SFTP, run here"))
      .toBeChecked();
    await expect
      .element(page.getByLabelText("SFTP server"))
      .toBeInTheDocument();
  });

  test("with a rendezvous mount and no remotes the filedrop card runs here by default", async () => {
    stubJobApi({
      remotes: [],
      rendezvous: { configured: true, path: "/mnt/rendezvous" },
    });
    mount(createElement(InviterBench));
    await reachReviewCreate();
    await expect
      .element(page.getByLabelText("Over a shared directory, run here"))
      .toBeChecked();
  });

  test("with no rendezvous mount the filedrop card is disabled", async () => {
    stubJobApi({ remotes: [], rendezvous: { configured: false } });
    mount(createElement(InviterBench));
    await reachReviewCreate();
    await expect
      .element(
        page.getByLabelText(
          "Over a shared directory, run by the command-line tool",
        ),
      )
      .toBeDisabled();
  });
});

describe("console inviter mint and run", () => {
  test("seeds from the profile and runs a job whose intent carries inputFile, not inputCsv", async () => {
    const api = stubJobApi({
      remotes: [
        {
          name: "dr_west",
          host: "dr.example.gov",
          port: 2222,
          path: "/drops/psilink",
        },
      ],
    });
    mount(createElement(InviterBench));
    await reachReviewCreate();

    // The ledger/answers seeded from the profile: the file and its row count.
    await expect
      .element(page.getByText("clients.csv - 2 rows"))
      .toBeInTheDocument();

    // SFTP is the default; create routes to the live run (share screen).
    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your invitation is ready");

    // A server-job run: the keep-open callout names the appliance running the exchange
    // and that leaving abandons it, never a browser listener. The whole sentence is
    // asserted -- a substring would also pass a false "closing stops the run" claim.
    await expect
      .element(
        page.getByText(
          "This appliance is running the exchange. If you leave this page, " +
            "the console cannot return to the run or its results.",
        ),
      )
      .toBeInTheDocument();
    expect(
      page.getByText("Your browser is listening for your partner").query(),
    ).toBeNull();

    // The minted code carries the picked remote's locator, never inline content.
    await page.getByRole("button", { name: "Show full code" }).click();
    const encoded = (
      document.querySelector(`.${styles.revealArea}`) as HTMLTextAreaElement
    ).value;
    const token = await decodeInvitation(encoded);
    expect(token.connectionEndpoint).toEqual({
      channel: "sftp",
      host: "dr.example.gov",
      port: 2222,
      path: "/drops/psilink",
    });

    // The run POSTs an intent carrying the mounted-file REFERENCE, not the content.
    await vi.waitFor(() => {
      expect(
        api.captured.some(
          (request) => request.url === "/api/jobs" && request.method === "POST",
        ),
      ).toBe(true);
    });
    const post = api.captured.find(
      (request) => request.url === "/api/jobs" && request.method === "POST",
    );
    const intent = JSON.parse(post?.body ?? "{}") as Record<string, unknown>;
    expect(intent.channel).toBe("sftp");
    expect(intent.remote).toBe("dr_west");
    expect(intent.inputCsv).toBeUndefined();
    expect(intent.inputFile).toEqual({ name: "clients.csv" });

    await vi.waitFor(() =>
      expect(
        api.captured.some(
          (request) => request.url === "/api/jobs/job-7/events",
        ),
      ).toBe(true),
    );
    // A relay warning (the host-key divergence notice the security review requires
    // the operator to see) surfaces in the run UI without ending the run.
    api.emitEvent({
      v: 1,
      type: "warning",
      message: "the two parties pinned different host keys for this server",
    });
    await expect
      .element(page.getByText("The exchange reported a warning"))
      .toBeInTheDocument();

    // The result completes the run on the appliance's endpoint.
    api.emitEvent({ v: 1, type: "result", resultWritten: true });
    api.closeEvents();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange complete");
  });

  test("a filedrop invitation carries only the rendezvous folder name, not its absolute path", async () => {
    stubJobApi({
      remotes: [],
      rendezvous: { configured: true, path: "/srv/exchanges/psilink" },
    });
    mount(createElement(InviterBench));
    await reachReviewCreate();
    // Filedrop is the default (a rendezvous mount, no remotes) and runs here.
    await expect
      .element(page.getByLabelText("Over a shared directory, run here"))
      .toBeChecked();

    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your invitation is ready");

    await page.getByRole("button", { name: "Show full code" }).click();
    const encoded = (
      document.querySelector(`.${styles.revealArea}`) as HTMLTextAreaElement
    ).value;
    const token = await decodeInvitation(encoded);
    // The partner-bound token discloses only the shared folder's name (the basename),
    // never the appliance's resolved absolute path.
    expect(token.connectionEndpoint).toEqual({
      channel: "filedrop",
      path: "psilink",
    });
  });

  test("the coverage sweep posts the mounted-file name only", async () => {
    const api = stubJobApi();
    mount(createElement(InviterBench));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect.element(page.getByText("Selected")).toBeInTheDocument();

    // The bench's coverage provider posts to the appliance sweep with the file's
    // name (the CLI reads it in place; no freshness pair, no inline content).
    await vi.waitFor(() => {
      expect(
        api.captured.some(
          (request) =>
            request.url === "/api/jobs/inputs/coverage" &&
            request.method === "POST",
        ),
      ).toBe(true);
    });
    const post = api.captured.find(
      (request) => request.url === "/api/jobs/inputs/coverage",
    );
    const body = JSON.parse(post?.body ?? "{}") as Record<string, unknown>;
    expect(body.name).toBe("clients.csv");
    expect(body.sizeBytes).toBeUndefined();
    expect(body.modifiedAt).toBeUndefined();
  });
});

describe("console inviter picker accessibility", () => {
  test("the picker stages are real h2 headings", async () => {
    stubJobApi();
    mount(createElement(InviterBench));
    await expect
      .element(
        page.getByRole("heading", {
          level: 2,
          name: "Choose a file from the work directory",
        }),
      )
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await expect
      .element(
        page.getByRole("heading", { level: 2, name: "Confirm this file" }),
      )
      .toBeInTheDocument();
  });

  test("a polite status region announces the loaded listing", async () => {
    stubJobApi();
    mount(createElement(InviterBench));
    await vi.waitFor(() => {
      const status = document.querySelector(
        '[role="status"][aria-live="polite"]',
      );
      expect(status?.textContent).toContain("Loaded 1 file");
    });
  });

  test("selecting a file moves focus to the confirm stage", async () => {
    stubJobApi();
    mount(createElement(InviterBench));
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    // The stage swap sends focus to the confirm panel so a screen-reader user is not
    // stranded on the row button that just unmounted.
    await vi.waitFor(() => {
      expect(document.activeElement?.textContent).toContain(
        "Confirm this file",
      );
    });
  });

  test("each row's Select button names its file so the names do not collide", async () => {
    stubJobApi({
      listing: {
        configured: true,
        totalEntries: 2,
        truncated: false,
        files: [
          CLIENTS_FILE,
          {
            name: "roster.csv",
            sizeBytes: 8192,
            modifiedAt: 1_700_000_500_000,
          },
        ],
      },
    });
    mount(createElement(InviterBench));
    await expect
      .element(page.getByRole("button", { name: "Select clients.csv" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: "Select roster.csv" }))
      .toBeInTheDocument();
  });
});

describe("console inviter picker re-profile", () => {
  test("re-profiling with unchanged columns keeps the draft; changed columns reset it", async () => {
    const api = stubJobApi();
    mount(createElement(InviterBench));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect.element(page.getByText("Selected")).toBeInTheDocument();

    // Re-profile the same file with the same columns: the draft is preserved.
    await page.getByRole("button", { name: "Re-profile clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect
      .element(
        page.getByText("your customizations are unchanged", { exact: false }),
      )
      .toBeInTheDocument();

    // The file's columns change under the same name: reseeded, with an explicit
    // notice that the customizations were reset.
    api.setProfile({
      ...CLIENTS_PROFILE,
      columns: ["client_id", "email"],
      columnSamples: [
        { column: "client_id", values: ["1", "2"] },
        { column: "email", values: ["a@x.gov", "b@x.gov"] },
      ],
    });
    await page.getByRole("button", { name: "Re-profile clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect
      .element(
        page.getByText("your customizations were reset", { exact: false }),
      )
      .toBeInTheDocument();
  });

  test("a profile with a blank header cell is refused without unmounting the bench", async () => {
    stubJobApi({
      profile: {
        ...CLIENTS_PROFILE,
        columns: ["client_id", "", "dob"],
        columnSamples: [
          { column: "client_id", values: ["1", "2"] },
          { column: "", values: ["x", "y"] },
          { column: "dob", values: ["01/02/1990", "03/04/1985"] },
        ],
      },
    });
    mount(createElement(InviterBench));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await page.getByRole("button", { name: "Select clients.csv" }).click();
    await page.getByRole("button", { name: "Use this file" }).click();
    // The shared unnameable-column alert, not a bench crash from core's throwing
    // inferMetadata: the name field is still on screen.
    await expect
      .element(page.getByText("This file has an unnamed column"))
      .toBeInTheDocument();
    await expect.element(page.getByLabelText("Your name")).toBeInTheDocument();
  });
});

describe("console inviter sample-data copy", () => {
  test("links the deployment guide instead of promising a walkthrough", async () => {
    stubJobApi();
    mount(createElement(InviterBench));
    const link = page.getByRole("link", { name: "deployment guide" });
    await expect.element(link).toBeInTheDocument();
    await expect
      .element(link)
      .toHaveAttribute(
        "href",
        "https://github.com/georgetown-mdi/jspsi/blob/main/docs/DEPLOYMENT.md",
      );
  });
});
