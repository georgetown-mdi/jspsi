/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement, useEffect, useState } from "react";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import {
  IDENTITY_LABEL_REQUIRED_REASON,
  RECEIPTS_DEFAULT,
} from "@psi/receiptsModel";
import { ReceiptsCard } from "@console/ReceiptsCard";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { JobRendezvousConfig } from "@psi/jobClient/workInputClient";
import type { ReactElement } from "react";
import type { ReceiptsDraft } from "@psi/receiptsModel";

// The console's receipts card against a stubbed signing endpoint. What
// `receiptsModel` decides is pinned by the unit suite; what this one covers is the
// card's own behaviour around a request that takes real time -- the console
// spawns the CLI's `fingerprint` child -- while the operator keeps editing beside
// it. The draft is REPLACED wholesale by `onChange`, so a resolution that
// committed the draft it was started with would silently undo an edit made while
// it ran, up to and including putting back a mode the operator had left.

/** A canonical 43-character fingerprint: the final character comes from the
 * aligned set core's regex requires. */
const FINGERPRINT = "B".repeat(42) + "A";

const IDENTITY_FILE = ".psilink-signing-identity.json";
const CERTIFICATE_FILE = "psilink-certificate.json";

/** The exchange's `linkage_terms.identity`, the one value the request holds. */
const IDENTITY = "Dana Okafor, Riverside Health";

const NOTE = "Filed in the association database; purged after six years.";

/** The card's copy for a `409`, which is what the stale-failure test looks for. */
const BUSY_FAILURE = "Another fingerprint request is still running.";

/** What the card says when the console withheld the create because a
 * shared-folder exchange still holds the console's exchange slot and syncs the
 * folder the key would land in. */
const SYNCING_FAILURE =
  "A shared-folder exchange is still open on this console, and it syncs the folder your signing identity would be written into.";

/** The card's copy for the CLI's exit 64 at the console's default location,
 * where the identity is in the mounted working directory and this endpoint
 * creates it there. */
const REFUSED_DEFAULT =
  "Your signing identity could not be created or read in the folder you mounted. Check that the folder is writable,";

/** The same refusal where the operator picked a location: the console reads
 * that file and creates nothing at it, so the copy names the file rather than
 * the folder's mode -- the folder is the one the deployment guide has them
 * mount read-only. */
const REFUSED_PICKED =
  "Your signing identity could not be read from the file you picked. It may be unreadable, or not a signing identity.";

interface StubbedResponse {
  status?: number;
  body?: unknown;
}

interface StubOptions {
  /** The responses the endpoint gives, in request order; the last one repeats. */
  responses?: Array<StubbedResponse>;
  /** The entries the secrets browse answers with, when a test opens the picker
   * to change where the signing identity is kept. */
  secretsEntries?: Array<{ name: string; kind: "dir" | "file" }>;
  /** Whether the console has a secrets mount at all; false answers the browse
   * the way an unset JOB_SECRETS_DIR does. */
  secretsConfigured?: boolean;
  /** Gates the responses wait on, taken in request order: the nth request settles
   * when the nth promise does, so a test can drive the card while a request is
   * genuinely in flight. A request past the end of the list settles at once. */
  gates?: Array<Promise<void>>;
}

/** The server's `200` envelope for an attempt that produced a fingerprint. */
function okBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    status: "ok",
    fingerprint: FINGERPRINT,
    created: true,
    identityFileName: IDENTITY_FILE,
    ...overrides,
  };
}

/** One held-open response, standing in for the seconds the real request spends
 * spawning and waiting on the CLI child. */
