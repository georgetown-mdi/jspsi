import path from "node:path";
import { pathToFileURL } from "node:url";

/**
 * The absolute path this platform maps a POSIX-shaped fixture path to: the
 * path itself off Windows, and the same directories under the current drive on
 * it (`/mnt/share` -> `C:\mnt\share`).
 *
 * A `file://` URL naming no drive has no Windows path at all, so a fixture
 * spelling one inline states a POSIX-only fact. Nothing in these fixtures
 * exists on disk -- the connection builders only parse -- so the drive the
 * current directory sits on is an arbitrary but stable choice.
 *
 * @internal test-only helper
 */
export function platformAbsolutePath(posixPath: string): string {
  return path.resolve(posixPath);
}

/**
 * A `file://` URL naming {@link platformAbsolutePath}'s result, in the form
 * this platform's URL-to-path mapping accepts.
 *
 * @internal test-only helper
 */
export function platformFileUrl(posixPath: string): URL {
  return pathToFileURL(platformAbsolutePath(posixPath));
}

/**
 * A local path as the display sanitizer renders it: unchanged off Windows,
 * and with every separator doubled on it, since the escape doubles a literal
 * backslash so that an escape it emits cannot be spelled by a value's own
 * bytes (docs/spec/CHANNEL_SECURITY.md, Display sanitization escape format).
 *
 * An assertion that a message names a path compares against this rather than
 * the path itself: the raw form is what the operator typed, the escaped form
 * is what the message shows.
 *
 * @internal test-only helper
 */
export function pathAsDisplayed(localPath: string): string {
  return localPath.replaceAll("\\", "\\\\");
}

/**
 * The same directory as {@link platformFileUrl}, spelled with the `localhost`
 * authority a `file://` URL also permits.
 *
 * @internal test-only helper
 */
export function platformLocalhostFileUrl(posixPath: string): URL {
  return new URL(`file://localhost${platformFileUrl(posixPath).pathname}`);
}
