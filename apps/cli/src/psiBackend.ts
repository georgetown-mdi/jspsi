import PSI from "@openmined/psi.js";
import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import { loadPsiBackend } from "@psilink/core";
import type { PsiBackendOptions, PsiBackendSelection } from "@psilink/core";

/**
 * Loads the native N-API PSI addon when a prebuild is available for this
 * platform, or resolves `null` so the CLI falls back to the WASM engine.
 *
 * SEAM (board item 199653275, "Build the native N-API PSI addon and
 * cross-platform prebuilds"): the addon is not built yet, so this resolves
 * `null` and the CLI runs on WASM exactly as before. The agent building the
 * addon replaces this body with the real prebuild resolution (a require of the
 * chosen addon package, e.g. via node-gyp-build), keeping the null-on-absent
 * contract so an unbuilt platform still falls back. The addon's byte output must
 * match the psi-engine-wire-vectors.json interop fixture in @psilink/core.
 */
async function loadNativePsiAddon(): Promise<PSILibrary | null> {
  return null;
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
