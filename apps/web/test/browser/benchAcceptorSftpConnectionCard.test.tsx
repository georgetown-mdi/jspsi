/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

// Load Mantine's stylesheet so components render with their real geometry.
import "@mantine/core/styles.css";

import { AcceptorSftpConnectionCard } from "@bench/AcceptorSftpConnectionCard";

import { renderApp } from "./renderApp";

import type { ReactNode } from "react";
import type { Root } from "react-dom/client";

import type { SftpConnectionProjection } from "@jobs/jobManager";
import type { SftpEndpointLocator } from "@bench/sftpConnectionForm";

// The boot-provisioned accept-side SFTP card must let the operator confirm the
// appliance's server against the one the PARTNER named: it renders both locators
// and warns prominently when they name different servers, without blocking launch
// (a boot host may be a legitimate alias or IP of the partner's name).

const MISMATCH_TITLE =
  "This appliance's server is not the one your partner named";

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
});

const noop = () => undefined;

function bootCard(
  locator: SftpEndpointLocator,
  connection: SftpConnectionProjection,
) {
  return createElement(AcceptorSftpConnectionCard, {
    locator,
    connection,
    bootPinned: true,
    onAuthored: noop,
    onCleared: noop,
  });
}

describe("boot-pinned accept SFTP card", () => {
  test("mismatched boot and partner servers render both locators and the warning", async () => {
    mount(
      bootCard(
        { host: "sftp.partner.example", port: 2022, path: "/drop" },
        { host: "boot.internal.example", port: 2022, path: "/drop" },
      ),
    );

    // Both the partner's locator and the appliance's boot server are shown, so the
    // "confirm they are the same server" prompt is actually verifiable.
    await expect
      .element(page.getByText("sftp.partner.example:2022", { exact: false }))
      .toBeInTheDocument();
    await expect
      .element(page.getByText("boot.internal.example:2022", { exact: false }))
      .toBeInTheDocument();
    await expect.element(page.getByText(MISMATCH_TITLE)).toBeInTheDocument();
  });

  test("matching servers show the partner locator but no mismatch warning", async () => {
    mount(
      bootCard(
        { host: "sftp.partner.example", port: 2022, path: "/drop" },
        { host: "sftp.partner.example", port: 2022, path: "/drop" },
      ),
    );

    // Both locators are shown for confirmation (identical here, so assert the
    // shared prompt rather than the ambiguous duplicate label), and no warning.
    await expect
      .element(
        page.getByText("Confirm they are the same server", { exact: false }),
      )
      .toBeInTheDocument();
    expect(page.getByText(MISMATCH_TITLE).query()).toBeNull();
  });
});
