import type { JobHandoff, JobHandoffTemplate } from "@jobs/handoff";

/**
 * The browser-side reader for `GET /api/jobs/:jobId/handoff`: the recurring-run
 * hand-off the console shows after a completed exchange. It is purely
 * informational -- a failure resolves to null and the panel renders nothing rather
 * than surfacing an error -- so every non-2xx, network error, or malformed body
 * fails safe to null.
 */

/** Fetch the hand-off for a job, or null on any failure. Injectable `fetchImpl`
 * for the tests; the default hits the real same-origin endpoint. */
export async function fetchRecurringHandoff(
  jobId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<JobHandoff | null> {
  try {
    const response = await fetchImpl(`/api/jobs/${jobId}/handoff`, {
      method: "GET",
    });
    if (!response.ok) return null;
    return parseHandoff(await response.json());
  } catch {
    return null;
  }
}

/**
 * Validate a hand-off response body into a {@link JobHandoff}, or null when it is
 * not a well-formed hand-off -- a partial or ill-formed body renders nothing
 * rather than a half-built panel. The template is discriminated on `kind`: a
 * `config` carries a `yaml` string, a `command` carries an `argv` array of
 * strings.
 *
 * @internal exported for the unit test.
 */
export function parseHandoff(body: unknown): JobHandoff | null {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return null;
  const { mode, channel, usedKeyFile, credentialPasted, template } =
    body as Record<string, unknown>;
  if (mode !== "exchange" && mode !== "zeroSetup") return null;
  if (channel !== "sftp" && channel !== "filedrop") return null;
  if (typeof usedKeyFile !== "boolean") return null;
  if (typeof credentialPasted !== "boolean") return null;
  const parsedTemplate = parseTemplate(template);
  if (parsedTemplate === null) return null;
  return {
    mode,
    channel,
    usedKeyFile,
    credentialPasted,
    template: parsedTemplate,
  };
}

function parseTemplate(value: unknown): JobHandoffTemplate | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const { kind } = value as Record<string, unknown>;
  if (kind === "config") {
    const { yaml } = value as { yaml?: unknown };
    return typeof yaml === "string" && yaml.length > 0
      ? { kind: "config", yaml }
      : null;
  }
  if (kind === "command") {
    const { argv } = value as { argv?: unknown };
    if (
      !Array.isArray(argv) ||
      argv.length === 0 ||
      !argv.every((token): token is string => typeof token === "string")
    )
      return null;
    return { kind: "command", argv };
  }
  return null;
}

/**
 * Join a command's argv tokens into one copy-pasteable line, single-quoting any
 * token that carries a space or a shell metacharacter so a value like a
 * multi-word `--identity=` label survives the copy intact. A token with no such
 * character is emitted bare. The tokens are server-composed and secret-free (the
 * connection URL, portable flags, and placeholders), so this is display shaping,
 * not a security boundary.
 */
export function shellJoinCommand(argv: ReadonlyArray<string>): string {
  return argv.map(shellQuoteToken).join(" ");
}

const SHELL_SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellQuoteToken(token: string): string {
  if (token.length > 0 && SHELL_SAFE_TOKEN.test(token)) return token;
  return `'${token.replace(/'/g, "'\\''")}'`;
}
