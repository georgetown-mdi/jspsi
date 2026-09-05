import {
  CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_PEER_TIMEOUT_MS,
  DEFAULT_POLLING_FREQUENCY_MS,
  DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
  LOW_POLLING_FREQUENCY_WARN_MS,
  MAX_RECONNECT_ATTEMPTS,
  MAX_TIMEOUT_SECONDS,
} from "@psilink/core";

import type { JobExchangeOptions } from "@jobs/intentSchemas";

/**
 * The pure model behind the console's "Connection tuning" authoring card: how the
 * operator's polling, timeout, retry, and SFTP session-mode choices become the
 * tuning `options` a server job holds, what the card refuses before the run
 * starts, and the two advisories the CLI raises at run time raised here instead,
 * while the operator can still act on them.
 *
 * No React and no I/O, so the unit conversion, the emitted option block, and both
 * advisory triggers are the tested boundary. The values themselves are the CLI's:
 * the defaults and both advisory thresholds are core's exported constants, so the
 * console can neither drift from the command line nor invent a rule of its own.
 */

/**
 * The unit a duration field is authored in. The sets offered per field mirror the
 * CLI's own duration grammars: the poll interval takes the sub-second-capable set
 * (`--polling-frequency` accepts a millisecond suffix, because a demo against a
 * controlled server legitimately polls fast), the two timeouts the coarse set
 * their flags accept.
 */
export type DurationUnit = "ms" | "s" | "m" | "h";

const UNIT_MS: Record<DurationUnit, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/** The units the poll-interval field offers, sub-second included. */
export const POLL_INTERVAL_UNITS: ReadonlyArray<DurationUnit> = [
  "ms",
  "s",
  "m",
];

/** The units the two timeout fields offer. Milliseconds are absent by design: a
 * coarse duration flag cannot state one, so a zero-setup run could not hold
 * the value the operator authored. */
export const TIMEOUT_UNITS: ReadonlyArray<DurationUnit> = ["s", "m", "h"];

/**
 * One duration as the card holds it: the magnitude as raw field text (blank means
 * unset, so the field is left off entirely and core's default applies) and the
 * unit it is authored in. Holding the magnitude as text rather than a number is
 * what lets a half-typed or non-numeric value be reported as a form problem
 * instead of silently becoming `NaN` in an option block.
 */
export interface DurationField {
  magnitude: string;
  unit: DurationUnit;
}

/** The operator's authored connection-tuning choices for one exchange. */
export interface ConnectionTuningDraft {
  pollInterval: DurationField;
  peerTimeout: DurationField;
  serverConnectTimeout: DurationField;
  /** The retry budget as raw field text; blank means unset. Not a duration: it is
   * a count, exactly as the CLI's `--max-reconnect-attempts` is. */
  maxReconnectAttempts: string;
  connectionPerPoll: boolean;
}

/**
 * The card's starting state: every field unset and the SFTP session mode off,
 * which is the behaviour a console exchange has today. Each field's starting unit
 * is the one core's default for it reads naturally in, so an operator who types a
 * magnitude and nothing else authors a sensible scale.
 */
export const CONNECTION_TUNING_DEFAULT: ConnectionTuningDraft = {
  pollInterval: { magnitude: "", unit: "s" },
  peerTimeout: { magnitude: "", unit: "m" },
  serverConnectTimeout: { magnitude: "", unit: "s" },
  maxReconnectAttempts: "",
  connectionPerPoll: false,
};

/** Which of the card's controls the calling flow can hold. The SFTP session mode
 * is an sftp-only dialing choice -- a filedrop client holds no socket -- so the
 * intent's filedrop arms refuse it and the card withholds it there. */
export interface ConnectionTuningCapabilities {
  connectionPerPoll: boolean;
}

/** The capabilities of an sftp flow: every control the card offers applies. */
export const SFTP_CONNECTION_TUNING: ConnectionTuningCapabilities = {
  connectionPerPoll: true,
};

/** The capabilities of a shared-directory (filedrop) flow, whose connectionless
 * client has no session to cycle. */
export const FILEDROP_CONNECTION_TUNING: ConnectionTuningCapabilities = {
  connectionPerPoll: false,
};

