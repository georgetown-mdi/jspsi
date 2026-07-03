import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

// PSI crypto backend selection. participant.ts consumes a PSILibrary that a
// caller injects (see RunExchangeOptions.psiLibrary in exchange.ts); this picks
// which implementation of that same interface to inject. The node path prefers a
// native N-API addon (faster EC, parallelizable) and falls back to the portable
// WebAssembly build; the browser always uses WASM. The native addon wraps the
// SAME private-join-and-compute P-256 curve and wire format as WASM, so the two
// interoperate byte-for-byte (the psi-engine-wire-vectors.json fixture pins that
// contract). Building and shipping the addon is board item 199653275; this
// selector is the seam it plugs into. Correctness must never depend on the addon
// being present -- WASM is the default-correct fallback.

/**
 * Which PSI crypto engine {@link loadPsiBackend} resolved: the native N-API
 * addon, or the portable WebAssembly build.
 */
export type PsiBackendKind = "native" | "wasm";

/**
 * Loaders the environment supplies to {@link loadPsiBackend}. The selector owns
 * the node-vs-browser and prebuild-present-vs-absent decision; the caller owns
 * how each backend is imported, so no module resolution leaks into this pure
 * decision -- and a browser bundle pulls in neither the node WASM entry nor the
 * native addon.
 */
export interface PsiBackendLoaders {
  /**
   * Loads the native addon backend, or resolves `null` when no prebuild is
   * available for this platform. Consulted only under Node. A throw is treated
   * the same as `null` -- the selector falls back to WASM either way, so a
   * missing or broken addon never breaks correctness. Omit on the browser.
   */
  readonly loadNative?: () => Promise<PSILibrary | null>;
  /**
   * Loads the WebAssembly backend: always available, the default-correct
   * fallback. The caller chooses the node vs web WASM entry so the selector
   * stays bundler-agnostic.
   */
  readonly loadWasm: () => Promise<PSILibrary>;
}

/** Options controlling {@link loadPsiBackend}. */
export interface PsiBackendOptions {
  /**
   * Whether this is a Node runtime (native addon eligible). Defaults to
   * {@link detectNodeRuntime}. Pass an explicit value where the environment is
   * known statically -- the CLI is always Node, the web app always a browser --
   * which also makes the decision unit-testable without a real runtime.
   */
  readonly isNode?: boolean;
  /**
   * Invoked when the native backend was eligible (Node with a `loadNative`
   * loader) but yielded no library, just before falling back to WASM. `error`
   * is set when the loader threw and absent when it reported no prebuild
   * (resolved `null`). Diagnostics only -- the fallback happens regardless.
   */
  readonly onNativeUnavailable?: (info: { error?: unknown }) => void;
}

/** The engine {@link loadPsiBackend} resolved, and which backend it is. */
export interface PsiBackendSelection {
  readonly library: PSILibrary;
  readonly backend: PsiBackendKind;
}

/**
 * Best-effort check for a Node runtime. True only when a Node `process` is
 * present and no DOM `window` is: a bundled browser build can shim `process`, so
 * the absent window disambiguates that shim from real Node. Read through
 * `globalThis` so the reference type-checks without Node's ambient types and is
 * safe in every build.
 */
export function detectNodeRuntime(): boolean {
  const g = globalThis as {
    process?: { versions?: { node?: unknown } };
    window?: unknown;
  };
  return g.process?.versions?.node != null && g.window === undefined;
}

/**
 * Selects the PSI crypto backend: under Node, prefer the native addon and fall
 * back to WASM when no prebuild is available or the addon fails to load; in the
 * browser, always WASM. Correctness never depends on the addon being present --
 * the WASM path is the default-correct fallback.
 */
export async function loadPsiBackend(
  loaders: PsiBackendLoaders,
  options: PsiBackendOptions = {},
): Promise<PsiBackendSelection> {
  const isNode = options.isNode ?? detectNodeRuntime();
  if (isNode && loaders.loadNative) {
    try {
      const native = await loaders.loadNative();
      if (native) return { library: native, backend: "native" };
      options.onNativeUnavailable?.({});
    } catch (error) {
      options.onNativeUnavailable?.({ error });
    }
  }
  return { library: await loaders.loadWasm(), backend: "wasm" };
}
