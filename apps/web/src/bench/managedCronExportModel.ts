/**
 * The pure model behind the managed exchange's command-line export panel: whether
 * a stored record can be exported at all, and the two schedule lines that run the
 * composed invocation unattended. No React, no store, no download -- the panel
 * stays thin over this.
 *
 * The exportability decision is NOT re-derived here. The composer
 * ({@link composeManagedCronExport}) is the one place that decides which stored
 * documents may become a `psilink.yaml`, and it refuses by throwing; this model
 * calls it and presents the refusal, so a second copy of the rule cannot drift
 * from the one the export actually enforces.
 *
 * The schedule lines are examples, not the export: the browser record's own
 * schedule does not travel to the CLI (a cron entry or a Task Scheduler trigger is
 * how a command-line run repeats), so what the panel shows is a daily line the
 * operator edits for their own times and folder.
 */

import { sanitizeErrorForDisplay } from "@psilink/core";

import { composeManagedCronExport } from "@psi/managedCronExport";

import type { ManagedCronExport } from "@psi/managedCronExport";
import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";

/** The folder placeholder the POSIX schedule line changes into. The exported files
 * carry no path of their own -- the command reads its config and key from the
 * working directory -- so the one machine-specific value is where the operator put
 * them. */
const POSIX_FOLDER_PLACEHOLDER = "/path/to/your/exchange-folder";

/** The Windows counterpart of {@link POSIX_FOLDER_PLACEHOLDER}. */
const WINDOWS_FOLDER_PLACEHOLDER = "C:\\path\\to\\your\\exchange-folder";

/**
 * The cron line that runs `command` daily at 2am from the folder holding the two
 * exported files.
 */
export function cronScheduleLine(command: string): string {
  return `0 2 * * * cd ${POSIX_FOLDER_PLACEHOLDER} && ${command}`;
}

/**
 * The Windows Task Scheduler command that registers `command` daily at 2am from the
 * folder holding the two exported files.
 *
 * `command` is interpolated into the `/TR "..."` argument, so a double quote inside
 * it would end that argument early. The composed invocation carries none (it is the
 * CLI's own verb plus two fixed file names), which the model's unit suite asserts
 * rather than this line escaping a case that cannot arise.
 */
export function taskSchedulerLine(command: string): string {
  return (
    `schtasks /Create /TN "psilink exchange" /SC DAILY /ST 02:00 ` +
    `/TR "cmd /c cd /d ${WINDOWS_FOLDER_PLACEHOLDER} && ${command}"`
  );
}

/**
 * What the panel renders for a record: the composed export and its schedule lines,
 * or the composer's own reason for refusing it.
 */
export type ManagedCronExportPanelState =
  | {
      kind: "exportable";
      /** The two files and the invocation the composer produced. */
      composed: ManagedCronExport;
      /** The daily cron line running {@link composed}'s command. */
      cronLine: string;
      /** The daily Windows Task Scheduler command running the same. */
      taskSchedulerLine: string;
    }
  | {
      kind: "refused";
      /** The composer's reason, escaped for display: it names the stored fields
       * that put the record outside what the app composes, and a stored document
       * can hold names this app did not author (an imported artifact's). */
      reason: string;
    };

/**
 * Derive the panel's state for `record`. A record the composer refuses -- a stored
 * connection on another channel, or a document carrying anything the app could not
 * have composed -- yields the refusal and its reason; anything else yields the
 * composed export and the two schedule lines.
 */
export function managedCronExportPanelState(
  record: ManagedExchangeRecord,
): ManagedCronExportPanelState {
  let composed: ManagedCronExport;
  try {
    composed = composeManagedCronExport(record);
  } catch (error) {
    return { kind: "refused", reason: sanitizeErrorForDisplay(error) };
  }
  return {
    kind: "exportable",
    composed,
    cronLine: cronScheduleLine(composed.command),
    taskSchedulerLine: taskSchedulerLine(composed.command),
  };
}
