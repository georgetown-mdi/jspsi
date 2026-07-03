import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

// Mirrors apps/cli/src/psiBackend.ts:isNativeUnavailable: the ordinary "no
// prebuild ships for this platform" case (node-gyp-build) or an older vendored
// package that lacks the native entry (module not found). A present-but-broken
// .node (e.g. ERR_DLOPEN_FAILED from an ABI mismatch or a missing transitive
// symbol) is NOT this case.
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
 * Loads the native N-API PSI addon for the running platform, or resolves
 * `undefined` when no prebuild is shipped here so the caller can skip. A
 * present-but-broken addon is re-thrown so the test FAILS rather than silently
 * skipping -- otherwise a corrupt or ABI-mismatched prebuild would report a false
 * green in exactly the CI environment these native tests exist to protect.
 */
export async function loadNativeAddonOrSkip(): Promise<PSILibrary | undefined> {
  try {
    const { default: loadNativeLibrary } =
      await import("@openmined/psi.js/psi_native_node.js");
    return await loadNativeLibrary();
  } catch (error) {
    if (isNativeUnavailable(error)) {
      return undefined;
    }
    throw error;
  }
}
