/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

// Load Mantine's stylesheet so components render with their real
// geometry: without it the Stepper's completed-step icon has no size
// bound and blankets the top bar, intercepting unrelated clicks.
import "@mantine/core/styles.css";

import { decodeInvitation } from "@psilink/core";

import { InviterBench } from "@bench/InviterBench";
import styles from "@bench/bench.module.css";

import { renderApp } from "./renderApp";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

// Stub the router seam the bench components touch (the appShell.test.ts /
// bench.test.ts pattern); this suite asserts the console sftp flow, not
// navigation.
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

// This suite exercises the CONSOLE build's sftp routing; the hosted-profile
// behaviors (sftp always saves a file) stay pinned by bench.test.ts, which
// runs on the real default profile.
vi.mock("@utils/clientConfig", () => ({
  deploymentProfile: () => "console" as const,
  isConsoleBuild: () => true,
}));

// Stub the rendezvous module: importing it runs a top-level config load that
// reads `process` (absent in the browser runner). Nothing here drives the
// browser transport, so its functions are never called.
vi.mock("@psi/rendezvous", () => ({
  dialAsAcceptor: vi.fn(),
  listenAsInviter: vi.fn(),
}));

interface CapturedRequest {
  url: string;
  method: string;
  body?: string;
}

/** The same-origin job API, stubbed at the global fetch seam the remotes
 * helper and the driver's default client both ride. Unmatched URLs fall
 * through to the real fetch so the runner's own traffic is untouched. */
function stubJobApi(options: { remotes: unknown; remotesStatus?: number }): {
  captured: Array<CapturedRequest>;
  emitEvent: (event: object) => void;
  closeEvents: () => void;
} {
  const captured: Array<CapturedRequest> = [];
  const encoder = new TextEncoder();
  let sse: ReadableStreamDefaultController<Uint8Array> | undefined;
  const realFetch = window.fetch.bind(window);

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
      if (url === "/api/jobs/remotes")
        return Promise.resolve(
          jsonResponse(options.remotes, options.remotesStatus ?? 200),
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
            {
              status: 200,
              headers: { "Content-Type": "text/event-stream" },
            },
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

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  vi.unstubAllGlobals();
});

// Walk the spine to Review & create: name, file, straight through, ready to
// choose a transport (the bench.test.ts helper, minus its hosted-profile
// assertions).
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

