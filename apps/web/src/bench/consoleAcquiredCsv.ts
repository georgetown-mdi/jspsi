import type { AcceptorAcquiredCsv } from "./acceptorColumnsModel";
import type { AcquiredCsv } from "./inviterModel";
import type { CSVRow } from "@psilink/core";

/**
 * The file facts the console acquires from the server-side profile instead of the
 * rows: the browser never reads the file on the console (it is read on the
 * appliance), so the intake has the name, size, column list, row count, and the
 * pre-inferred date-of-birth format -- everything the pure draft model needs -- but
 * no rows. The per-column preview samples ride a separate seam (the coverage/preview
 * providers), not this shape.
 */
export interface ConsoleAcquiredProfile {
  fileName: string;
  sizeBytes: number;
  columns: Array<string>;
  rowCount: number;
  dateInputFormat?: string;
}

/**
 * Build the console's acquired CSV from a server-side profile -- structurally the
 * hosted {@link AcquiredCsv} and {@link AcceptorAcquiredCsv}, but with no rows: the
 * console reads the file on the appliance, never in the browser.
 *
 * `rawRows` is a getter that throws in dev and test and yields the empty array in a
 * production build. Any explicit `rawRows` read is a consumer that does not source
 * from the profile (rowCount, dateInputFormat, and the preview/coverage seams);
 * failing loud in every dev run and test catches it at once, while degrading to
 * empty in production keeps an overlooked reader rendering an empty preview rather
 * than crashing the operator's session. The ESLint `rawRows` restriction is the
 * static half of the same backstop.
 *
 * The getter is defined NON-ENUMERABLE: a bench component receives this shape as a
 * prop, and React's dev-mode render logging enumerates prop values, which would trip
 * the throwing getter on an entirely legitimate render. A non-enumerable property is
 * skipped by that reflection (and by spreads / `Object.keys`) yet still throws on an
 * explicit `csv.rawRows`, so the backstop catches real consumers without firing on
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
    dateInputFormat: profile.dateInputFormat,
    // Signals to the draft reconciliations that this shape carries no rows, so they
    // feed an empty row set to the seed helpers rather than reading the getter below
    // (the date-of-birth format they need is already profiled).
    rowsWithheld: true,
  };
  Object.defineProperty(csv, "rawRows", {
    enumerable: false,
    configurable: true,
    get(): Array<CSVRow> {
      if (import.meta.env.DEV)
        throw new Error(
          "console acquired CSV has no rawRows; read rowCount / dateInputFormat / the profile's column samples instead",
        );
      return [];
    },
  });
  return csv as AcquiredCsv & AcceptorAcquiredCsv;
}