function createGate(): { promise: Promise<void>; settle: () => void } {
  let settle = (): void => {};
  const promise = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/** The console's signing endpoint, stubbed at the global fetch boundary the card
 * reaches through, recording each request body so a test can assert what crossed. */
function stubSigningApi(options: StubOptions = {}): { bodies: Array<string> } {
  const bodies: Array<string> = [];
  const realFetch = window.fetch.bind(window);
  const responses = options.responses ?? [{ body: okBody() }];
  let requests = 0;

  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url.startsWith("/api/jobs/mounts/secrets/entries"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              configured: options.secretsConfigured ?? true,
              readable: true,
              entries: options.secretsEntries ?? [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      if (url !== "/api/jobs/signing/fingerprint")
        return realFetch(input, init);
      const index = requests++;
      bodies.push(typeof init?.body === "string" ? init.body : "");
      const answer = responses[Math.min(index, responses.length - 1)];
      const respond = (): Response =>
        answer.body === undefined
          ? new Response(null, { status: answer.status ?? 200 })
          : new Response(JSON.stringify(answer.body), {
              status: answer.status ?? 200,
              headers: { "Content-Type": "application/json" },
            });
      const gate = options.gates?.[index];
      return gate !== undefined
        ? gate.then(respond)
        : Promise.resolve(respond());
    },
  );

  return { bodies };
}

/** The draft the harness last held, so a test can assert on the value a screen
 * would include in the run intent as well as on what is rendered. */
let latestDraft: ReceiptsDraft = RECEIPTS_DEFAULT;

/** The default console layout: one mount, so the rendezvous holds the working
 * directory. A shared-folder exchange there is refused before it runs, and the
 * card's advisory states that refusal and the one path it reads. Creating the
 * identity is not refused on any layout. */
const SINGLE_MOUNT_RENDEZVOUS: JobRendezvousConfig = {
  configured: true,
  locator: "psilink",
  folderName: "psilink",
  sharesDataRoot: true,
  sharesDataRootUncertain: false,
};

/**
 * The card wired the way both screens wire it -- `AcceptorScreen` directly and
 * `InviterScreen` through `ReviewCreateSection` -- with a bare `useState` setter as
 * `onChange`. That is the contract the concurrent-edit tests turn on: the setter
 * REPLACES the whole draft, so whatever the card passes is the whole of what
 * survives.
 */
function ReceiptsHarness({ identity }: { identity: string }): ReactElement {
  const [draft, setDraft] = useState<ReceiptsDraft>(RECEIPTS_DEFAULT);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    latestDraft = draft;
  }, [draft]);
  return createElement(ReceiptsCard, {
    draft,
    identity,
    rendezvous: SINGLE_MOUNT_RENDEZVOUS,
    open,
    onToggleOpen: setOpen,
    onChange: setDraft,
  });
}

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  latestDraft = RECEIPTS_DEFAULT;
  vi.unstubAllGlobals();
});

const modeSelect = () => page.getByLabelText("What this exchange produces");

const retentionNote = () =>
  page.getByLabelText("Retention note for your own record");

const createButton = () =>
  page.getByRole("button", { name: "Create or show my fingerprint" });

/** The file the secrets browse offers, and the one a test picks. */
const PICKED_IDENTITY = "psilink-signing-identity.json";

/** A picked file whose name holds a right-to-left override, which the browse
 * admits (it bars control characters and separators, not this) and the console
 * echoes back as the name of the file the identity was read from. */
const REORDERING_IDENTITY = `identity\u202egpj.json`;

/** The same name as the card must show it: every character outside printable
 * ASCII escaped, the form the browse's own listing shows. */
const REORDERING_IDENTITY_SHOWN = "identity\\u202egpj.json";

/** Open the identity-location browse and pick the one file it lists. */
async function pickIdentityLocation(name: string): Promise<void> {
  await page
    .getByRole("button", { name: "Choose a file from the secrets folder" })
    .click();
  await page.getByRole("button", { name: `Use ${name}` }).click();
}

async function renderCard(identity: string = IDENTITY): Promise<void> {
  app.render(createElement(ReceiptsHarness, { identity }));
  await expect.element(modeSelect()).toBeInTheDocument();
}

async function chooseCertificateMode(): Promise<void> {
  await userEvent.selectOptions(modeSelect(), "certificate");
  await expect.element(createButton()).toBeInTheDocument();
}

/** Lets a settled response finish crossing the client -- the fetch, the JSON read,
 * and the render either schedules -- before a test asserts on what did NOT
 * happen. A positive assertion polls and needs none of this. */
async function drainSettledResponse(): Promise<void> {
  await flushPendingUpdates();
  await flushPendingUpdates();
  await flushPendingUpdates();
}

