/**
 * How a job route describes a body its schema rejected: a field path and a fixed
 * shape reason, never a byte the submitter chose. Every route that answers a
 * rejected body with a message composes it here, so one cannot come to echo more
 * than another.
 *
 * This module imports nothing else from the job API: it is a leaf both the
 * route-support module (used by handlers) and the job manager's validation
 * modules import, and those two already depend on each other.
 */

/**
 * The part of a schema issue these formatters read: the machine code, the field
 * path, and the schema's own reason text. Structural, so a zod issue from any of
 * the job bodies satisfies it.
 */
interface JobSchemaIssue {
  code: string;
  path: ReadonlyArray<PropertyKey>;
  message: string;
}

/**
 * The reason an unrecognized-key rejection has. It is the one issue whose
 * own message quotes a CLIENT-chosen string (`Unrecognized keys: "..."`), and
 * a key name is as much the submitter's bytes as a value, so this fixed
 * reason replaces it. The bodies are strict objects, so the caller only needs
 * to know a key they sent is not modeled, not its spelling.
 */
const UNRECOGNIZED_KEY_REASON = "unrecognized key";

/** The reason clause for one issue: the schema's own shape reason, or the fixed
 * {@link UNRECOGNIZED_KEY_REASON} for the one code whose message quotes the
 * caller. */
function issueReason(issue: JobSchemaIssue): string {
  return issue.code === "unrecognized_keys"
    ? UNRECOGNIZED_KEY_REASON
    : issue.message;
}

/**
 * Format a rejected body's first schema issue as `<field>: <reason>` -- the form
 * a route uses when the parse ran over the request body itself, so an issue with
 * no path is the body's own.
 *
 * A failed parse reports at least one issue, so an empty list is an impossible
 * state rather than a formattable one: it throws instead of reading through it,
 * which fails the route loudly rather than composing a message out of nothing.
 */
export function formatFirstIssue(
  issues: ReadonlyArray<JobSchemaIssue>,
): string {
  if (issues.length === 0)
    throw new Error("a rejected body carried no schema issue to format");
  const issue = issues[0];
  const field =
    issue.path.length > 0 ? issue.path.map(String).join(".") : "body";
  return `${field}: ${issueReason(issue)}`;
}

/**
 * Format every issue of a rejected body as one `<root>[.<path>]: <reason>`
 * message -- the form the authoring path uses, where an operator correcting a
 * connection is served by seeing each field at fault rather than only the first.
 * `root` names the sub-object the parse ran over (`server`, `connection`,
 * `connection.credential`), which the issue paths are relative to.
 *
 * The same impossible-state rule as {@link formatFirstIssue}: an empty list
 * throws rather than composing a message out of nothing.
 */
export function formatIssues(
  issues: ReadonlyArray<JobSchemaIssue>,
  root: string,
): string {
  if (issues.length === 0)
    throw new Error("a rejected body carried no schema issue to format");
  return issues
    .map((issue) => {
      const fieldPath = [root, ...issue.path.map(String)].join(".");
      return `${fieldPath}: ${issueReason(issue)}`;
    })
    .join("; ");
}
