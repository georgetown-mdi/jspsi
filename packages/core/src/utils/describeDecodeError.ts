import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  sanitizeForDisplay,
} from "./sanitizeForDisplay";
import type { Displayable } from "./sanitizeForDisplay";

/**
 * Render an invitation decode/validation failure concisely, composed RAW for
 * interpolation into an `Error` message or `cause`. {@link decodeInvitation}
 * (and the invitation schema it runs) throws a `ZodError` on schema-validation
 * failure, whose `.message` is a multi-line JSON dump of every issue; show the
 * first issue as `<path>: <message>` with an `(and N more)` suffix instead.
 * Other failures (checksum, JSON, base64) are plain `Error`s, whose `.message`
 * passes through unchanged; any other thrown value renders as `String(err)`.
 *
 * It escapes nothing. A Zod path can name a partner-controlled object key (the
 * invitation is crafted by the inviting party) and the unrecognized-endpoint-key
 * message echoes the rejected key names, so this description can hold
 * control/ANSI, bidi-override or zero-width bytes and reaches an operator only
 * through a boundary that escapes it: `sanitizeErrorForDisplay` where the
 * composed error is rendered, which is the assignment for a fragment bound for
 * an `Error` (CONTRIBUTING.md, Operator-facing escaping). A caller showing the
 * description WITHOUT composing an error takes {@link describeDecodeError}
 * instead, which escapes it once at that sink.
 *
 * A caller that also redacts (`redactPrivateKeyMaterial`) does so where it
 * interpolates this, before the sink's fail-closed dangling rule can consume
 * the first-party text composed behind a planted marker.
 */
export function rawDecodeErrorDescription(err: unknown): string {
  if (err !== null && typeof err === "object" && "issues" in err) {
    const { issues } = err as {
      issues?: Array<{ path?: Array<PropertyKey>; message?: string }>;
    };
    if (Array.isArray(issues) && issues.length > 0) {
      const first = issues[0];
      const at =
        Array.isArray(first.path) && first.path.length > 0
          ? `${first.path.map((p) => String(p)).join(".")}: `
          : "";
      const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
      return `${at}${first.message ?? "schema validation failed"}${more}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * {@link rawDecodeErrorDescription} escaped once, for a consumer whose own
 * render is the display sink: the web accept screen, which puts the result
 * straight into a React text node with no further pass. React neutralizes HTML
 * markup but not terminal-control, bidi-override or zero-width bytes, so the
 * escape has to happen here for that route.
 *
 * The {@link Displayable} brand is what keeps the two routes apart at compile
 * time: a display field declared as the brand cannot be filled from the raw
 * form, and a caller composing an `Error` takes the raw form because escaping
 * here and again at the renderer doubles every literal backslash on the way to
 * the operator.
 *
 * Capped at {@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH} rather than the
 * per-value default: the description is a COMPOSITION -- first-party guidance
 * (the endpoint-locator rejection above all) around the fragments it names --
 * and the per-value budget would cut that guidance short.
 */
export function describeDecodeError(err: unknown): Displayable {
  return sanitizeForDisplay(rawDecodeErrorDescription(err), {
    maxLength: COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  });
}