describe("ReceiptsCard: asking the console for this party's fingerprint", () => {
  test("shows the value to share and names the file it landed in", async () => {
    const stub = stubSigningApi();
    await renderCard();
    await chooseCertificateMode();

    await createButton().click();

    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .toHaveTextContent(FINGERPRINT);
    expect(app.container.textContent).toContain(
      "Your signing identity was created",
    );
    expect(app.container.textContent).toContain(IDENTITY_FILE);
    expect(latestDraft.ownFingerprint).toBe(FINGERPRINT);
    // The request holds the label and nothing else while the export is off.
    expect(JSON.parse(stub.bodies[0])).toEqual({ identity: IDENTITY });
    // Create-or-reuse, so the action renames itself once a value is on screen.
    await expect
      .element(page.getByRole("button", { name: "Show it again" }))
      .toBeInTheDocument();
  });

  test("distinguishes an identity that was already there", async () => {
    stubSigningApi({ responses: [{ body: okBody({ created: false }) }] });
    await renderCard();
    await chooseCertificateMode();

    await createButton().click();

    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .toHaveTextContent(FINGERPRINT);
    expect(app.container.textContent).toContain(
      "Your signing identity was already set up",
    );
  });

  test("holds the export toggle and names what it wrote", async () => {
    const stub = stubSigningApi({
      responses: [{ body: okBody({ certificateFileName: CERTIFICATE_FILE }) }],
    });
    await renderCard();
    await chooseCertificateMode();

    await page.getByLabelText("Also write out my public certificate").click();
    await createButton().click();

    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .toHaveTextContent(FINGERPRINT);
    expect(app.container.textContent).toContain(
      `Your public certificate is in ${CERTIFICATE_FILE}.`,
    );
    expect(JSON.parse(stub.bodies[0])).toEqual({
      identity: IDENTITY,
      exportCertificate: true,
    });
  });

  test("a picked location rides the request as a locator, never a path", async () => {
    // The whole point of the browse: the operator names the file by picking it,
    // and what leaves the browser is the mount id and the segments it listed.
    const stub = stubSigningApi({
      secretsEntries: [{ name: PICKED_IDENTITY, kind: "file" }],
      responses: [
        { body: okBody({ created: false, identityFileName: PICKED_IDENTITY }) },
      ],
    });
    await renderCard();
    await chooseCertificateMode();

    await pickIdentityLocation(PICKED_IDENTITY);
    await expect
      .element(page.getByRole("button", { name: "Show my fingerprint" }))
      .toBeInTheDocument();
    await page.getByRole("button", { name: "Show my fingerprint" }).click();

    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .toHaveTextContent(FINGERPRINT);
    expect(JSON.parse(stub.bodies[0])).toEqual({
      identity: IDENTITY,
      identityLocation: { mount: "secrets", subPath: [PICKED_IDENTITY] },
    });
    expect(latestDraft.identityLocation).toEqual({
      mount: "secrets",
      subPath: [PICKED_IDENTITY],
    });
    // What the card shows is the locator's own segments; nothing on screen is a
    // container path, and the console never sent one either.
    expect(app.container.textContent).toContain(`secrets / ${PICKED_IDENTITY}`);
    expect(app.container.textContent).not.toContain("/run/");
    expect(app.container.textContent).not.toContain(IDENTITY_FILE);
  });

  test("a picked name that reorders the line is shown escaped", async () => {
    // The name rides the console's answer back and lands in the line that tells
    // the operator which file signed. Rendered raw, the override reorders that
    // line into a different claim about which file was read.
    stubSigningApi({
      secretsEntries: [{ name: REORDERING_IDENTITY, kind: "file" }],
      responses: [
        {
          body: okBody({
            created: false,
            identityFileName: REORDERING_IDENTITY,
          }),
        },
      ],
    });
    await renderCard();
    await chooseCertificateMode();

    await pickIdentityLocation(REORDERING_IDENTITY_SHOWN);
    await page.getByRole("button", { name: "Show my fingerprint" }).click();

    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .toHaveTextContent(FINGERPRINT);
    expect(app.container.textContent).toContain(
      `(${REORDERING_IDENTITY_SHOWN} in your secrets folder)`,
    );
    expect(app.container.textContent).not.toContain("\u202e");
  });

  test("moving the location drops the fingerprint read at the old one", async () => {
    const stub = stubSigningApi({
      secretsEntries: [{ name: PICKED_IDENTITY, kind: "file" }],
    });
    await renderCard();
    await chooseCertificateMode();
    await createButton().click();
    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .toBeInTheDocument();

    await pickIdentityLocation(PICKED_IDENTITY);

    // The value is gone from the draft and from the screen: it was a fact about
    // the key at the old location, and nothing here says the new one holds it.
    expect(latestDraft.ownFingerprint).toBeUndefined();
    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .not.toBeInTheDocument();
    expect(stub.bodies).toHaveLength(1);
  });

  test("nothing at the picked location is reported, not created", async () => {
    stubSigningApi({
      secretsEntries: [{ name: PICKED_IDENTITY, kind: "file" }],
      responses: [{ body: { status: "absent" } }],
    });
    await renderCard();
    await chooseCertificateMode();
    await pickIdentityLocation(PICKED_IDENTITY);

    await page.getByRole("button", { name: "Show my fingerprint" }).click();

    await expect
      .element(page.getByText("There is no signing identity at the file"))
      .toBeInTheDocument();
    expect(app.container.textContent).toContain("psilink fingerprint");
    expect(latestDraft.ownFingerprint).toBeUndefined();
  });

  test("returning to the default folder sends no locator at all", async () => {
    const stub = stubSigningApi({
      secretsEntries: [{ name: PICKED_IDENTITY, kind: "file" }],
    });
    await renderCard();
    await chooseCertificateMode();
    await pickIdentityLocation(PICKED_IDENTITY);

    await page
      .getByRole("button", { name: "Use the folder you mounted" })
      .click();
    await createButton().click();

    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .toBeInTheDocument();
    expect(JSON.parse(stub.bodies[0])).toEqual({ identity: IDENTITY });
    expect(latestDraft.identityLocation).toBeUndefined();
  });

  test("a console with no secrets mount says so in the identity's own terms", async () => {
    // The picker is shared with the credential field, whose remedy is a typed
    // @-file reference beside it. The identity field has no such field, so the
    // notice must name the remedy that is actually open here.
    stubSigningApi({ secretsConfigured: false });
    await renderCard();
    await chooseCertificateMode();

    await page
      .getByRole("button", { name: "Choose a file from the secrets folder" })
      .click();

    await expect
      .element(
        page.getByText("your signing identity stays in the folder you mounted"),
      )
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "No separate secrets directory",
    );
    expect(app.container.textContent).not.toContain("type a file reference");
  });

  test("withholds the request while this exchange states no identity", async () => {
    stubSigningApi();
    await renderCard("");
    await chooseCertificateMode();

    await expect.element(createButton()).toBeDisabled();
    expect(app.container.textContent).toContain(IDENTITY_LABEL_REQUIRED_REASON);
    // The reason is wired to the control, so an operator who lands on the
    // disabled button hears why rather than finding it inert.
    const describedBy = createButton()
      .element()
      .getAttribute("aria-describedby");
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? "")?.textContent).toBe(
      IDENTITY_LABEL_REQUIRED_REASON,
    );
  });
});

