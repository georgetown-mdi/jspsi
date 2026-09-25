import type { AcceptorAcquiredCsv } from "@exchange/acceptorColumnsModel";
import type { AcquiredCsv } from "@psi/inviterEditor";
import type { CSVRow } from "@alcove/core";
import type { ProfiledDateInputFormats } from "@psi/authoring/advancedInvite";

/**
 * The file facts the console acquires from the server-side profile instead of the
 * rows: on the console the file is read server-side, never in the browser, so the
 * intake has the name, size, column list, row count, and the per-column
 * date-of-birth formats -- everything the pure draft model needs -- but no rows. The
 * per-column preview samples come through a separate path (the coverage/preview
 * providers), not this shape.
 */
interface ConsoleAcquiredProfile {
  fileName: string;
  sizeBytes: number;
  columns: Array<string>;
  rowCount: number;
  dateInputFormats?: ProfiledDateInputFormats;
}

/**
 * Build the console's acquired CSV from a server-side profile -- structurally the
 * hosted {@link AcquiredCsv} and {@link AcceptorAcquiredCsv}, but with no rows: the
 * console reads the file server-side, never in the browser.
 *
 * `rawRows` is a getter that throws in dev and test and yields the empty array in a
 * production build. Any explicit `rawRows` read is a consumer that does not source
 * from the profile (rowCount, dateInputFormats, and the preview/coverage boundaries);
 * failing loud in every dev run and test catches it at once, while degrading to
 * empty in production keeps an overlooked reader rendering an empty preview rather
 * than crashing the operator's session. The ESLint `rawRows` restriction is the
 * static half of the same safety check.
 *
 * The getter is defined NON-ENUMERABLE: a console component receives this shape as a
 * prop, and React's dev-mode render logging enumerates prop values, which would trip
 * the throwing getter on an entirely legitimate render. A non-enumerable property is
 * skipped by that reflection (and by spreads / `Object.keys`) yet still throws on an
 * explicit `csv.rawRows`, so the check catches real consumers without firing on
 * the framework's own introspection.
 */
export function consoleAcquiredCsv(
  profile: ConsoleAcquiredProfile,
): AcquiredCsv & AcceptorAcquiredCsv {
  const csv: Omit<AcquiredCsv & AcceptorAcquiredCsv, "rawRows"> = {
    fileName: profile.fileName,
    sizeBytes: profile.sizeBytes,
    columns: profile.columns,
    rowCount: profile.rowCount,
    dateInputFormats: profile.dateInputFormats,
    // Signals to the draft reconciliations that this shape has no rows, so they
    // feed an empty row set to the seed helpers rather than reading the getter below
    // (the date-of-birth formats they need are already profiled).
    rowsWithheld: true,
  };
  Object.defineProperty(csv, "rawRows", {
    enumerable: false,
    configurable: true,
    get(): Array<CSVRow> {
      if (import.meta.env.DEV)
        throw new Error(
          "console acquired CSV has no rawRows; read rowCount / dateInputFormats / the profile's column samples instead",
        );
      return [];
    },
  });
  return csv as AcquiredCsv & AcceptorAcquiredCsv;
}
