import {
  MAX_JOB_HANDOFF_RESPONSE_BYTES,
  readBoundedJson,
} from "@psi/jobClient/jobApiBody";

import type {
  HandoffSigningSetting,
  JobHandoff,
  JobHandoffTemplate,
} from "@jobs/handoff";

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
    return parseHandoff(
      await readBoundedJson(response, MAX_JOB_HANDOFF_RESPONSE_BYTES),
    );
  } catch {
    return null;
  }
}

/**
 * Validate a hand-off response body into a {@link JobHandoff}, or null when it is
 * not a well-formed hand-off -- a partial or ill-formed body renders nothing
 * rather than a half-built panel. The template is discriminated on `kind`: a
 * `config` holds a `yaml` string, and both kinds hold the command they run as
 * an `argv` array of strings.
 *
 * @internal exported for the unit test.
 */
export function parseHandoff(body: unknown): JobHandoff | null {
  if (body === null || typeof body !== "object" || Array.isArray(body))
    return null;
  const {
    mode,
    channel,
    usedKeyFile,
    keyFileBesideConfiguration,
    credentialPasted,
    usedSigningIdentity,
    signingSettingsToSet,
    template,
  } = body as Record<string, unknown>;
  if (mode !== "exchange" && mode !== "zeroSetup") return null;
  if (channel !== "sftp" && channel !== "filedrop") return null;
  if (typeof usedKeyFile !== "boolean") return null;
  if (typeof keyFileBesideConfiguration !== "boolean") return null;
  if (typeof credentialPasted !== "boolean") return null;
  if (typeof usedSigningIdentity !== "boolean") return null;
  const parsedSigningSettings = parseSigningSettings(signingSettingsToSet);
  if (parsedSigningSettings === null) return null;
  const parsedTemplate = parseTemplate(template);
  if (parsedTemplate === null) return null;
  return {
    mode,
    channel,
    usedKeyFile,
    keyFileBesideConfiguration,
    credentialPasted,
    usedSigningIdentity,
    ...(parsedSigningSettings.length > 0
      ? { signingSettingsToSet: parsedSigningSettings }
      : {}),
    template: parsedTemplate,
  };
}

/** What the panel asks the operator to set each missing signing setting to. */
const SIGNING_SETTING_REMEDY: Record<HandoffSigningSetting, string> = {
  "linkage_terms.identity": "linkage_terms.identity to this party's name",
  "signing.identity_file":
    "signing.identity_file to the path of your signing identity file",
};

/** The settings list a hand-off may state, with absent read as none and
 * anything else as a malformed body (null). */
function parseSigningSettings(
  value: unknown,
): Array<HandoffSigningSetting> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const settings: Array<HandoffSigningSetting> = [];
  for (const setting of value) {
    if (
      typeof setting !== "string" ||
      !Object.hasOwn(SIGNING_SETTING_REMEDY, setting)
    )
      return null;
    settings.push(setting as HandoffSigningSetting);
  }
  return settings;
}

/**
 * The caveat for a `certificate`-mode configuration missing settings psilink
 * refuses to run it without, naming each setting and what to set it to.
 */
export function unsetSigningSettingsCaveat(
  settings: ReadonlyArray<HandoffSigningSetting>,
): string {
  return (
    "This configuration signs receipts with a certificate (signing.mode: " +
    `certificate) but does not set ${settings.join(" or ")}, so psilink ` +
    "refuses to run it. Set " +
    settings.map((setting) => SIGNING_SETTING_REMEDY[setting]).join(" and ") +
    ", or set signing.mode to none to run unsigned."
  );
}

function parseTemplate(value: unknown): JobHandoffTemplate | null {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const { kind, argv } = value as { kind?: unknown; argv?: unknown };
  if (!isCommandArgv(argv)) return null;
  if (kind === "config") {
    const { yaml } = value as { yaml?: unknown };
    return typeof yaml === "string" && yaml.length > 0
      ? { kind: "config", yaml, argv }
      : null;
  }
  if (kind === "command") return { kind: "command", argv };
  return null;
}

function isCommandArgv(argv: unknown): argv is Array<string> {
  return (
    Array.isArray(argv) &&
    argv.length > 0 &&
    argv.every((token): token is string => typeof token === "string")
  );
}

/**
 * Join a command's argv tokens into one copy-pasteable line, single-quoting any
 * token with a space or a shell metacharacter so a value like a
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

/**
 * Join a command's argv tokens into one line quoted for cmd.exe, for the Windows
 * Task Scheduler example. cmd.exe does not honor the POSIX single quotes {@link
 * shellJoinCommand} emits, so a token with a space or a cmd metacharacter is
 * wrapped in double quotes (any internal `"` doubled) and a token with none is
 * emitted bare. Display shaping for the same server-composed, secret-free tokens,
 * not a security boundary.
 */
export function windowsJoinCommand(argv: ReadonlyArray<string>): string {
  return argv.map(windowsQuoteToken).join(" ");
}

const CMD_NEEDS_QUOTING = /[\s"&|<>^()%!]/;

function windowsQuoteToken(token: string): string {
  if (token.length > 0 && !CMD_NEEDS_QUOTING.test(token)) return token;
  return `"${token.replace(/"/g, '""')}"`;
}