/**
 * The value a duration field states, in milliseconds -- the unit the job intent
 * speaks throughout. `undefined` for a blank field (left unset), and `null` for a
 * magnitude that is not a positive integer, which {@link connectionTuningProblems}
 * reports rather than emitting.
 */
function durationMs(field: DurationField): number | undefined | null {
  const magnitude = field.magnitude.trim();
  if (magnitude === "") return undefined;
  if (!/^\d+$/.test(magnitude)) return null;
  const value = Number(magnitude);
  if (value <= 0) return null;
  const ms = value * UNIT_MS[field.unit];
  return Number.isSafeInteger(ms) ? ms : null;
}

/**
 * The longest wait either timeout field may state: core's seven-day
 * {@link MAX_TIMEOUT_SECONDS}, in the milliseconds the job intent speaks. Both
 * fields ride the CLI's `--peer-timeout` / `--connection-timeout` on a
 * zero-setup run, where the same ceiling is a usage error (exit 64); a
 * larger value here would create a job whose child exits immediately. The
 * poll interval takes no ceiling, matching `--polling-frequency`.
 */
const MAX_TIMEOUT_MS = MAX_TIMEOUT_SECONDS * 1000;

/**
 * A timeout field's value in milliseconds, held to {@link MAX_TIMEOUT_MS} on top
 * of {@link durationMs}'s shape rule. `null` for either refusal;
 * {@link connectionTuningProblems} distinguishes the two so the operator is told
 * which rule the value broke.
 */
function timeoutMs(field: DurationField): number | undefined | null {
  const ms = durationMs(field);
  if (typeof ms !== "number") return ms;
  return ms > MAX_TIMEOUT_MS ? null : ms;
}

/**
 * The retry budget the draft states, or `undefined` when blank. `null` for a value
 * that is not an integer within core's accepted range, reported as a form problem.
 * Zero is admissible and meaningful -- "connect once, do not reconnect" -- so this
 * is a nonnegative check, not a positive one, exactly as core's field is.
 */
function reconnectAttempts(raw: string): number | undefined | null {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= MAX_RECONNECT_ATTEMPTS ? value : null;
}

/**
 * The tuning `options` block a draft contributes to a job intent, or undefined
 * when the operator changed nothing (so the intent omits the block and the
 * composed config holds no `options` at all). A field the draft states
 * inadmissibly is omitted here and reported by {@link connectionTuningProblems},
 * which blocks the run, so no malformed value reaches an intent.
 */
export function connectionTuningOptions(
  draft: ConnectionTuningDraft,
  capabilities: ConnectionTuningCapabilities = { connectionPerPoll: true },
): JobExchangeOptions | undefined {
  const pollIntervalMs = durationMs(draft.pollInterval);
  const peerTimeoutMs = timeoutMs(draft.peerTimeout);
  const serverConnectTimeoutMs = timeoutMs(draft.serverConnectTimeout);
  const maxReconnectAttempts = reconnectAttempts(draft.maxReconnectAttempts);
  const stated: JobExchangeOptions = {
    ...(typeof pollIntervalMs === "number" ? { pollIntervalMs } : {}),
    ...(typeof peerTimeoutMs === "number" ? { peerTimeoutMs } : {}),
    ...(typeof serverConnectTimeoutMs === "number"
      ? { serverConnectTimeoutMs }
      : {}),
    ...(typeof maxReconnectAttempts === "number"
      ? { maxReconnectAttempts }
      : {}),
    ...(capabilities.connectionPerPoll && draft.connectionPerPoll
      ? { connectionPerPoll: true }
      : {}),
  };
  return Object.keys(stated).length === 0 ? undefined : stated;
}

/**
 * Merge the connection-tuning block onto another authored block (the
 * file-handling card's), so the two cards contribute to the one `options`
 * object a job intent holds. Each card owns its own fields, so the merge
 * overwrites no authored choice -- checked over both cards' whole surfaces
 * in connectionTuningModel.test.ts. Returns undefined when neither card
 * contributed anything.
 */
