/**
 * The pure ordering and decision half of the managed (recurring) exchange's
 * run+rotate critical section: the IndexedDB-free, Web-Locks-free logic that
 * decides what the rotation writes back, restamps `expires` from the max-age
 * policy, and records the run's `lastRun` bookkeeping -- so the persist-before-
 * success sequence and its decisions are unit-testable in Node without a database
 * or a real lock. The platform half (the Web Locks acquisition and the strict-
 * durability, field-scoped store write) is in {@link ./managedExchangeRun.ts}.
 *
 * Normative sequence: docs/spec/MANAGED_EXCHANGE_RECORD.md, "Persist-before-
 * success ordering". Within one run: the handshake yields the `AuthResult`; the
 * rotated `sharedSecret` (and `expires`, restamped from `tokenMaxAgeDays` when a
 * policy is set) is durably persisted and the write awaited; only then does the
 * data exchange begin, and only on its completion is the run recorded succeeded.
 * {@link runRotationCriticalSection} is the locked window (handshake through
 * persist); it resolves a gate whose carried value the data exchange needs, so the
 * data exchange is unreachable until the persist resolves even though the caller
 * runs it after releasing the lock -- the ordering is a property of the control
 * flow, not the caller's discipline.
 */

import type {
  ManagedExchangeFailureKind,
  ManagedExchangeLastRun,
} from "./managedExchangeRecord";

/** Milliseconds in a day, for restamping a rotated secret's `expires` from the
 * max-age policy. Mirrors the CLI key file's `MS_PER_DAY`. */
const MS_PER_DAY = 86_400_000;

/**
 * The rotation write-back: the fields a successful handshake advances on the
 * stored record, and nothing else. Structurally scoped to the rotation fields so
 * a whole-record write cannot ride along and carry a stale secret or a stale
 * document back over a concurrent write -- the field-scoped write the store
 * applies inside one transaction consumes exactly this shape.
 *
 * `expires` is a three-way decision, not an optional: `{ expires: string }`
 * restamps a bound when a max-age policy is set, `{ expires: null }` clears any
 * standing bound when no policy is set (a policy dropped between runs must not
 * leave a stale bound armed), and it is `null` rather than absent so the write
 * distinguishes "clear it" from "leave it untouched".
 */
export interface RotationWriteBack {
  /** The rotated shared secret to persist as the record's current secret. */
  sharedSecret: string;
  /** The restamped bound (`now + tokenMaxAgeDays`) when a policy is set, or
   * `null` to clear any standing bound when no policy is set. */
  expires: string | null;
}

/**
 * Compute the rotation write-back for a run: the rotated secret always, plus the
 * `expires` decision. When `tokenMaxAgeDays` is set, `expires` is restamped to
 * `now + tokenMaxAgeDays` days (ISO 8601 UTC) so the rotated secret cannot outlive
 * the operator's max-age policy; when it is absent, `expires` is `null` so any
 * standing bound is cleared. This mirrors the CLI's `buildRotatedKeyFile`,
 * including its guards against a non-positive-integer age (a caller bypassing the
 * config schema) and a computed expiry outside the representable date range.
 *
 * `now` is a parameter, not read internally, so the stamp reflects the actual
 * moment of rotation and the function stays pure for testing.
 *
 * @throws {RangeError} if `tokenMaxAgeDays` is not a positive integer, or if
 *   `now + tokenMaxAgeDays` days falls outside the supported date range.
 */
export function rotationWriteBack(
  rotatedSecret: string,
  tokenMaxAgeDays: number | undefined,
  now: number,
): RotationWriteBack {
  if (tokenMaxAgeDays === undefined)
    return { sharedSecret: rotatedSecret, expires: null };
  // Belt-and-suspenders, mirroring the CLI key file's guard: the record schema
  // already enforces a positive integer, but a caller bypassing it could pass 0,
  // a negative, or a float, stamping an expiry that is immediately expired or on a
  // sub-day boundary. Reject it before it reaches the store.
  if (!Number.isInteger(tokenMaxAgeDays) || tokenMaxAgeDays <= 0)
    throw new RangeError(
      "rotationWriteBack: tokenMaxAgeDays must be a positive integer; got " +
        String(tokenMaxAgeDays),
    );
  const expires = new Date(now + tokenMaxAgeDays * MS_PER_DAY);
  if (Number.isNaN(expires.getTime()) || expires.getUTCFullYear() > 9999)
    throw new RangeError(
      "rotationWriteBack: tokenMaxAgeDays is too large; the computed expiry is " +
        "outside the supported date range",
    );
  return { sharedSecret: rotatedSecret, expires: expires.toISOString() };
}

/** Record a run that completed the data exchange. The `lastRun` the tiered
 * desync UX and the backup state read as green: `succeeded`, no `failureKind`. */
export function succeededRun(at: number): ManagedExchangeLastRun {
  return { at: new Date(at).toISOString(), outcome: "succeeded" };
}

