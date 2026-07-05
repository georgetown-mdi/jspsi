import { afterEach, describe, expect, test, vi } from "vitest";

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { detectNodeRuntime, loadPsiBackend } from "../src/psiBackend";

// Distinct sentinels standing in for real PSILibrary instances; the selector
// only routes them, it never calls into them.
const NATIVE = { backend: "native" } as unknown as PSILibrary;
const WASM = { backend: "wasm" } as unknown as PSILibrary;

describe("loadPsiBackend", () => {
  test("selects the native addon under Node when a prebuild loads", async () => {
    const onNativeUnavailable = vi.fn();
    const selection = await loadPsiBackend(
      { loadNative: async () => NATIVE, loadWasm: async () => WASM },
      { isNode: true, onNativeUnavailable },
    );
    expect(selection).toEqual({ library: NATIVE, backend: "native" });
    expect(onNativeUnavailable).not.toHaveBeenCalled();
  });

  test("falls back to WASM under Node when no prebuild is present", async () => {
    const loadNative = vi.fn(async () => null);
    const onNativeUnavailable = vi.fn();
    const selection = await loadPsiBackend(
      { loadNative, loadWasm: async () => WASM },
      { isNode: true, onNativeUnavailable },
    );
    expect(selection).toEqual({ library: WASM, backend: "wasm" });
    expect(loadNative).toHaveBeenCalledOnce();
    expect(onNativeUnavailable).toHaveBeenCalledWith({});
  });

  test("falls back to WASM under Node when the addon fails to load", async () => {
    const error = new Error("dlopen failed");
    const onNativeUnavailable = vi.fn();
    const selection = await loadPsiBackend(
      {
        loadNative: async () => {
          throw error;
        },
        loadWasm: async () => WASM,
      },
      { isNode: true, onNativeUnavailable },
    );
    expect(selection).toEqual({ library: WASM, backend: "wasm" });
    expect(onNativeUnavailable).toHaveBeenCalledWith({ error });
  });

  test("always selects WASM in the browser, never consulting the native loader", async () => {
    const loadNative = vi.fn(async () => NATIVE);
    const selection = await loadPsiBackend(
      { loadNative, loadWasm: async () => WASM },
      { isNode: false },
    );
    expect(selection).toEqual({ library: WASM, backend: "wasm" });
    expect(loadNative).not.toHaveBeenCalled();
  });

  test("selects WASM under Node when no native loader is provided", async () => {
    const selection = await loadPsiBackend(
      { loadWasm: async () => WASM },
      { isNode: true },
    );
    expect(selection).toEqual({ library: WASM, backend: "wasm" });
  });

  test("defaults isNode to the detected runtime (Node under vitest)", async () => {
    // No explicit isNode: the default detection must find Node here, so the
    // native loader is consulted -- the same path the CLI takes in production.
    const loadNative = vi.fn(async () => NATIVE);
    const selection = await loadPsiBackend({
      loadNative,
      loadWasm: async () => WASM,
    });
    expect(selection).toEqual({ library: NATIVE, backend: "native" });
    expect(loadNative).toHaveBeenCalledOnce();
  });
});

describe("detectNodeRuntime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("detects the Node runtime under the node-environment unit suite", () => {
    expect(detectNodeRuntime()).toBe(true);
  });

  test("reports non-Node when a DOM window is present, even with a process shim", () => {
    // A bundled browser build can shim `process`, so a present `window` is what
    // disambiguates it from real Node. Stubbing `window` exercises the guard the
    // node-environment suite otherwise never runs false -- dropping it would let
    // such a browser misdetect as Node and consult the native loader.
    vi.stubGlobal("window", {});
    expect(detectNodeRuntime()).toBe(false);
  });

  test("reports non-Node when no process is present", () => {
    // The browser-without-shim case: no Node `process` at all.
    vi.stubGlobal("process", undefined);
    expect(detectNodeRuntime()).toBe(false);
  });
});
