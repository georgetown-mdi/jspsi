/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { getDefaultLinkageTerms } from "@psilink/core";

import {
  NO_CONFIGURATION_IN_FOLDER,
  OPEN_CONFIGURATION_LABEL,
} from "@console/mountedConfiguration";
import { InviterScreen } from "@exchange/InviterScreen";

import { createAppMount } from "./renderApp";

// The load offer as the operator meets it on the file step: the three states the
// console's own route puts it in, and the notices beside an opened
// configuration. What each state SAYS is pinned in
// test/unit/console/mountedConfiguration.test.ts; this pins that the control
// reaches the step, reads the route, and renders the state it answered with.
//
// Each state's heading is in the DOM twice by design -- once in the polite live
// region, once in the visible alert -- so the assertions take the first match
// rather than asserting a single element.

vi.mock("@tanstack/react-router", async () =>
  (await import("./moduleMocks")).reactRouterMock(),
);

vi.mock("@utils/clientConfig", () => ({
  deploymentProfile: () => "console" as const,
  isConsoleBuild: () => true,
  psilinkVersion: () => undefined,
}));

vi.mock("@psi/transport/rendezvous", async () =>
  (await import("./moduleMocks")).rendezvousMock(),
);

const CONFIG_DOCUMENT = {
  channel: "sftp",
  server: { host: "sftp.partner.example", username: "county" },
  linkageTerms: getDefaultLinkageTerms("County Health"),
};

/** Answer the console's job API, with `GET /api/jobs/config` under this test's
 * control and every other route answering as an unprovisioned console does. */
function stubConfigRoute(answer: { status: number; body: unknown }): void {
  const realFetch = window.fetch.bind(window);
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.startsWith("/api/jobs")) return realFetch(input, init);
      const json = (body: unknown, status = 200) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { "Content-Type": "application/json" },
          }),
        );
      if (url === "/api/jobs/config") return json(answer.body, answer.status);
      if (url === "/api/jobs/inputs")
        return json({ configured: true, files: [] });
      return json({ configured: false });
    },
  );
}

const app = createAppMount();

afterEach(() => {
  app.unmount();
  vi.unstubAllGlobals();
});

describe("the load offer on the file step", () => {
  test("a mount holding no configuration says so and keeps authoring here", async () => {
    stubConfigRoute({
      status: 200,
      body: {
        configured: true,
        present: false,
        carriedThrough: [],
        warnings: [],
      },
    });
    app.render(createElement(InviterScreen));
    await page.getByRole("button", { name: OPEN_CONFIGURATION_LABEL }).click();
    await expect
      .element(page.getByText(NO_CONFIGURATION_IN_FOLDER).first())
      .toBeInTheDocument();
  });

  test("an opened configuration reports both notices by setting name", async () => {
    stubConfigRoute({
      status: 200,
      body: {
        configured: true,
        present: true,
        document: CONFIG_DOCUMENT,
        carriedThrough: ["signing.receipt_output"],
        warnings: ["connection.server.password"],
      },
    });
    app.render(createElement(InviterScreen));
    await page.getByRole("button", { name: OPEN_CONFIGURATION_LABEL }).click();
    await expect
      .element(page.getByText("Configuration opened").first())
      .toBeInTheDocument();
    await expect
      .element(page.getByText(/signing\.receipt_output/))
      .toBeInTheDocument();
    await expect
      .element(page.getByText(/connection\.server\.password/))
      .toBeInTheDocument();
  });

  test("a channel this console cannot run is named beside the control", async () => {
    stubConfigRoute({
      status: 200,
      body: {
        configured: true,
        present: true,
        document: {
          channel: "filedrop",
          linkageTerms: CONFIG_DOCUMENT.linkageTerms,
        },
        carriedThrough: [],
        warnings: [],
      },
    });
    app.render(createElement(InviterScreen));
    await page.getByRole("button", { name: OPEN_CONFIGURATION_LABEL }).click();
    await expect
      .element(page.getByText(/no shared folder mounted/))
      .toBeInTheDocument();
  });

  test("a refusal shows the console's own text and offers no partial form", async () => {
    const error =
      "This configuration runs over webrtc. The console conducts sftp and " +
      "shared-folder exchanges only, so it cannot open this one.";
    stubConfigRoute({ status: 400, body: { error } });
    app.render(createElement(InviterScreen));
    await page.getByRole("button", { name: OPEN_CONFIGURATION_LABEL }).click();
    await expect
      .element(page.getByText("This configuration cannot be opened").first())
      .toBeInTheDocument();
    await expect.element(page.getByText(error).first()).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Configuration opened");
  });
});
