/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement } from "react";

import "@mantine/core/styles.css";

import { getDefaultLinkageTerms } from "@psilink/core";

import {
  CLOSE_CONFIGURATION_LABEL,
  CONFIGURATION_SAVED,
  CONVERT_CONFIGURATION_LABEL,
  EDITED_TERMS_TITLE,
  NO_CONFIGURATION_IN_FOLDER,
  OPENED_EXCHANGE_CONTINUES,
  OPEN_CONFIGURATION_LABEL,
  START_OPENED_EXCHANGE_LABEL,
} from "@console/mountedConfiguration";
import { InviterScreen } from "@exchange/InviterScreen";
import { isolatedColumnName } from "@components/ColumnName";

import { disclosureToggle, openDisclosure } from "./collapsePanels";
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

const CLIENTS_FILE = {
  name: "clients.csv",
  sizeBytes: 4096,
  modifiedAt: 1_700_000_000_000,
};

const CLIENTS_PROFILE = {
  ...CLIENTS_FILE,
  rowCount: 2,
  columns: ["client_id", "first_name", "last_name", "dob", "program_code"],
  sanitizedColumnPositions: [],
  dateInputFormat: "%m/%d/%Y",
  columnSamples: [
    { column: "client_id", values: ["1", "2"] },
    { column: "first_name", values: ["Ann", "Bo"] },
    { column: "last_name", values: ["Lee", "Ray"] },
    { column: "dob", values: ["01/02/1990", "03/04/1985"] },
    { column: "program_code", values: ["A", "B"] },
  ],
};

/** The document's own column set over that file: every column it has, with
 * `program_code` -- the one column inference sends to the partner -- stated as
 * one this party keeps to itself. */
const STATED_COLUMNS = [
  {
    name: "client_id",
    type: "identifier",
    role: "identifier",
    isPayload: false,
  },
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "last_name", type: "last_name", role: "linkage", isPayload: false },
  { name: "dob", type: "date_of_birth", role: "linkage", isPayload: false },
  { name: "program_code", type: "other", role: "ignored", isPayload: false },
];

/** The body `GET /api/jobs/config` answers for an opened configuration. */
function openedBody(document: unknown): unknown {
  return {
    configured: true,
    present: true,
    document,
    carriedThrough: [],
    warnings: [],
    signingPathSettings: [],
    folderPathSettings: [],
  };
}

/** Each body a `PUT /api/jobs/config` sent, in order. */
const savedBodies: Array<unknown> = [];

/** Each body a `POST /api/jobs` sent, in order. */
const createdBodies: Array<unknown> = [];

/** Answer the console's job API, with `GET /api/jobs/config` under this test's
 * control. The work directory is empty and nothing else is provisioned unless
 * the test says otherwise. */
function stubConfigRoute(
  answer: { status: number; body: unknown },
  mount: { files?: Array<unknown>; sftp?: unknown } = {},
): void {
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
      if (url === "/api/jobs/config" && init?.method === "PUT") {
        savedBodies.push(JSON.parse(String(init.body)) as unknown);
        return json({ written: true });
      }
      if (url === "/api/jobs/config") return json(answer.body, answer.status);
      if (url === "/api/jobs/inputs")
        return json({ configured: true, files: mount.files ?? [] });
      if (url.startsWith("/api/jobs/inputs/profile"))
        return json(CLIENTS_PROFILE);
      if (url === "/api/jobs/inputs/coverage") return json({ rates: [] });
      if (url === "/api/jobs/sftp")
        return json(mount.sftp ?? { configured: false });
      if (url === "/api/jobs") {
        createdBodies.push(JSON.parse(String(init?.body)) as unknown);
        return json({ id: "job-7" }, 201);
      }
      if (url === "/api/jobs/job-7/events")
        return Promise.resolve(
          new Response(new ReadableStream<Uint8Array>(), {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          }),
        );
      if (url === "/api/jobs/job-7")
        return json({ status: "running", recordAvailable: false });
      return json({ configured: false });
    },
  );
}

/** Open the mounted configuration from the file step. */
async function openConfiguration(): Promise<void> {
  await page.getByRole("button", { name: OPEN_CONFIGURATION_LABEL }).click();
  await expect
    .element(page.getByText("Configuration opened").first())
    .toBeInTheDocument();
}

