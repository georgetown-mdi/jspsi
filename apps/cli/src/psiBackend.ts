import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { loadPsiBackend } from "@psilink/core";
import type { PsiBackendOptions, PsiBackendSelection } from "@psilink/core";

/**
 * Loads the native N-API PSI addon when a prebuild is available for this
 * platform, or resolves `null` so the CLI falls back to the WASM engine.
 *
 * The `@openmined/psi.js/psi_native_node.js` entry loads the prebuilt `.node`
 * addon (via node-gyp-build, resolving prebuilds/<platform>-<arch>/) and wraps
 * it in the same PSILibrary shape as the WASM build. It rejects when no prebuild
 * exists for the running platform -- or the entry is absent from an older
 * vendored package -- and we resolve `null` so the selector falls back to WASM.
 * The addon is a performance accelerator; correctness never depends on it, and
 * its wire output matches the psi-engine-wire-vectors.json interop fixture in
 * @psilink/core byte-for-byte.
 */
async function loadNativePsiAddon(): Promise<PSILibrary | null> {
  try {
    const { default: loadNativeLibrary } =
      await import("@openmined/psi.js/psi_native_node.js");
    return await loadNativeLibrary();
  } catch (error) {
    // Expected when no prebuild ships for this platform (node-gyp-build) or the
    // native entry is absent from an older vendored package (module not found):
    // fall back to WASM quietly. Anything else -- a corrupt or ABI-mismatched
    // .node -- is a genuine failure, so re-throw and let the selector surface it
    // through onNativeUnavailable rather than mislabel it as "no prebuild". The
    // selector falls back to WASM either way, so correctness is unaffected.
    if (isNativeUnavailable(error)) {
      return null;
    }
    throw error;
  }
}

/**
 * Whether a native-addon load error is the ordinary "no native build for this
 * platform / package" case (quiet fallback) rather than a genuinely broken load
 * worth surfacing.
 */
function isNativeUnavailable(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND") {
    return true;
  }
  return (
    error instanceof Error && /No native build was found/i.test(error.message)
  );
}

/**
 * Resolves the CLI's PSI crypto backend: the native addon when a prebuild is
 * available for this platform, otherwise the Node WASM build. The CLI always
 * runs under Node, so the native addon is always eligible;
 * {@link loadNativePsiAddon} decides whether one is actually present.
 */
export function loadCliPsiBackend(
  options?: Pick<PsiBackendOptions, "onNativeUnavailable">,
): Promise<PsiBackendSelection> {
  return loadPsiBackend(
    { loadWasm: () => PSI(), loadNative: loadNativePsiAddon },
    { isNode: true, ...options },
  );
}