export function withConnectionTuning(
  base: JobExchangeOptions | undefined,
  draft: ConnectionTuningDraft,
  capabilities: ConnectionTuningCapabilities = { connectionPerPoll: true },
): JobExchangeOptions | undefined {
  const tuning = connectionTuningOptions(draft, capabilities);
  if (base === undefined) return tuning;
  if (tuning === undefined) return base;
  return { ...base, ...tuning };
}

/** The problem a duration field with an inadmissible magnitude reports, naming
 * the field in the card's own words. */
function durationProblem(label: string): string {
  return `${label} must be a whole number greater than zero, or left blank for the default.`;
}

/** The problem a timeout field past {@link MAX_TIMEOUT_MS} reports, stated in the
 * whole days the ceiling is set in. */
function timeoutCeilingProblem(label: string): string {
  return (
    `${label} cannot be longer than ${MAX_TIMEOUT_SECONDS / 86_400} days, ` +
    "the longest wait an exchange accepts."
  );
}

/**
 * What one timeout field states wrongly, or `undefined` when it is admissible.
 * The shape rule is reported ahead of the ceiling, so a value breaking both is
 * named once and by the rule the operator meets first.
 */
function timeoutProblem(
  field: DurationField,
  label: string,
): string | undefined {
  if (durationMs(field) === null) return durationProblem(label);
  if (timeoutMs(field) === null) return timeoutCeilingProblem(label);
  return undefined;
}

/**
 * Everything wrong with the draft, as messages to show beside the card --
 * empty when it is admissible. The run is blocked while this is non-empty,
 * so a value the intent schema would refuse is caught here, at authoring
 * time.
 *
 * These are shape rules on what the operator typed, plus the two ceilings
 * the run itself refuses ({@link MAX_RECONNECT_ATTEMPTS}, the seven-day
 * {@link MAX_TIMEOUT_MS}) -- never a judgement about a value both accept:
 * that draws an advisory ({@link connectionTuningAdvisories}) instead.
 */
export function connectionTuningProblems(
  draft: ConnectionTuningDraft,
): Array<string> {
  const problems: Array<string> = [];
  if (durationMs(draft.pollInterval) === null)
    problems.push(durationProblem("The check interval"));
  const peerProblem = timeoutProblem(
    draft.peerTimeout,
    "The wait for your partner",
  );
  if (peerProblem !== undefined) problems.push(peerProblem);
  const connectProblem = timeoutProblem(
    draft.serverConnectTimeout,
    "The connection attempt timeout",
  );
  if (connectProblem !== undefined) problems.push(connectProblem);
  if (reconnectAttempts(draft.maxReconnectAttempts) === null)
    problems.push(
      "The retry budget must be a whole number from 0 to " +
        `${MAX_RECONNECT_ATTEMPTS}, or left blank for the default ` +
        `(${DEFAULT_MAX_RECONNECT_ATTEMPTS}).`,
    );
  return problems;
}

/**
 * The advisory the console raises for a sub-second check interval: the anti-flood
 * warning the CLI raises at run time for the same value, stated here while the
 * operator can still change it. Exported so a copy-pin test can assert the two
 * name the same hazard.
 */
export const LOW_POLL_INTERVAL_ADVISORY =
  "Checking more often than once a second can trip an SFTP server's " +
  "anti-flood protection and drop the connection. Use a sub-second interval " +
  "only against a server you control, such as a demo.";

/**
 * The advisory the console raises when the SFTP session mode is paired with a
 * short check interval. The mode exists to survive a server's session-lifetime
 * cap across long idle gaps, so a fresh SSH handshake every cycle only pays off
 * at a long interval. Exported for the same reason as
 * {@link LOW_POLL_INTERVAL_ADVISORY}.
 */
export const CONNECTION_PER_POLL_SHORT_INTERVAL_ADVISORY =
  "A new connection for each check pays a full SSH handshake every cycle, " +
  "which is wasteful below a minute. This mode exists to survive a server " +
  "that caps how long a session may last, across long idle gaps, so pair it " +
  "with an interval of several minutes; a short interval is better served by " +
  "the single held connection.";