describe("console inviter bench, sftp channel", () => {
  test("provisioned remotes: picker instead of free text, endpoint from the picked remote, server-job run with warnings surfaced", async () => {
    const api = stubJobApi({
      remotes: [
        { name: "prod_east", host: "sftp.example.gov" },
        {
          name: "dr_west",
          host: "dr.example.gov",
          port: 2222,
          path: "/drops/psilink",
        },
      ],
    });
    await reachReviewCreate();

    // Picking the sftp channel fetches the remotes; the card flips to the
    // run-here copy and the picker appears -- no free-text host authoring.
    await page
      .getByLabelText("Over SFTP, run by the psilink command-line tool")
      .click();
    const picker = page.getByLabelText("SFTP server");
    await expect.element(picker).toBeInTheDocument();
    await expect.element(picker).toHaveValue("prod_east");
    await expect
      .element(page.getByLabelText("Over SFTP, run here"))
      .toBeInTheDocument();
    // The options name each remote with its full locator, so the operator
    // recognizes the destination. (The lifetime/direction selects render
    // first, so find the picker by its current value.)
    const pickerSelect = Array.from(
      document.querySelectorAll<HTMLSelectElement>("select"),
    ).find((select) => select.value === "prod_east");
    expect(
      Array.from((pickerSelect as HTMLSelectElement).options).map(
        (option) => option.label,
      ),
    ).toEqual([
      "prod_east - sftp.example.gov",
      "dr_west - dr.example.gov:2222 /drops/psilink",
    ]);

    // Pick the SECOND remote, so the assertions below can only pass off the
    // chosen remote, never a first-entry default.
    await picker.selectOptions("dr_west");

    // Create mints and routes to the live run -- the share screen, not the
    // save surface.
    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Your invitation is ready");

    // The CLI-accept share screen keeps the bare-code row (the partner's CLI
    // takes the code alone); the minted code carries the picked remote's
    // locator as its sftp endpoint -- the partner's CLI meets the appliance
    // where it will actually connect -- and never the remote's
    // appliance-local name. The full code lives behind the row's reveal.
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
    expect(encoded).not.toContain("dr_west");

    // The run POSTed the sftp intent naming ONLY the remote: no host, port,
    // path, or any other connection field rides the intent.
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
    expect(intent.eventStream).toBe(true);
    expect(intent.host).toBeUndefined();
    expect(intent.port).toBeUndefined();
    expect(intent.path).toBeUndefined();

    // The driver opens the SSE stream in a separate fetch after the POST
    // resolves; wait for that request before emitting, or the event enqueues
    // into a stream the driver has not yet subscribed to and is dropped.
    await vi.waitFor(() =>
      expect(
        api.captured.some(
          (request) => request.url === "/api/jobs/job-7/events",
        ),
      ).toBe(true),
    );
    // A relay warning (the host-key divergence notice the security review
    // requires the operator to see) surfaces in the run UI without ending
    // the run.
    api.emitEvent({
      v: 1,
      type: "warning",
      message: "the two parties pinned different host keys for this server",
    });
    await expect
      .element(page.getByText("The exchange reported a warning"))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(
          "the two parties pinned different host keys for this server",
        ),
      )
      .toBeInTheDocument();

    // The result completes the run on the appliance's download endpoint, and
    // the warning STAYS up -- completion must not scroll it away.
    api.emitEvent({ v: 1, type: "result", resultWritten: true });
    api.closeEvents();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Exchange complete");
    await expect
      .element(page.getByText("The exchange reported a warning"))
      .toBeInTheDocument();
    const resultLink = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("a[download]"),
    ).find((link) => link.textContent === "results.csv");
    expect(resultLink?.getAttribute("href")).toBe("/api/jobs/job-7/result");
  });

  test("no provisioned remotes: the save-a-file flow is untouched", async () => {
    const api = stubJobApi({ remotes: [] });
    await reachReviewCreate();

    await page
      .getByLabelText("Over SFTP, run by the psilink command-line tool")
      .click();
    // The remotes fetch resolves empty: no picker, the card keeps the
    // command-line copy, and Create routes to the save surface with the
    // free-text authoring intact.
    await vi.waitFor(() => {
      expect(
        api.captured.some((request) => request.url === "/api/jobs/remotes"),
      ).toBe(true);
    });
    expect(
      page.getByLabelText("SFTP server", { exact: true }).query(),
    ).toBeNull();

    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Save your exchange file");
    await expect
      .element(page.getByLabelText("SFTP server host"))
      .toBeInTheDocument();
    // Nothing armed a server-side run.
    expect(api.captured.some((request) => request.url === "/api/jobs")).toBe(
      false,
    );
  });

  test("a failed remotes fetch falls back to the save-a-file flow", async () => {
    const api = stubJobApi({ remotes: [], remotesStatus: 500 });
    await reachReviewCreate();

    await page
      .getByLabelText("Over SFTP, run by the psilink command-line tool")
      .click();
    await vi.waitFor(() => {
      expect(
        api.captured.some((request) => request.url === "/api/jobs/remotes"),
      ).toBe(true);
    });
    await page.getByRole("button", { name: "Create the invitation" }).click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toHaveTextContent("Save your exchange file");
    await expect
      .element(page.getByLabelText("SFTP server host"))
      .toBeInTheDocument();
    expect(api.captured.some((request) => request.url === "/api/jobs")).toBe(
      false,
    );
  });
});
