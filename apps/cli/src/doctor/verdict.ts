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

/** Which battery produced a verdict. */
export type DoctorMode = "probe" | "mount";

/**
 * The outcome of a single check. `warn` is a check that ran and does not block
 * an exchange, but carries a meaning and an action the operator should read.
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

// The two shapes the emitted document is made of are type aliases rather than
// interfaces for one reason: an object type alias carries the implicit index
// signature asciiSafeJsonLine's JsonLineObject parameter needs, an interface
// does not. What withholds a check record's human-only fields is verdictOf's
// explicit field picking: the `satisfies` annotations pin that at compile time,
// and the emitted-document equality test covers what they miss -- a
// `checks: report.checks` passthrough typechecks clean.

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
 * server-controlled text and so is deliberately absent from the JSON verdict --
 * a launcher gets the classified `meaning`/`action`, not raw bytes to re-render.
 */
export interface DoctorCheckRecord extends DoctorCheck {
  summary: string;
  detail?: string;
  /**
   * Set on a failure that stopped the battery from running rather than one it
   * ran and returned a verdict on; it is what makes the overall `fatal`.
   */
  blocksRun?: boolean;
}

/** The full result of one battery, before rendering. */
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

// Record builders shared by both batteries.

/**
 * A check that passed and asks nothing of the operator. It cannot carry an
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
 * Exit code per overall verdict, the closed set a caller may see from a run that
 * produced a verdict. All are below 125, which Docker reserves for its own
 * failures to start a container -- a caller running the doctor in a container
 * can therefore tell "Docker could not run it" from any verdict this command
 * reaches. A usage error (a missing or malformed input) is not in this set: it
 * exits 64 like every other psilink usage error and prints no verdict, because
 * the checks never ran.
 *
 * The two nonzero values follow BSD `sysexits`, as the rest of the CLI does:
 * `fix_and_retry` is a configuration the operator changes (EX_CONFIG), and
 * `fatal` is something the doctor depends on not being available (EX_UNAVAILABLE
 * -- the smbclient binary, or the mounted directory itself).
 */
export const DOCTOR_EXIT_CODE: Record<DoctorOverall, number> = {
  ok: 0,
  fix_and_retry: 78,
  fatal: 69,
};

/**
 * Roll the individual checks up. A failure that stopped the battery running
 * (`blocksRun`) outranks one it ran and returned a verdict on, because the two
 * ask different things of the caller: the first has no ACTION to follow.
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
 * The single stdout line the `--json` form emits. A check's `meaning` and
 * `action` interpolate the operator's own `SMB_*` values -- `SMB_PATH` reaches
 * one verbatim, and its validation rejects only the C0 controls and DEL, so the
 * C1 range, U+2028/U+2029 and an astral character all pass through -- and the
 * line therefore rides {@link asciiSafeJsonLine}, which leaves every byte of it
 * printable ASCII while the keys, the value types, and the parsed values stay
 * exactly what `JSON.stringify` alone produces. The escapes are JSON's own, so
 * this is no second escaping altitude: a launcher that renders a parsed field
 * to a human still escapes it once, at its own sink (see CONTRIBUTING.md,
 * Operator-facing escaping).
 */
export function verdictJson(report: DoctorReport): string {
  return asciiSafeJsonLine(verdictOf(report));
}

/**
 * Bounds on the tool output carried behind a failing check. smbclient can answer
 * with a whole share listing, and an operator is asked to send this output on to
 * whoever is helping them, so the excerpt is capped rather than sprayed.
 */
const MAX_DETAIL_LINES = 24;
const MAX_DETAIL_CHARS = 2000;

/**
 * Redaction runs HERE, over the whole detail, rather than over the lines this
 * returns: a private-key block arrives from the tool in its canonical multi-line
 * form, so splitting first leaves every line but the `BEGIN` one carrying no
 * marker, and the body renders verbatim. The rendering escapes and redacts again
 * per rendered line, but that pass sees one line at a time and so cannot catch a
 * body this one leaves behind; the rendering's sink is the CLI's plain-line
 * writer, which bypasses core's prefixer, so there is no third pass behind
 * either. Redacting before the slice is safe for the budget because the
 * replacement never lengthens its input, and failing closed past a dangling
 * `BEGIN` costs only more tool output -- the check's own MEANING and ACTION text
 * is composed as separate lines.
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
// Redaction runs HERE, over the whitespace-normalized text -- the exact text
// the re-flow emits -- for the reason clampDetail redacts ahead of its split:
// a marker straddling a wrap would reach the rendering's per-line pass as two
// lines that neither match, and the material behind it would render verbatim.
// Normalizing BEFORE redacting is load-bearing: the re-flow collapses every
// whitespace class to ASCII spaces, so a marker whose internal separators are
// non-ASCII whitespace would be re-formed by the normalization after a
// raw-text redaction had already run. The fail-closed reach is one labelled
// block -- MEANING and ACTION are wrapped separately -- and the label is
// composed outside the redacted text, so a dangling BEGIN takes the rest of
// its own block and reaches neither the label nor the sibling block.
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
 * The label a check's headline carries, one per status. A check that passed but
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