/**
 * The non-blocking advisories the draft draws: the CLI's two run-time
 * warnings about these values, raised here at authoring time instead. Warn
 * and guide, never a block -- both values are legitimate against a server
 * the operator controls.
 *
 * The short-interval advisory reads the EFFECTIVE interval,
 * `DEFAULT_POLLING_FREQUENCY_MS` included, matching the CLI: an unset
 * interval with the session mode on is the wasteful pairing this warns
 * about, not an untuned run.
 */
export function connectionTuningAdvisories(
  draft: ConnectionTuningDraft,
  capabilities: ConnectionTuningCapabilities = { connectionPerPoll: true },
): Array<string> {
  const advisories: Array<string> = [];
  const pollIntervalMs = durationMs(draft.pollInterval);
  if (
    typeof pollIntervalMs === "number" &&
    pollIntervalMs < LOW_POLLING_FREQUENCY_WARN_MS
  )
    advisories.push(LOW_POLL_INTERVAL_ADVISORY);
  const effectiveIntervalMs =
    typeof pollIntervalMs === "number"
      ? pollIntervalMs
      : DEFAULT_POLLING_FREQUENCY_MS;
  if (
    capabilities.connectionPerPoll &&
    draft.connectionPerPoll &&
    effectiveIntervalMs < CONNECTION_PER_POLL_SHORT_INTERVAL_WARN_MS
  )
    advisories.push(CONNECTION_PER_POLL_SHORT_INTERVAL_ADVISORY);
  return advisories;
}

/**
 * The card's collapsed summary: whether anything here departs from the
 * defaults the run would otherwise take. It reads the same capabilities
 * {@link connectionTuningOptions} emits under, so a field the flow drops --
 * the SFTP session mode on a shared-directory transport -- is not counted
 * as a departure. Lives with the model rather than the card: which fields
 * count is the capabilities rule, not a presentation choice.
 */
export function connectionTuningSummary(
  draft: ConnectionTuningDraft,
  capabilities: ConnectionTuningCapabilities,
): string {
  const touched =
    draft.pollInterval.magnitude.trim() !== "" ||
    draft.peerTimeout.magnitude.trim() !== "" ||
    draft.serverConnectTimeout.magnitude.trim() !== "" ||
    draft.maxReconnectAttempts.trim() !== "" ||
    (capabilities.connectionPerPoll && draft.connectionPerPoll);
  return touched ? "Tuned" : "Default";
}

/**
 * The coarsest unit in which `ms` is a whole number, milliseconds always
 * eligible as the last resort. The unit a duration's own value is stated in
 * naturally, independent of whichever unit a field happens to be authored in.
 */
function naturalDurationUnit(ms: number): DurationUnit {
  const coarsestFirst: ReadonlyArray<DurationUnit> = ["h", "m", "s", "ms"];
  return (
    coarsestFirst.find((candidate) =>
      Number.isInteger(ms / UNIT_MS[candidate]),
    ) ?? "ms"
  );
}

/**
 * The placeholder each duration field shows: core's own default for that
 * field, so an operator who leaves it blank can see what the run will
 * actually use. When the default is a whole number in the field's current
 * unit, that bare number is shown. Otherwise a rounded bare number would
 * misstate the default (or round to "0", a value the field itself
 * refuses), so the placeholder states the default in its own natural unit
 * as text.
 */
export function defaultPlaceholder(
  defaultMs: number,
  unit: DurationUnit,
): string {
  const converted = defaultMs / UNIT_MS[unit];
  if (Number.isInteger(converted)) return String(converted);
  const natural = naturalDurationUnit(defaultMs);
  return `default ${defaultMs / UNIT_MS[natural]} ${natural}`;
}

/** Core's default for each duration field, keyed by the draft field it belongs
 * to, so the card's placeholders show the values the run actually applies rather
 * than restating them. */
export const TUNING_DEFAULT_MS = {
  pollInterval: DEFAULT_POLLING_FREQUENCY_MS,
  peerTimeout: DEFAULT_PEER_TIMEOUT_MS,
  serverConnectTimeout: DEFAULT_SERVER_CONNECT_TIMEOUT_MS,
} as const;