/** Commit the mounted file the console lists, the two-stage pick. */
async function commitFile(): Promise<void> {
  await page.getByRole("button", { name: /clients\.csv/ }).click();
  await page.getByRole("button", { name: "Use this file" }).click();
  await expect.element(page.getByText("Selected")).toBeInTheDocument();
}

const app = createAppMount();

afterEach(() => {
  app.unmount();
  // A server-job run persists a strand-recovery record; clear it so the next
  // test's idle screen does not re-attach to a prior run's id.
  window.localStorage.clear();
  vi.unstubAllGlobals();
  savedBodies.splice(0);
  createdBodies.splice(0);
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
        carriedThrough: ["added_setting"],
        warnings: ["connection.server.password"],
        signingPathSettings: [],
        folderPathSettings: [],
      },
    });
    app.render(createElement(InviterScreen));
    await page.getByRole("button", { name: OPEN_CONFIGURATION_LABEL }).click();
    await expect
      .element(page.getByText("Configuration opened").first())
      .toBeInTheDocument();
    await expect.element(page.getByText(/added_setting/)).toBeInTheDocument();
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
        signingPathSettings: [],
        folderPathSettings: ["connection.path"],
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
      "The psilink.yaml in your working folder is not a psilink exchange " +
      "configuration. Check the file, then open it again.";
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

// The open configuration is an input to the file step for as long as it is open,
// and the draft is derived from it at every commit -- the screen's own effect,
// driven here rather than transcribed by a unit test.
describe("the open configuration over the files it is derived across", () => {
  test("the column it keeps back is kept back again after a void", async () => {
    stubConfigRoute(
      {
        status: 200,
        body: openedBody({ ...CONFIG_DOCUMENT, metadata: STATED_COLUMNS }),
      },
      { files: [CLIENTS_FILE] },
    );
    app.render(createElement(InviterScreen));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await openConfiguration();
    await commitFile();

    // A delimiter change re-reads the file, so the commit made under the old
    // one is voided and the re-profiled file is committed again.
    await userEvent.selectOptions(
      page.getByLabelText("How your file separates fields"),
      "Semicolon",
    );
    await page.getByRole("button", { name: "Use this file" }).click();
    await expect.element(page.getByText("Selected")).toBeInTheDocument();

    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    await expect
      .element(
        page.getByLabelText(
          `How ${isolatedColumnName("program_code")} is used`,
        ),
      )
      .toHaveValue("ignored");
  });

  test("a webrtc configuration opens for review and holds the create", async () => {
    stubConfigRoute(
      {
        status: 200,
        body: openedBody({
          channel: "webrtc",
          linkageTerms: CONFIG_DOCUMENT.linkageTerms,
          metadata: STATED_COLUMNS,
        }),
      },
      {
        files: [CLIENTS_FILE],
        sftp: {
          configured: true,
          host: "sftp.partner.example",
          port: 22,
          path: "/exchange",
        },
      },
    );
    app.render(createElement(InviterScreen));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await openConfiguration();
    await expect
      .element(page.getByText(/runs over webrtc/).first())
      .toBeInTheDocument();
    await commitFile();
    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    await page
      .getByRole("button", { name: "Continue to review & create" })
      .click();
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeDisabled();
    await expect
      .element(page.getByText(/cannot run this webrtc configuration/).first())
      .toBeInTheDocument();
    await expect
      .element(
        page.getByText(/webrtc connection, its tuning and file handling/),
      )
      .toBeInTheDocument();
    await expect
      .element(disclosureToggle(/Connection tuning/))
      .not.toBeInTheDocument();
    await page
      .getByRole("button", { name: "Save changes to psilink.yaml" })
      .click();
    await expect
      .element(page.getByText(CONFIGURATION_SAVED).first())
      .toBeInTheDocument();
    expect(savedBodies).toHaveLength(1);
    expect(savedBodies[0]).toMatchObject({
      linkageTerms: { identity: "County Health" },
      signing: { mode: "none" },
    });
    expect(savedBodies[0]).not.toHaveProperty("connection");

    await openDisclosure(/Receipts and record keeping/);
    await userEvent.fill(
      page.getByLabelText("Retention note for your own record"),
      "Destroyed after 90 days.",
    );
    await expect
      .element(page.getByText(CONFIGURATION_SAVED).first())
      .not.toBeInTheDocument();
  });

  test("a run started while it is open withholds both controls and sends no invitation", async () => {
    stubConfigRoute(
      {
        status: 200,
        body: openedBody({ ...CONFIG_DOCUMENT, metadata: STATED_COLUMNS }),
      },
      {
        files: [CLIENTS_FILE],
        sftp: {
          configured: true,
          host: "sftp.partner.example",
          port: 22,
          path: "/exchange",
        },
      },
    );
    app.render(createElement(InviterScreen));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await openConfiguration();
    await commitFile();
    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    await page
      .getByRole("button", { name: "Continue to review & create" })
      .click();
    await expect
      .element(page.getByText(OPENED_EXCHANGE_CONTINUES).first())
      .toBeInTheDocument();
    await page
      .getByRole("button", { name: START_OPENED_EXCHANGE_LABEL })
      .click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent("Waiting for your partner");
    expect(
      page.getByRole("heading", { name: "Share this invitation" }).query(),
    ).toBeNull();
    await vi.waitFor(() => expect(createdBodies).toHaveLength(1));
    expect(createdBodies[0]).toMatchObject({
      mountedConfigurationOpened: true,
    });
    expect(createdBodies[0]).not.toHaveProperty("sharedSecret");

    // Back to the step the load sits on: the terms it filled are sealed, so
    // neither opening another configuration nor closing this one is offered.
    window.history.back();
    window.history.back();
    window.history.back();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent("Your file");
    expect(
      page.getByRole("button", { name: OPEN_CONFIGURATION_LABEL }).query(),
    ).toBeNull();
    expect(
      page.getByRole("button", { name: CLOSE_CONFIGURATION_LABEL }).query(),
    ).toBeNull();
  });
});

