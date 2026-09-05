/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import { RecurringHandoff } from "@bench/RecurringHandoff";

import { createAppMount, flushPendingUpdates } from "./renderApp";

import type { JobHandoff } from "@jobs/handoff";

const JOB_ID = "job-9";

/** A zero-setup (Direct) sftp hand-off: a command template with a placeholder
 * credential path. */
const COMMAND_HANDOFF = {
  mode: "zeroSetup",
  channel: "sftp",
  usedKeyFile: false,
  credentialPasted: false,
  usedSigningIdentity: false,
  template: {
    kind: "command",
    argv: [
      "psilink",
      "sftp://sftp.example.gov:2222/exchange",
      "--server-username=linkage",
      "--server-host-key-fingerprint=SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "--server-password=@/path/to/your/credential-file",
      "input.csv",
      "results.csv",
    ],
  },
} satisfies JobHandoff;

/** A zero-setup filedrop hand-off whose `--identity` label has a space, to
 * exercise the cron (POSIX) vs Windows (cmd) quoting divergence. */
const SPACED_COMMAND_HANDOFF = {
  mode: "zeroSetup",
  channel: "filedrop",
  usedKeyFile: false,
  credentialPasted: false,
  usedSigningIdentity: false,
  template: {
    kind: "command",
    argv: [
      "psilink",
      "file:///path/to/your/shared-directory",
      "--identity=Agency A",
      "input.csv",
      "results.csv",
    ],
  },
} satisfies JobHandoff;

/** An invitation (exchange) sftp hand-off: a config template plus the key-file
 * copy step. */
const CONFIG_HANDOFF = {
  mode: "exchange",
  channel: "sftp",
  usedKeyFile: true,
  credentialPasted: false,
  usedSigningIdentity: false,
  template: {
    kind: "config",
    yaml:
      "connection:\n  channel: sftp\n  server:\n    host: sftp.example.gov\n" +
      "    password: '@/path/to/your/credential-file'\n",
  },
} satisfies JobHandoff;

/** The same invitation hand-off for a run that signed its receipts, which adds
 * the carry-the-identity step and the timestamped-receipt note. */
const SIGNED_CONFIG_HANDOFF = {
  ...CONFIG_HANDOFF,
  usedSigningIdentity: true,
} satisfies JobHandoff;

/** Stub the same-origin hand-off endpoint at the global fetch boundary. A null body
 * makes it 404 (the unavailable case). */
function stubHandoff(body: unknown | null): void {
  const realFetch = window.fetch.bind(window);
  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (url === `/api/jobs/${JOB_ID}/handoff`) {
        if (body === null)
          return Promise.resolve(new Response(null, { status: 404 }));
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return realFetch(input, init);
    },
  );
}

const app = createAppMount();

afterEach(async () => {
  await flushPendingUpdates();
  app.unmount();
  vi.unstubAllGlobals();
});

const HANDOFF_HEADING = "Run this exchange on a schedule";

describe("RecurringHandoff panel", () => {
  test("shows the Direct-run command and both scheduler snippets", async () => {
    stubHandoff(COMMAND_HANDOFF);
    app.render(createElement(RecurringHandoff, { jobId: JOB_ID }));

    await expect
      .element(page.getByRole("heading", { name: HANDOFF_HEADING }))
      .toBeInTheDocument();

    const text = () => app.container.textContent;
    // The command template, including the portable pin and the placeholder credential.
    expect(text()).toContain("psilink sftp://sftp.example.gov:2222/exchange");
    expect(text()).toContain("--server-host-key-fingerprint=SHA256:");
    expect(text()).toContain(
      "--server-password=@/path/to/your/credential-file",
    );
    expect(text()).toContain("input.csv results.csv");

    // Both scheduler snippets, clearly templates to adjust.
    expect(text()).toContain("0 2 * * *");
    expect(text()).toContain("schtasks /Create");

    // A Direct run has no key file to copy.
    expect(text()).toContain("no shared secret");
    expect(text()).not.toContain(".psilink.key");
  });

  test("quotes a spaced Direct label POSIX for cron and cmd-style for Windows", async () => {
    stubHandoff(SPACED_COMMAND_HANDOFF);
    app.render(createElement(RecurringHandoff, { jobId: JOB_ID }));

    await expect
      .element(page.getByRole("heading", { name: HANDOFF_HEADING }))
      .toBeInTheDocument();

    const text = () => app.container.textContent;
    // The cron line honors POSIX single quotes; the Windows /TR example escapes
    // the cmd-honored double quotes so schtasks preserves them.
    expect(text()).toContain("'--identity=Agency A'");
    expect(text()).toContain('\\"--identity=Agency A\\"');
  });

  test("shows the config template and the key-file copy step for an invitation run", async () => {
    stubHandoff(CONFIG_HANDOFF);
    app.render(createElement(RecurringHandoff, { jobId: JOB_ID }));

    await expect
      .element(page.getByRole("heading", { name: HANDOFF_HEADING }))
      .toBeInTheDocument();

    const text = () => app.container.textContent;
    // The config template and the fixed exchange command.
    expect(text()).toContain("channel: sftp");
    expect(text()).toContain("psilink exchange input.csv results.csv");
    // The copy-the-key step and both scheduler snippets.
    expect(text()).toContain(".psilink.key");
    expect(text()).toContain("0 2 * * *");
    expect(text()).toContain("schtasks /Create");
    // An unsigned run is told nothing about carrying a signing identity.
    expect(text()).not.toContain("Copy your signing identity");
  });

  test("adds the carry-the-identity step for a run that signed its receipts", async () => {
    stubHandoff(SIGNED_CONFIG_HANDOFF);
    app.render(createElement(RecurringHandoff, { jobId: JOB_ID }));

    await expect
      .element(page.getByRole("heading", { name: HANDOFF_HEADING }))
      .toBeInTheDocument();

    const text = () => app.container.textContent;
    // Copy the identity rather than minting a new one: a fresh key would have a
    // fingerprint the partner has not pinned.
    expect(text()).toContain("Copy your signing identity into that folder");
    expect(text()).toContain("do not run psilink fingerprint there");
    // The schedule accumulates a receipt trail rather than overwriting one file.
    expect(text()).toContain("timestamped receipt");
  });

  test("renders nothing when the hand-off is unavailable (non-blocking)", async () => {
    stubHandoff(null);
    app.render(createElement(RecurringHandoff, { jobId: JOB_ID }));
    // Give the fetch a tick to resolve to a 404, then confirm the panel never
    // appears (only the provider's injected <style> occupies the container).
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.container.textContent).not.toContain(HANDOFF_HEADING);
  });
});
