/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import Papa from "papaparse";

import FileSelect from "@components/FileSelect";

import type { Root } from "react-dom/client";

// Capture the props FileSelect hands the Mantine dropzone. Core's loadCSVFile
// parses in PapaParse worker mode, which silently drops every row past the first
// `Papa.LocalChunkSize` chunk, so the only thing keeping an accepted file
// single-chunk is the dropzone's byte cap -- AND only if FileSelect actually
// passes a within-chunk value as `maxSize`. Asserting the cap constant in
// isolation would miss a rewire to an unsafe literal, so capture and check the
// value the dropzone really receives. The Accept/Reject/Idle statics are
// referenced in FileSelect's JSX, so the stub must carry them.
const dropzone = vi.hoisted(() => ({
  props: undefined as Record<string, unknown> | undefined,
}));
vi.mock("@mantine/dropzone", () => {
  const Dropzone = (props: Record<string, unknown>) => {
    dropzone.props = props;
    return null;
  };
  Dropzone.Accept = () => null;
  Dropzone.Reject = () => null;
  Dropzone.Idle = () => null;
  return { Dropzone, MIME_TYPES: { csv: "text/csv" } };
});

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  dropzone.props = undefined;
});

describe("FileSelect intake size cap", () => {
  test("hands the dropzone a maxSize within one PapaParse chunk", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    root.render(
      createElement(
        MantineProvider,
        null,
        createElement(FileSelect, {
          submitLabel: "Start",
          handleSubmit: () => {},
          files: [],
          setFiles: () => {},
          submitted: false,
        }),
      ),
    );

    await vi.waitFor(() => expect(dropzone.props).toBeDefined());

    // Worker-mode parsing past one chunk truncates silently, so the cap the
    // dropzone enforces -- whatever FileSelect actually passes -- must not exceed
    // PapaParse's local chunk size. A future rewire to a larger literal fails
    // here instead of shipping silent data loss.
    expect(typeof dropzone.props?.maxSize).toBe("number");
    expect(dropzone.props?.maxSize as number).toBeLessThanOrEqual(
      Papa.LocalChunkSize,
    );
  });
});