// A signed run of a configuration naming its own signing paths waits for the
// operator to convert it: the review step withholds the start, names the
// settings, and offers the conversion beside it.
describe("an opened configuration's own signing paths on the review step", () => {
  test("withhold a signed run until converted", async () => {
    stubConfigRoute(
      {
        status: 200,
        body: {
          ...(openedBody({
            ...CONFIG_DOCUMENT,
            metadata: STATED_COLUMNS,
            signing: { mode: "certificate" },
          }) as Record<string, unknown>),
          signingPathSettings: ["signing.identity_file"],
        },
      },
      {
        files: [CLIENTS_FILE],
        sftp: {
          configured: true,
          host: "sftp.partner.example",
          port: 22,
          path: "/exchange",
        },
      },
    );
    app.render(createElement(InviterScreen));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await openConfiguration();
    await expect
      .element(page.getByText(/names a path of its own/).first())
      .toBeInTheDocument();
    await commitFile();
    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    await page
      .getByRole("button", { name: "Continue to review & create" })
      .click();
    await expect
      .element(page.getByRole("button", { name: START_OPENED_EXCHANGE_LABEL }))
      .toBeDisabled();
    await expect
      .element(
        page
          .getByText(
            /names a signing path of its own \(signing\.identity_file\)/,
          )
          .first(),
      )
      .toBeInTheDocument();
    await page
      .getByRole("button", { name: CONVERT_CONFIGURATION_LABEL })
      .click();
    await expect
      .element(page.getByText(/names a signing path of its own/).first())
      .not.toBeInTheDocument();
    expect(
      page.getByRole("button", { name: CONVERT_CONFIGURATION_LABEL }).query(),
    ).toBeNull();
  });
});

