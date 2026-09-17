/**
 * The fallback signal for a run whose disclosure went unfiled AND whose note the
 * browser's database would not take: one localStorage value naming the exchanges
 * a run of which could not be recorded.
 *
 * It exists for the one condition the note in the disclosure store cannot cover
 * -- storage full, or a database that will not open -- where an exchange has
 * disclosed and this browser holds neither the entry nor a note of the run. It
 * keeps the fact and nothing else: an exchange id, with no instant and no
 * record, so it can be written where a record-sized write was refused. What that
 * costs is recoverability: a run named here can never be filed, which is the
 * stated limit (see docs/spec/MANAGED_EXCHANGE_RECORD.md, "A run whose record
 * was not filed").
 *
 * A flag is cleared where its alert has rendered, and where the exchange is
 * deleted or every exchange is cleared, so nothing keeps the id of an exchange
 * this browser no longer holds.
 *
 * Every write here reads the whole value and writes it back, and a second tab
 * writing between the two would drop what the first stored -- an unrecorded run
 * losing its flag to a clear taken elsewhere. So all three writes run under one
 * origin-wide Web Locks name ({@link underWriteLock}), which is what makes the
 * read and the write back one step. Where no lock manager is reachable the write
 * still runs, unlocked, and the loss that admits is stated with the limit above.
 */

import { getLogger, parseBoundedJson } from "@psilink/core";

import { whenDiagnostic } from "@utils/diagnostics";

const log = getLogger("unfiledDisclosureFlag");

/** The localStorage key the flagged exchange ids are written under. */
const STORAGE_KEY = "psilink-unfiled-disclosure";

/** The Web Locks name held across a write's read and its write back. Namespaced
 * like every other lock this app takes, so it collides with no other same-origin
 * name. */
const WRITE_LOCK_NAME = "psilink-unfiled-disclosure-write";

/** The stored value's schema version; a value under any other version is treated
 * as absent (a forward- or backward-incompatible value is discarded, not
 * migrated). */
const FLAG_VERSION = 1;

/** How many exchanges the value names at once. A flag past the bound is refused
 * rather than displacing one already stored: an earlier exchange's unrecorded
 * run is no less true than a later one's. */
const MAX_FLAGGED_EXCHANGES = 20;

/** How long the stored value may be, in the UTF-16 code units a browser's
 * storage counts. The count bound above does not bound the value's size: a
 * record id is any non-empty string, so an imported record's id is bounded only
 * by the artifact it came in. The value is written where storage has already
 * refused a record-sized write, so a flag that would take it past this is
 * refused like one past the count bound. */
const MAX_FLAG_VALUE_LENGTH = 4096;

/** The lock manager this context reaches, or `undefined` where it has none:
 * server rendering, and a browser that exposes no Web Locks API. */
function writeLockManager(): LockManager | undefined {
  try {
    return globalThis.navigator.locks;
  } catch {
    return undefined;
  }
}

/**
 * Run `write` holding {@link WRITE_LOCK_NAME}, so no other same-origin context
 * writes the value between its read and its write back. `write` is synchronous,
 * so the lock is never held across an await and a waiting caller queues behind
 * one storage round-trip.
 *
 * Where no lock manager is reachable, and where the request fails before `write`
 * ran, `write` runs unlocked: the fact this value stands for is worth more than
 * the exclusion. A failure raised after `write` ran is raised on rather than
 * retried, so no write runs twice.
 */
async function underWriteLock<T>(write: () => T): Promise<T> {
  const locks = writeLockManager();
  if (locks === undefined) return write();
  // A holder rather than a plain flag: assigned only inside the callback, a
  // local would narrow to its initial value at the catch below.
  const attempt = { ran: false };
  try {
    return await locks.request(WRITE_LOCK_NAME, () => {
      attempt.ran = true;
      return write();
    });
  } catch (error) {
    if (attempt.ran) throw error;
    whenDiagnostic(() =>
      log.warn("unfiled disclosure flag lock unavailable:", error),
    );
    return write();
  }
}

