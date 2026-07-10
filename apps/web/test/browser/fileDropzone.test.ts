/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test, vi } from "vitest";

import { createElement } from "react";
import { createRoot } from "react-dom/client";

import { MantineProvider } from "@mantine/core";

import FileDropzone from "@components/FileDropzone";

import type { Root } from "react-dom/client";

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
let setFiles: ReturnType<typeof vi.fn<(acceptedFiles: Array<File>) => void>>;

function renderFileDropzone(files: Array<File> = []) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  setFiles = vi.fn<(acceptedFiles: Array<File>) => void>();
  root.render(
    createElement(
      MantineProvider,
      null,
      createElement(FileDropzone, { files, setFiles }),
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

describe("FileDropzone single-file restriction", () => {
  test("constrains the underlying Dropzone to a single file", async () => {
    renderFileDropzone();

    await vi.waitFor(() => expect(dropzone.props).toBeDefined());

    expect(dropzone.props?.multiple).toBe(false);
  });

  test("warns and accepts nothing when more than one file is dropped", async () => {
    renderFileDropzone();

    await vi.waitFor(() => expect(dropzone.props).toBeDefined());

    // Mantine's Dropzone (multiple={false}) rejects the whole batch with a
    // too-many-files error and calls onReject, never onDrop, when more than one
    // file lands at once -- this exercises that rejection path directly.
    const onReject = dropzone.props?.onReject as (
      rejected: Array<{
        file: File;
        errors: Array<{ code: string; message: string }>;
      }>,
    ) => void;
    onReject([
      {
        file: new File(["a"], "a.csv", { type: "text/csv" }),
        errors: [{ code: "too-many-files", message: "Too many files" }],
      },
      {
        file: new File(["b"], "b.csv", { type: "text/csv" }),
        errors: [{ code: "too-many-files", message: "Too many files" }],
      },
    ]);

    await vi.waitFor(() =>
      expect(container?.textContent).toContain(
        "Drop a single CSV file; multiple files were not accepted.",
      ),
    );
    expect(setFiles).not.toHaveBeenCalled();
  });

  test("clears the multi-file warning and shows the single accepted file", async () => {
    renderFileDropzone();

    await vi.waitFor(() => expect(dropzone.props).toBeDefined());

    const onReject = dropzone.props?.onReject as (
      rejected: Array<{
        file: File;
        errors: Array<{ code: string; message: string }>;
      }>,
    ) => void;
    onReject([
      {
        file: new File(["a"], "a.csv", { type: "text/csv" }),
        errors: [{ code: "too-many-files", message: "Too many files" }],
      },
    ]);
    await vi.waitFor(() =>
      expect(container?.textContent).toContain(
        "Drop a single CSV file; multiple files were not accepted.",
      ),
    );

    const onDrop = dropzone.props?.onDrop as (accepted: Array<File>) => void;
    const single = new File(["a"], "a.csv", { type: "text/csv" });
    onDrop([single]);

    expect(setFiles).toHaveBeenCalledWith([single]);
    await vi.waitFor(() =>
      expect(container?.textContent).not.toContain(
        "Drop a single CSV file; multiple files were not accepted.",
      ),
    );
  });
});
