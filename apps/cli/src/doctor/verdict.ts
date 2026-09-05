// The verdict `psilink doctor` produces, in both of its renderings: the
// machine-readable JSON a launcher consumes and the human-readable check lines
// an operator reads. The two are built from one record set so a check cannot be
// reported one way to a script and another way to a person.

import { redactPrivateKeyMaterial } from "@psilink/core";

import { asciiSafeJsonLine } from "../util/jsonLine";

/**
 * Schema version of the `--json` verdict. A consumer reads this field first and
 * refuses a version it does not know; every additive field is compatible within
 * a version, and a removed or re-meaned field takes a new one.
 */
export const DOCTOR_VERDICT_VERSION = 1;

/** Which check set produced a verdict. */
export type DoctorMode = "probe" | "mount";

/**
 * The outcome of a single check. `warn` is a check that ran and does not block
 * an exchange, but has a meaning and an action the operator should read.
 * `skipped` covers both "an earlier check failed so this one never ran" and
 * "this check does not apply to the inputs given", which the check's `meaning`
 * distinguishes.
 */
export type DoctorCheckStatus = "ok" | "warn" | "fail" | "skipped";

/**
 * The roll-up a caller keys on: `ok` (nothing blocks an exchange here),
 * `fix_and_retry` (a check returned an actionable verdict; change something and
 * run again), `fatal` (the checks could not be run at all, so nothing was
 * established either way).
 */
export type DoctorOverall = "ok" | "fix_and_retry" | "fatal";

// Type aliases, not interfaces, for the emitted-document shapes: an object type
// alias has the implicit index signature asciiSafeJsonLine's JsonLineObject
// parameter needs, an interface does not. verdictOf's explicit field picking
// withholds a check record's human-only fields, pinned at compile time by the
// inner `satisfies DoctorCheck`; the emitted-document equality test covers
// what a `checks: report.checks` passthrough would miss.

/** One check as it appears in the `--json` verdict. */
export type DoctorCheck = {
  /** Stable identifier; the id set per mode is fixed and ordered. */
  id: string;
  status: DoctorCheckStatus;
  /** What the outcome means, when there is something to say about it. */
  meaning?: string;
  /** What to do about it. */
  action?: string;
};

/**
 * A check plus the fields that exist only for the human rendering. `summary` is
 * the headline line; `detail` is the tool output behind a failure, which is
 * server-controlled text and so, by design, is absent from the JSON verdict --
 * a launcher gets the classified `meaning`/`action`, not raw bytes to re-render.
 */
export interface DoctorCheckRecord extends DoctorCheck {
  summary: string;
  detail?: string;
  /**
   * Set on a failure that stopped the run rather than one it ran and returned a
   * verdict on; it is what makes the overall `fatal`.
   */
  blocksRun?: boolean;
}

/** The full result of one run, before rendering. */
export interface DoctorReport {
  mode: DoctorMode;
  checks: DoctorCheckRecord[];
}

/** The `--json` document. */
export type DoctorVerdict = {
  version: number;
  mode: DoctorMode;
  overall: DoctorOverall;
  checks: DoctorCheck[];
};

// Record builders shared by both check sets.

/**
 * A check that passed and asks nothing of the operator. It cannot have an
 * `action`: a passing check that has one is a `warn`, which is what both
 * renderings key on.
 */
export function ok(
  id: string,
  summary: string,
  extra: Omit<Partial<DoctorCheckRecord>, "action" | "status"> = {},
): DoctorCheckRecord {
  return { id, status: "ok", summary, ...extra };
}

/** A check that passed and still has something for the operator to do. */
export function warn(
  id: string,
  summary: string,
  meaning: string,
  action: string,
): DoctorCheckRecord {
  return { id, status: "warn", summary, meaning, action };
}

export function fail(
  id: string,
  summary: string,
  meaning: string,
  action: string,
  extra: Partial<DoctorCheckRecord> = {},
): DoctorCheckRecord {
  return { id, status: "fail", summary, meaning, action, ...extra };
}

export function skipped(
  id: string,
  summary: string,
  extra: Partial<DoctorCheckRecord> = {},
): DoctorCheckRecord {
  return { id, status: "skipped", summary, ...extra };
}

/**
 * Exit code per overall verdict, the closed set a caller may see from a run
 * that produced a verdict. Below 125 -- Docker's own reserved range -- and
 * following BSD `sysexits` for the two nonzero values. A usage error is not
 * in this set: it exits 64 and prints no verdict, because the checks never
 * ran. See docs/spec/CLI_DOCTOR.md, "Exit codes".
 */
export const DOCTOR_EXIT_CODE: Record<DoctorOverall, number> = {
  ok: 0,
  fix_and_retry: 78,
  fatal: 69,
};

/**
 * Roll the individual checks up. A failure that stopped the run (`blocksRun`)
 * outranks one it ran and returned a verdict on, because the two ask different
 * things of the caller: the first has no ACTION to follow.
 */
export function overallOf(report: DoctorReport): DoctorOverall {
  const failures = report.checks.filter((check) => check.status === "fail");
  if (failures.some((check) => check.blocksRun === true)) return "fatal";
  return failures.length > 0 ? "fix_and_retry" : "ok";
}

