// Comparison-only directory-path equivalence for the split-mode distinctness
// check (inbound_path vs outbound_path). Used in TWO layers that must agree: the
// connection-config schema refine (config/connection.ts), which rejects a split
// whose two paths resolve to one directory, and each channel's open()
// (fileSyncConnection.ts), which rejects the same collision before any dial.
// Keeping both on this one function is what makes the schema and the live
// connection give the same verdict for the same config.
//
// This is for the distinctness COMPARISON ONLY -- never for the path used on
// disk, which keeps its own per-channel form (normalizeFiledropPath / a single
// trailing-slash strip). It normalizes copies textually: fold backslashes, then
// drop empty and "." segments (collapsing repeated, leading "./", interior
// "/./", and trailing slashes alike) while preserving the absolute-vs-relative
// distinction. Pure string work so it stays browser-safe (no node:path).
//
// It deliberately does NOT resolve ".." (unsafe across a symlink, and rare in a
// configured directory), fold case (Windows filesystems are case-insensitive),
// or expand a relative path against an SFTP login home -- none of those can be
// settled client-side. So it only ever UNDER-collapses: it never reports two
// genuinely distinct directories as the same (no false rejection), but a config
// that hits one of those residuals can still slip through, which is the
// operator's responsibility (documented in docs/EXCHANGE_REFERENCE.md).
export function pathsResolveToSameDir(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const folded = p.replace(/\\/g, "/");
    const absolute = folded.startsWith("/");
    const segments = folded.split("/").filter((s) => s !== "" && s !== ".");
    return (absolute ? "/" : "") + segments.join("/");
  };
  return norm(a) === norm(b);
}