/**
 * Record a run that rotated the secret but failed to persist it. This is
 * structured `failureKind: "storage"` bookkeeping precisely so the next handshake
 * failure surfaces through the benign Tier-1 framing (a recorded persist failure
 * explains a desync) rather than the attack framing -- see
 * docs/MANAGED_EXCHANGE.md, "Telling a desync from an attack".
 */
export function storageFailureRun(at: number): ManagedExchangeLastRun {
  return {
    at: new Date(at).toISOString(),
    outcome: "failed",
    failureKind: "storage",
  };
}

/** Record a non-succeeded run with the given outcome and failure kind. Used for
 * the failure paths the runner classifies (an `auth`/`security` handshake
 * failure, a `transport` drop, a benign `input` problem, a `cancelled` run);
 * `succeededRun` and `storageFailureRun` are the two the critical section itself
 * decides. */
export function failedRun(
  at: number,
  outcome: Exclude<ManagedExchangeLastRun["outcome"], "succeeded">,
  failureKind: ManagedExchangeFailureKind,
): ManagedExchangeLastRun {
  return { at: new Date(at).toISOString(), outcome, failureKind };
}

/** Raised when the rotation write-back fails to persist, carrying the `lastRun`
 * bookkeeping the caller records. Distinct from a handshake or data-exchange
 * failure so the runner can route it to the `storage` failure tier and know the
 * data exchange never began. */
export class RotationPersistError extends Error {
  /** The `storage`-kind `lastRun` to record for this failed run. */
  readonly lastRun: ManagedExchangeLastRun;
  constructor(at: number, cause: unknown) {
    super("failed to persist the rotated shared secret", { cause });
    this.name = "RotationPersistError";
    this.lastRun = storageFailureRun(at);
  }
}

/** The locked half of a run: the handshake and the durable persist, plus the
 * seams the platform half injects. This is exactly the window the single-writer
 * lock covers -- "begin this run" through "rotated secret durably persisted" --
 * and it is testable in Node with the persist seam faked. */
export interface ManagedRotationCriticalSection<THandshake> {
  /**
   * Run the authenticated handshake and yield the rotated secret (from the
   * `AuthResult`) plus whatever the data-exchange phase needs. Runs inside the
   * lock; a throw here aborts the run before any persist or data exchange.
   */
  handshake: () => Promise<{ rotatedSecret: string; handshake: THandshake }>;
  /**
   * Durably persist the rotation write-back and await the write's completion.
   * The platform half opens a strict-durability, field-scoped transaction; a
   * throw here means the secret did not persist and the data exchange must not
   * begin (a `RotationPersistError` is raised in its place).
   */
  persist: (writeBack: RotationWriteBack) => Promise<void>;
  /** The operator's max-age policy for this record, or `undefined` for no bound.
   * Restamps `expires` on the write-back when set. */
  tokenMaxAgeDays: number | undefined;
  /** The instant of rotation, injected so the stamp reflects the caller's clock
   * and the sequence stays pure for testing. */
  now: () => number;
}

/**
 * The result of the locked critical section: the handshake's carried value and a
 * `proceed` gate. `proceed` -- the data exchange -- is only obtainable once the
 * rotated secret is durably persisted, so a caller structurally cannot begin the
 * data exchange before the persist resolves, even though the caller runs it AFTER
 * releasing the lock (the lock covers only through persist, per the spec's window).
 */
export interface ManagedRotationGate<THandshake> {
  /** The handshake's carried value, to hand to the data-exchange phase. */
  handshake: THandshake;
}

/**
 * Run the locked half of one run's persist-before-success sequence: the window the
 * single-writer lock holds.
 *
 * 1. `handshake()` yields the `AuthResult`'s rotated secret.
 * 2. The rotation write-back (the rotated secret, `expires` restamped from the
 *    policy) is computed and `persist()`ed, awaited to completion. A persist
 *    failure raises a {@link RotationPersistError} carrying the `storage`-kind
 *    `lastRun`.
 *
 * It resolves only after the persist commits, and returns the {@link ManagedRotationGate}
 * whose carried handshake value the data exchange consumes -- so the data exchange
 * (which the caller runs after releasing the lock) is unreachable until the persist
 * has resolved. The lock window is exactly this function: begin-run through rotated-
 * secret-durably-persisted, no wider (the data exchange does not hold the lock).
 *
 * @throws {RotationPersistError} if the rotation write-back fails to persist.
 */
export async function runRotationCriticalSection<THandshake>(
  section: ManagedRotationCriticalSection<THandshake>,
): Promise<ManagedRotationGate<THandshake>> {
  const { rotatedSecret, handshake } = await section.handshake();

  const writeBack = rotationWriteBack(
    rotatedSecret,
    section.tokenMaxAgeDays,
    section.now(),
  );
  try {
    await section.persist(writeBack);
  } catch (error) {
    throw new RotationPersistError(section.now(), error);
  }

  return { handshake };
}
