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
 * A flag is cleared when the exchange's page shows it, and when the exchange is
 * deleted, so nothing keeps the id of an exchange this browser no longer holds.
 */

import { getLogger, parseBoundedJson } from "@psilink/core";

import { whenDiagnostic } from "@utils/diagnostics";

const log = getLogger("unfiledDisclosureFlag");

/** The localStorage key the flagged exchange ids are written under. */
const STORAGE_KEY = "psilink-unfiled-disclosure";

/** The stored value's schema version; a value under any other version is treated
 * as absent (a forward- or backward-incompatible value is discarded, not
 * migrated). */
const FLAG_VERSION = 1;

/** How many exchanges the value names at once. One id per exchange keeps the
 * whole value under a kilobyte at this bound, which matters because the
 * condition it is written under is a browser out of storage. A flag past the
 * bound is refused rather than displacing one already stored: an earlier
 * exchange's unrecorded run is no less true than a later one's. */
const MAX_FLAGGED_EXCHANGES = 20;

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

/** Write the flagged ids back, removing the key entirely when none are left so
 * no empty value sits at rest.
 *
 * @throws if storage refuses the write, which is what the flag write below
 *   reports as not having taken. */
function writeFlaggedExchanges(exchanges: ReadonlyArray<string>): void {
  if (exchanges.length === 0) globalThis.localStorage.removeItem(STORAGE_KEY);
  else
    globalThis.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ v: FLAG_VERSION, exchanges }),
    );
}

/**
 * Flag that a run of this exchange could not be recorded, returning whether the
 * flag is now stored. Already-flagged is a success: one flag per exchange states
 * the fact this value holds, and the flag holds no per-run detail to accumulate.
 *
 * `false` means this browser kept nothing at all about the run -- storage
 * refused this too, or the bound above is reached -- which the caller reports to
 * the diagnostic log, the only place left to state it.
 */
export function flagUnfiledExchange(id: string): boolean {
  const flagged = flaggedExchanges();
  if (flagged.includes(id)) return true;
  if (flagged.length >= MAX_FLAGGED_EXCHANGES) return false;
  try {
    writeFlaggedExchanges([...flagged, id]);
    return true;
  } catch (error) {
    whenDiagnostic(() =>
      log.warn("unfiled disclosure flag write failed:", error),
    );
    return false;
  }
}

/** Whether a run of this exchange is flagged as unrecorded. */
export function unfiledExchangeFlagged(id: string): boolean {
  return flaggedExchanges().includes(id);
}

/** Drop this exchange's flag, best-effort: it is cleared where the exchange's
 * page has shown it, and where the exchange is deleted. */
export function clearUnfiledExchangeFlag(id: string): void {
  const flagged = flaggedExchanges();
  if (!flagged.includes(id)) return;
  try {
    writeFlaggedExchanges(flagged.filter((flaggedId) => flaggedId !== id));
  } catch (error) {
    whenDiagnostic(() =>
      log.warn("unfiled disclosure flag clear failed:", error),
    );
  }
}