/** The flagged ids as the stored value holds them, oldest first, or an empty
 * list where nothing is stored, the value is not this version, or storage is
 * unavailable (server rendering, blocked quota). */
function flaggedExchanges(): Array<string> {
  let raw: string | null;
  try {
    raw = globalThis.localStorage.getItem(STORAGE_KEY);
  } catch {
    return [];
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = parseBoundedJson(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const { v, exchanges } = parsed as Record<string, unknown>;
  if (v !== FLAG_VERSION || !Array.isArray(exchanges)) return [];
  return exchanges.filter(
    (id): id is string => typeof id === "string" && id.length > 0,
  );
}

/** The stored form of these ids: what the length bound above is measured on,
 * before a write is attempted. */
function serializedFlags(exchanges: ReadonlyArray<string>): string {
  return JSON.stringify({ v: FLAG_VERSION, exchanges });
}

/** Write the flagged ids back, removing the key entirely when none are left so
 * no empty value sits at rest.
 *
 * @throws if storage refuses the write, which the clear below reports to the
 *   diagnostic log. */
function writeFlaggedExchanges(exchanges: ReadonlyArray<string>): void {
  if (exchanges.length === 0) globalThis.localStorage.removeItem(STORAGE_KEY);
  else globalThis.localStorage.setItem(STORAGE_KEY, serializedFlags(exchanges));
}

/**
 * Flag that a run of this exchange could not be recorded, resolving to whether
 * the flag is now stored. Already-flagged is a success: one flag per exchange
 * states the fact this value holds, and the flag holds no per-run detail to
 * accumulate.
 *
 * `false` means this browser kept nothing at all about the run -- storage
 * refused this too, or either bound above is reached -- which the caller reports
 * to the diagnostic log, the only place left to state it.
 */
export function flagUnfiledExchange(id: string): Promise<boolean> {
  return underWriteLock(() => {
    const flagged = flaggedExchanges();
    if (flagged.includes(id)) return true;
    if (flagged.length >= MAX_FLAGGED_EXCHANGES) return false;
    const value = serializedFlags([...flagged, id]);
    if (value.length > MAX_FLAG_VALUE_LENGTH) return false;
    try {
      globalThis.localStorage.setItem(STORAGE_KEY, value);
      return true;
    } catch (error) {
      whenDiagnostic(() =>
        log.warn("unfiled disclosure flag write failed:", error),
      );
      return false;
    }
  });
}

/** Whether a run of this exchange is flagged as unrecorded. A read takes no
 * lock: it states what the value held when it was read, and drops nothing
 * another context wrote. */
export function unfiledExchangeFlagged(id: string): boolean {
  return flaggedExchanges().includes(id);
}

/** Drop this exchange's flag, best-effort: it is cleared where its alert has
 * rendered, and where the exchange is deleted. */
export function clearUnfiledExchangeFlag(id: string): Promise<void> {
  return underWriteLock(() => {
    const flagged = flaggedExchanges();
    if (!flagged.includes(id)) return;
    try {
      writeFlaggedExchanges(flagged.filter((flaggedId) => flaggedId !== id));
    } catch (error) {
      whenDiagnostic(() =>
        log.warn("unfiled disclosure flag clear failed:", error),
      );
    }
  });
}

/** Drop every flag, best-effort: nothing this browser holds names an exchange
 * once every exchange has been cleared from it. It takes the same lock as the
 * writes above, so a flag written elsewhere either stays out of the value this
 * removes or is written after it. */
export function clearUnfiledExchangeFlags(): Promise<void> {
  return underWriteLock(() => {
    try {
      globalThis.localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      whenDiagnostic(() =>
        log.warn("unfiled disclosure flag clear failed:", error),
      );
    }
  });
}