describe("ReceiptsCard: a request that resolves while the operator edits", () => {
  test("merges the fingerprint into the draft the operator has by then", async () => {
    const gate = createGate();
    stubSigningApi({ gates: [gate.promise] });
    await renderCard();
    await chooseCertificateMode();

    await createButton().click();
    // The child is still running; the operator keeps authoring beside it.
    await userEvent.fill(retentionNote(), NOTE);
    gate.settle();

    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .toHaveTextContent(FINGERPRINT);
    await expect.element(retentionNote()).toHaveValue(NOTE);
    expect(latestDraft.retentionDisposition).toBe(NOTE);
    expect(latestDraft.ownFingerprint).toBe(FINGERPRINT);
  });

  test("never resurrects a mode the operator switched away from", async () => {
    const gate = createGate();
    stubSigningApi({ gates: [gate.promise] });
    await renderCard();
    await chooseCertificateMode();

    await createButton().click();
    await userEvent.selectOptions(modeSelect(), "none");
    gate.settle();
    await drainSettledResponse();

    await expect.element(modeSelect()).toHaveValue("none");
    expect(latestDraft.mode).toBe("none");
    expect(latestDraft.ownFingerprint).toBeUndefined();
    expect(app.container.textContent).not.toContain(FINGERPRINT);

    // Returning re-asks the console rather than showing a value the switch
    // discarded, which is what the create-or-show wording means here.
    await userEvent.selectOptions(modeSelect(), "certificate");
    await expect.element(createButton()).toBeInTheDocument();
  });
});

