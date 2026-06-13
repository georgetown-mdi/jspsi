import { sanitizeForDisplay } from "./sanitizeForDisplay";

/**
 * Render an invitation decode/validation failure concisely for operator-facing
 * display. {@link decodeInvitation} (and the invitation schema it runs) throws a
 * `ZodError` on schema-validation failure, whose `.message` is a multi-line JSON
 * dump of every issue; surface the first issue as `<path>: <message>` with an
 * `(and N more)` suffix instead. Other failures (checksum, JSON, base64) are
 * plain `Error`s, whose `.message` passes through unchanged; any other thrown
 * value renders as `String(err)`.
 *
 * Path components are escaped via {@link sanitizeForDisplay}: a Zod path can name
 * a partner-controlled object key in the general case (the invitation is crafted
 * by the inviting party), not only a fixed schema field, so a key carrying
 * control/ANSI or deceptive-Unicode bytes must not reach the operator raw. The
 * issue `message` is relayed as is, because the one message that echoes a partner
 * value -- the unrecognized-endpoint-key list -- is escaped at its source in
 * `endpointKeyError` (config/invitation.ts), kept there so this concise relay
 * does not truncate that long guidance text.
 *
 * Shared by the CLI accept command and the web accept route so both collapse the
 * same failure into the same readable one-liner. The helper is self-contained on
 * the escaping it owns -- it escapes every path component it interpolates rather
 * than relying on a surrounding sanitizer -- so a caller may display its result
 * directly without a further wrapping pass (which would double-escape the
 * already-escaped path components).
 *
 * @internal exported for testing
 */
export function describeDecodeError(err: unknown): string {
  if (err !== null && typeof err === "object" && "issues" in err) {
    const { issues } = err as {
      issues?: Array<{ path?: Array<PropertyKey>; message?: string }>;
    };
    if (Array.isArray(issues) && issues.length > 0) {
      const first = issues[0];
      const at =
        Array.isArray(first.path) && first.path.length > 0
          ? `${first.path.map((p) => sanitizeForDisplay(String(p))).join(".")}: `
          : "";
      const more = issues.length > 1 ? ` (and ${issues.length - 1} more)` : "";
      return `${at}${first.message ?? "schema validation failed"}${more}`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