// The warning about a commitment the run's own columns no longer match names
// the columns step as the way out, so it stands on that step too -- and nothing
// else the load says does: those are about the load itself.
describe("the divergence warning on the step that resolves it", () => {
  /** The document's commitment on a column its own metadata keeps back, so the
   * run discloses nothing and core refuses it. */
  const COMMITTED = {
    ...CONFIG_DOCUMENT,
    metadata: STATED_COLUMNS,
    disclosedPayloadColumns: ["program_code"],
  };

  async function goToColumns(document: unknown): Promise<void> {
    stubConfigRoute(
      { status: 200, body: openedBody(document) },
      { files: [CLIENTS_FILE] },
    );
    app.render(createElement(InviterScreen));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await openConfiguration();
    await commitFile();
    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    await expect
      .element(page.getByRole("heading", { level: 1 }))
      .toMatchTextContent("Matching & sharing");
  }

  test("a diverged commitment is reported where the columns are edited", async () => {
    await goToColumns(COMMITTED);
    await expect
      .element(page.getByText(/a run started here is refused/))
      .toBeInTheDocument();
    // What the load says about itself stays on the file step: the carry-through
    // notice names this same record there and does not follow it here.
    expect(page.getByText(/has no control for/).query()).toBeNull();
  });

  test("a webrtc configuration's diverged commitment names the command line", async () => {
    await goToColumns({ ...COMMITTED, channel: "webrtc" });
    await expect
      .element(
        page.getByText(/psilink on the command line refuses to run the file/),
      )
      .toBeInTheDocument();
    expect(page.getByText(/a run started here is refused/).query()).toBeNull();
  });

  test("a configuration whose commitment holds says nothing here", async () => {
    await goToColumns({ ...CONFIG_DOCUMENT, metadata: STATED_COLUMNS });
    expect(page.getByText(/a run started here is refused/).query()).toBeNull();
  });
});

// The partner holds the terms the opened configuration states, so a change to
// them here is warned of before the run; the run makes no invitation, so the
// review step offers no duration for one.
describe("the review step of an opened configuration's run", () => {
  async function goToReview(stated: object = {}): Promise<void> {
    stubConfigRoute(
      {
        status: 200,
        body: openedBody({
          ...CONFIG_DOCUMENT,
          metadata: STATED_COLUMNS,
          ...stated,
        }),
      },
      {
        files: [CLIENTS_FILE],
        sftp: {
          configured: true,
          host: "sftp.partner.example",
          port: 22,
          path: "/exchange",
        },
      },
    );
    app.render(createElement(InviterScreen));
    await userEvent.fill(page.getByLabelText("Your name"), "Dana Okafor");
    await openConfiguration();
    await commitFile();
    await page
      .getByRole("button", { name: "Continue to matching & sharing" })
      .click();
    await page
      .getByRole("button", { name: "Continue to review & create" })
      .click();
    await expect
      .element(page.getByRole("button", { name: START_OPENED_EXCHANGE_LABEL }))
      .toBeInTheDocument();
  }

  test("offers no invitation duration, and warns of nothing unchanged", async () => {
    await goToReview();
    expect(page.getByLabelText("Invitation duration").query()).toBeNull();
    expect(app.container.textContent).not.toContain(EDITED_TERMS_TITLE);
  });

  test("the shared secret's maximum age starts from the file's", async () => {
    await goToReview({ tokenMaxAgeDays: 30 });
    await expect
      .element(page.getByText(/secret expires 30 days after each exchange/))
      .toBeInTheDocument();
    await page
      .getByRole("button", { name: /Receipts and record keeping/ })
      .click();
    await expect
      .element(page.getByLabelText("Set a maximum age for the shared secret"))
      .toBeChecked();
    await expect
      .element(page.getByLabelText("Maximum age in days"))
      .toHaveValue("30");
  });

  test("a changed term is warned of until it is undone", async () => {
    await goToReview();
    const direction = page.getByLabelText("Who receives the matched results");
    const opened = (direction.element() as HTMLSelectElement).value;
    await userEvent.selectOptions(
      direction,
      opened === "inviter" ? "partner" : "inviter",
    );
    await expect
      .element(page.getByText(/psilink update/).first())
      .toBeInTheDocument();
    await expect
      .element(page.getByText(EDITED_TERMS_TITLE).first())
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: START_OPENED_EXCHANGE_LABEL }))
      .toBeEnabled();

    await userEvent.selectOptions(direction, opened);
    await expect
      .element(page.getByText(/psilink update/).first())
      .not.toBeInTheDocument();
  });
});