describe("ReceiptsCard: a failed request", () => {
  test("names the open exchange syncing the folder, and both ways out", async () => {
    // The console answers a create it will not make with a status of its own, so
    // the card must not fold it into the generic "could not be created" copy:
    // nothing is wrong with the folder. The condition is an exchange the console
    // still holds -- finished but undiscarded as much as running -- so the copy
    // names discarding it beside the mount of its own, and never tells the
    // operator only to wait for a run that has already ended.
    stubSigningApi({ responses: [{ body: { status: "syncing" } }] });
    await renderCard();
    await chooseCertificateMode();

    await createButton().click();
    await expect
      .element(page.getByText(SYNCING_FAILURE, { exact: false }))
      .toBeInTheDocument();
    expect(app.container.textContent).toContain("discard it");
    expect(app.container.textContent).toContain("JOB_RENDEZVOUS_DIR");
  });

  test("names the folder it creates in when the location is the default", async () => {
    stubSigningApi({
      responses: [
        { body: { status: "refused" } },
        { body: { status: "timeout" } },
        { status: 500 },
      ],
    });
    await renderCard();
    await chooseCertificateMode();

    await createButton().click();
    await expect
      .element(page.getByText(REFUSED_DEFAULT, { exact: false }))
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "running 'psilink fingerprint' against the same folder",
    );

    await createButton().click();
    await expect
      .element(
        page.getByText(
          "Creating the signing identity took too long and was stopped.",
          { exact: false },
        ),
      )
      .toBeInTheDocument();

    await createButton().click();
    await expect
      .element(
        page.getByText("The signing identity could not be created or read.", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
  });

  test("names the picked file and a read of it when a location is picked", async () => {
    // The identity is then in the secrets mount, not the data root, and the
    // console only reads it -- so copy telling the operator to make that folder
    // writable and to re-run against it sends them to the wrong place, and
    // against the read-only mount the deployment guide recommends for it.
    stubSigningApi({
      secretsEntries: [{ name: PICKED_IDENTITY, kind: "file" }],
      responses: [
        { body: { status: "refused" } },
        { body: { status: "timeout" } },
        { status: 500 },
      ],
    });
    await renderCard();
    await chooseCertificateMode();
    await pickIdentityLocation(PICKED_IDENTITY);
    const showButton = page.getByRole("button", {
      name: "Show my fingerprint",
    });

    await showButton.click();
    await expect
      .element(page.getByText(REFUSED_PICKED, { exact: false }))
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(
      "Check that file at the location you picked, or pick another one.",
    );
    expect(app.container.textContent).toContain(
      "'psilink fingerprint --identity-file' pointed at that file",
    );
    expect(app.container.textContent).not.toContain("writable");
    // The psilink.yaml half stays: the child's working directory is the data
    // root whatever the identity's location, so that file is still the one it
    // can read.
    expect(app.container.textContent).toContain(
      "any psilink.yaml in the folder you mounted is valid YAML",
    );

    await showButton.click();
    await expect
      .element(
        page.getByText(
          "Reading the signing identity took too long and was stopped.",
          { exact: false },
        ),
      )
      .toBeInTheDocument();

    await showButton.click();
    await expect
      .element(
        page.getByText("The signing identity could not be read. Try again.", {
          exact: false,
        }),
      )
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain(
      "could not be created or read",
    );
  });

  test("leaves no stale failure for the next visit to certificate mode", async () => {
    stubSigningApi({ responses: [{ status: 409 }, { body: okBody() }] });
    await renderCard();
    await chooseCertificateMode();

    await createButton().click();
    await expect
      .element(page.getByText(BUSY_FAILURE, { exact: false }))
      .toBeInTheDocument();

    await userEvent.selectOptions(modeSelect(), "none");
    await userEvent.selectOptions(modeSelect(), "certificate");

    await expect.element(createButton()).toBeInTheDocument();
    expect(app.container.textContent).not.toContain(BUSY_FAILURE);

    // And a fresh attempt starts from no failure either.
    await createButton().click();
    await expect
      .element(page.getByLabelText("Your certificate fingerprint"))
      .toHaveTextContent(FINGERPRINT);
    expect(app.container.textContent).not.toContain(BUSY_FAILURE);
  });
});