/** Build the `--json` document from a report, dropping the human-only fields. */
export function verdictOf(report: DoctorReport): DoctorVerdict {
  return {
    version: DOCTOR_VERDICT_VERSION,
    mode: report.mode,
    overall: overallOf(report),
    checks: report.checks.map(
      (check) =>
        ({
          id: check.id,
          status: check.status,
          ...(check.meaning !== undefined ? { meaning: check.meaning } : {}),
          ...(check.action !== undefined ? { action: check.action } : {}),
        }) satisfies DoctorCheck,
    ),
  } satisfies DoctorVerdict;
}

/**
 * The single stdout line the `--json` form emits, kept printable ASCII by
 * {@link asciiSafeJsonLine} despite operator-supplied `SMB_*` values and the
 * smbclient NT_STATUS token reaching it unescaped. See docs/spec/CLI_DOCTOR.md,
 * "The line is printable ASCII", and CONTRIBUTING.md, "Operator-facing
 * escaping".
 */
export function verdictJson(report: DoctorReport): string {
  return asciiSafeJsonLine(verdictOf(report));
}

/**
 * Bounds on the tool output held behind a failing check. smbclient can answer
 * with a whole share listing, and an operator is asked to send this output on to
 * whoever is helping them, so the excerpt is capped rather than sprayed.
 */
const MAX_DETAIL_LINES = 24;
const MAX_DETAIL_CHARS = 2000;

/**
 * Redaction runs HERE, over the whole detail, rather than over the lines this
 * returns: splitting first would leave a multi-line private-key block's
 * `BEGIN` marker on its own line and the body would render verbatim. See
 * docs/spec/CLI_DOCTOR.md, "What the verdict withholds", for the bounds and
 * the redact-before-slice ordering.
 *
 * @internal exported for testing
 */
export function clampDetail(detail: string): string[] {
  const redacted = redactPrivateKeyMaterial(detail);
  const truncated = redacted.slice(0, MAX_DETAIL_CHARS);
  const lines = truncated.split("\n").filter((line) => line.trim().length > 0);
  const kept = lines.slice(0, MAX_DETAIL_LINES);
  // Against the REDACTED length, not the raw one: the replacement is shorter
  // than the shortest marker it stands in for, so measuring the raw input would
  // report a cut whenever a block was replaced and nothing was dropped.
  if (kept.length < lines.length || truncated.length < redacted.length)
    kept.push("... (output truncated)");
  return kept;
}

const WRAP_COLUMNS = 76;

// Wrap `text` under a fixed-width label so the continuation lines align beneath
// the first word rather than under the label, the shape the setup script's
// MEANING/ACTION blocks have and operators are asked to read back.
//
// Redaction runs HERE, over the whitespace-normalized text, ahead of the re-flow
// -- normalizing before redacting matters, not the reverse, or a marker whose
// separators are non-ASCII whitespace would be re-formed post-redaction. See
// docs/spec/CHANNEL_SECURITY.md, "Display sanitization escape format".
function wrapLabelled(label: string, text: string): string[] {
  const indent = " ".repeat(label.length);
  const lines: string[] = [];
  let current = label;
  const flowed = text
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .join(" ");
  for (const word of redactPrivateKeyMaterial(flowed)
    .split(" ")
    .filter((w) => w.length > 0)) {
    if (
      current.length > label.length &&
      current.length + 1 + word.length > WRAP_COLUMNS
    ) {
      lines.push(current);
      current = indent;
    }
    current =
      current === label || current === indent
        ? current + word
        : `${current} ${word}`;
  }
  if (current.trim().length > 0) lines.push(current);
  return lines;
}

/**
 * The label a check's headline has, one per status. A check that passed but
 * still asks something of the operator -- a share that works for an exchange
 * only with `--lockless-rendezvous`, a share nearly out of space -- is a `warn`
 * and is labelled WARN, keeping the setup script's distinction between "this
 * stops you" and "this is worth knowing" in both renderings.
 */
function labelOf(check: DoctorCheckRecord): string {
  if (check.status === "fail") return "FAIL";
  if (check.status === "warn") return "WARN";
  if (check.status === "skipped") return "SKIP";
  return "OK";
}

/** Render the human-readable check lines, in check order. */
export function verdictLines(report: DoctorReport): string[] {
  const lines: string[] = [];
  for (const check of report.checks) {
    lines.push(`${labelOf(check)}: ${check.summary}`);
    if (check.detail !== undefined)
      for (const line of clampDetail(check.detail)) lines.push(`      ${line}`);
    if (check.meaning !== undefined)
      lines.push(...wrapLabelled("MEANING: ", check.meaning));
    if (check.action !== undefined)
      lines.push(...wrapLabelled("ACTION:  ", check.action));
  }
  const overall = overallOf(report);
  lines.push("");
  lines.push(
    overall === "ok"
      ? "ALL CHECKS PASSED"
      : overall === "fix_and_retry"
        ? "NOT READY YET -- follow the ACTION lines above and run this again."
        : "COULD NOT RUN THE CHECKS -- nothing was established either way.",
  );
  return lines;
}
