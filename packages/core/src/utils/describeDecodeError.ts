import {
  redactAndSanitizeForDisplay,
  redactPrivateKeyMaterial,
} from "./sanitizeErrorForDisplay";
import {
  boundRawFragmentForFit,
  clipToRenderedCost,
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  DEFAULT_MAX_DISPLAY_LENGTH,
} from "./sanitizeForDisplay";
import type { Displayable } from "./sanitizeForDisplay";

/**
 * One Zod issue-path segment, fitted to what a single value may render to.
 *
 * A segment can be an object key the inviting party wrote -- Zod's
 * `invalid_key` puts a rejected record key in the path verbatim -- and the path
 * LEADS the description, so an unfitted segment spends the whole budget of the
 * link that shows it and the refusal reason behind it is cut. Redacted before
 * the fit, never after: the fit appends a truncation marker, which a `BEGIN`
 * marker left dangling in the kept prefix would consume at the sink.
 *
 * Cut to a raw length before either treatment: on the wire linkage-terms route
 * the segment is a partner-chosen `transform.params` key bounded only by the
 * transport's frame cap, and the fit measures the whole escaped form of what it
 * is handed ({@link boundRawFragmentForFit}).
 */
const fittedPathSegment = (segment: PropertyKey): string =>
  clipToRenderedCost(
    redactPrivateKeyMaterial(
      boundRawFragmentForFit(String(segment), DEFAULT_MAX_DISPLAY_LENGTH),
    ),
    DEFAULT_MAX_DISPLAY_LENGTH,
  );

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
 * What it does own is the FIT: each path segment is bounded by
 * {@link fittedPathSegment}, and the rejected key names in the
 * unrecognized-endpoint-key message by `endpointKeyError`
 * (`config/invitation.ts`), so no fragment the inviting party chose can spend
 * the display budget the first-party reason beside it needs.
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
          ? `${first.path.map(fittedPathSegment).join(".")}: `
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
 *
 * Redacts as well as escapes, the pairing every display sink takes
 * ({@link redactAndSanitizeForDisplay}), applied here uniformly rather than on
 * a reading of which of today's decode failures can hold a file-derived value.
 * Each fragment the description names is redacted at its own fit, so the
 * fail-closed dangling rule has no partner-planted marker left to consume the
 * first-party text behind.
 */
export function describeDecodeError(err: unknown): Displayable {
  return redactAndSanitizeForDisplay(rawDecodeErrorDescription(err), {
    maxLength: COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  });
}
