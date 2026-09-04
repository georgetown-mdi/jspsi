import { UsageError } from "@psilink/core";

// The input contract `psilink doctor` reads. It is the environment, not flags:
// the caller is the Windows file-drop setup script (and the host-side launcher
// that follows it), which already passes these names to the container, and the
// password must not become an argv value that every `ps` on the machine can
// read. Keeping the whole set in one place means the non-secret fields cannot
// drift onto the command line one at a time and take the password with them.

/** The SMB dialects the setup script offers to pin. */
export const SMB_DIALECTS = ["SMB3", "SMB2", "NT1"] as const;

/** A pinned dialect, or `""` to let client and server negotiate. */
export type SmbDialect = (typeof SMB_DIALECTS)[number] | "";

/** Everything `doctor probe` needs, validated. Absent optional values are `""`. */
export interface SmbProbeInput {
  server: string;
  share: string;
  /** Subdirectory under the share the exchange runs in; `""` for the share root. */
  subdirectory: string;
  username: string;
  domain: string;
  password: string;
  dialect: SmbDialect;
  /** Filename of the marker to leave for a later `doctor mount`; `""` to skip. */
  marker: string;
  /** Per-run nonce written into the marker; `""` to skip the cross-check. */
  token: string;
}

/** Everything `doctor mount` needs beyond the directory itself. */
export interface SmbMountInput {
  marker: string;
  token: string;
}

/**
 * Characters that must not appear in a value written into the smbclient
 * credentials file. That file is `name=value` lines, so a newline in the
 * username, domain, or password would inject a line of its own -- silently
 * replacing the credential a later line was meant to set.
 */
const CREDENTIAL_FIELD_FORBIDDEN = /[\r\n]/;

/** A control character anywhere in a value that reaches an argv element. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * A marker filename. It is interpolated into an smbclient `-c` command string,
 * which smbclient splits on semicolons even inside a quoted argument, so the
 * accepted set is narrowed to characters that cannot end a command or begin
 * another one. The same restriction keeps it a plain filename on the mount side.
 */
const MARKER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A per-run nonce: it shares the marker's `-c` exposure and is also matched as a
 * literal against the marker's contents.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Every field but the password is an identifier the caller assembles, so
 * surrounding whitespace is a passing artifact rather than part of the value;
 * the password is read exactly as given, since a space can be part of one. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string {
  return (env[name] ?? "").trim();
}

function rejectIf(
  condition: boolean,
  problems: string[],
  message: string,
): void {
  if (condition) problems.push(message);
}

function assertNoProblems(problems: string[]): void {
  if (problems.length === 0) return;
  throw new UsageError(
    `psilink doctor cannot run with the environment it was given: ` +
      problems.join("; "),
  );
}

/**
 * Read and validate the `doctor probe` inputs from `env`.
 *
 * @throws {UsageError} naming every missing or malformed variable at once, so a
 * caller fixes them in one pass rather than one run per variable.
 * @internal exported for testing
 */
export function readSmbProbeInput(env: NodeJS.ProcessEnv): SmbProbeInput {
  const server = readEnv(env, "SMB_SERVER");
  const share = readEnv(env, "SMB_SHARE");
  const subdirectory = readEnv(env, "SMB_PATH");
  const username = readEnv(env, "SMB_USER");
  const domain = readEnv(env, "SMB_DOMAIN");
  const password = env["SMB_PASS"] ?? "";
  const dialect = readEnv(env, "SMB_DIALECT");
  const marker = readEnv(env, "SMB_MARKER");
  const token = readEnv(env, "SMB_TOKEN");

  const problems: string[] = [];
  for (const [name, value] of [
    ["SMB_SERVER", server],
    ["SMB_SHARE", share],
    ["SMB_USER", username],
  ] as const)
    rejectIf(value === "", problems, `${name} is not set`);

  // The server and share are joined into a single `//server/share` argv element,
  // so a separator inside either one silently re-points the connection; a
  // leading dash would make smbclient read the element as an option.
  for (const [name, value] of [
    ["SMB_SERVER", server],
    ["SMB_SHARE", share],
  ] as const) {
    rejectIf(
      /[/\\]/.test(value),
      problems,
      `${name} must not contain a path separator`,
    );
    rejectIf(
      value.startsWith("-"),
      problems,
      `${name} must not begin with '-'`,
    );
    rejectIf(
      CONTROL_CHARACTERS.test(value),
      problems,
      `${name} must not contain control characters`,
    );
  }
  // The subdirectory is passed as smbclient's `-D` argument rather than a `cd`
  // command for the reason the setup script gives: `-c` is split on semicolons
  // even inside a quoted argument, so a folder legitimately named "q3;final"
  // would be reported missing and a crafted one could append commands of its
  // own. As its own argv element it needs no such restriction, only to stay
  // printable.
  rejectIf(
    CONTROL_CHARACTERS.test(subdirectory),
    problems,
    "SMB_PATH must not contain control characters",
  );

  for (const [name, value] of [
    ["SMB_USER", username],
    ["SMB_DOMAIN", domain],
    ["SMB_PASS", password],
  ] as const)
    rejectIf(
      CREDENTIAL_FIELD_FORBIDDEN.test(value),
      problems,
      `${name} must not contain a line break`,
    );

  rejectIf(
    dialect !== "" && !(SMB_DIALECTS as readonly string[]).includes(dialect),
    problems,
    `SMB_DIALECT must be one of ${SMB_DIALECTS.join(", ")}`,
  );
  rejectIf(
    marker !== "" && !MARKER_PATTERN.test(marker),
    problems,
    "SMB_MARKER must be a plain filename (letters, digits, dot, dash, underscore)",
  );
  rejectIf(
    token !== "" && !TOKEN_PATTERN.test(token),
    problems,
    "SMB_TOKEN must be letters, digits, dash, or underscore",
  );
  assertNoProblems(problems);

  return {
    server,
    share,
    subdirectory,
    username,
    domain,
    password,
    dialect: dialect as SmbDialect,
    marker,
    token,
  };
}

/**
 * Read and validate the `doctor mount` inputs from `env`. Both are optional:
 * without them the mount run performs its write, exclusive-create, and rename
 * checks and reports the marker cross-check as skipped.
 *
 * @throws {UsageError} on a malformed marker name or token.
 * @internal exported for testing
 */
export function readSmbMountInput(env: NodeJS.ProcessEnv): SmbMountInput {
  const marker = readEnv(env, "SMB_MARKER");
  const token = readEnv(env, "SMB_TOKEN");
  const problems: string[] = [];
  rejectIf(
    marker !== "" && !MARKER_PATTERN.test(marker),
    problems,
    "SMB_MARKER must be a plain filename (letters, digits, dot, dash, underscore)",
  );
  rejectIf(
    token !== "" && !TOKEN_PATTERN.test(token),
    problems,
    "SMB_TOKEN must be letters, digits, dash, or underscore",
  );
  assertNoProblems(problems);
  return { marker, token };
}
