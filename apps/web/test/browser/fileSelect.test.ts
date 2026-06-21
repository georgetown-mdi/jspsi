/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import FileSelect from "@components/FileSelect";
import { MAX_CSV_FILE_BYTES } from "@components/csvIntake";

import type { Root } from "react-dom/client";

// Capture the props FileSelect hands the Mantine dropzone. The intake cap is the
// documented browser-memory ceiling (MAX_CSV_FILE_BYTES); core's loadCSVFile now
// accumulates across PapaParse chunks, so the cap is no longer tied to a single
// chunk -- the no-silent-truncation invariant is pinned directly in
// loadCSVFile.test.ts instead. What this guard still protects is the wiring:
// FileSelect must pass the cap CONSTANT through as `maxSize`, not a stale literal
// that could silently drift from the value the rest of the app documents. So
// capture and check the value the dropzone really receives. The Accept/Reject/Idle
// statics are referenced in FileSelect's JSX, so the stub must carry them.
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

function renderFileSelect() {
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
}

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = undefined;
  container = undefined;
  dropzone.props = undefined;
});

describe("FileSelect intake size cap", () => {
  test("hands the dropzone the documented cap constant as maxSize", async () => {
    renderFileSelect();

    await vi.waitFor(() => expect(dropzone.props).toBeDefined());

    // Pin the wiring, not the arithmetic: FileSelect must pass MAX_CSV_FILE_BYTES
    // through unchanged, so a future rewire to a hardcoded literal fails here
    // instead of silently shipping a cap that disagrees with the documented one.
    expect(dropzone.props?.maxSize).toBe(MAX_CSV_FILE_BYTES);
  });

  test("shows a clear over-size message when the dropzone rejects a too-large file", async () => {
    renderFileSelect();

    await vi.waitFor(() => expect(dropzone.props).toBeDefined());

    const onReject = dropzone.props?.onReject as (
      rejected: Array<{
        file: File;
        errors: Array<{ code: string; message: string }>;
      }>,
    ) => void;
    onReject([
      {
        file: new File(["x"], "big.csv", { type: "text/csv" }),
        errors: [
          { code: "file-too-large", message: "file is larger than ..." },
        ],
      },
    ]);

    // The message names the cap (derived from MAX_CSV_FILE_BYTES) so the user is
    // told why the file was refused rather than left with a flashed reject icon.
    const maxMb = MAX_CSV_FILE_BYTES / 1024 ** 2;
    await vi.waitFor(() =>
      expect(container?.textContent).toContain(
        `larger than the ${maxMb} MB maximum`,
      ),
    );
  });

  test("names every reason when a batch mixes a too-large and a wrong-type file", async () => {
    renderFileSelect();

    await vi.waitFor(() => expect(dropzone.props).toBeDefined());

    const onReject = dropzone.props?.onReject as (
      rejected: Array<{
        file: File;
        errors: Array<{ code: string; message: string }>;
      }>,
    ) => void;
    onReject([
      {
        file: new File(["x"], "big.csv", { type: "text/csv" }),
        errors: [{ code: "file-too-large", message: "too large" }],
      },
      {
        file: new File(["x"], "note.txt", { type: "text/plain" }),
        errors: [{ code: "file-invalid-type", message: "wrong type" }],
      },
    ]);

    // A mixed batch must surface both reasons; checking only the size code would
    // silently swallow the wrong-type rejection.
    const maxMb = MAX_CSV_FILE_BYTES / 1024 ** 2;
    await vi.waitFor(() => {
      const text = container?.textContent ?? "";
      expect(text).toContain(`larger than the ${maxMb} MB maximum`);
      expect(text).toContain("not a supported file type");
    });
  });
});
