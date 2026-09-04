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

import { cronScheduleLine, taskSchedulerLine } from "./scheduleTemplates";

import type { ManagedCronExport } from "@psi/managedCronExport";
import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";

/**
 * The STUN server the exported invocation falls back to, disclosed on the panel
 * because a managed connection configures no ICE server of its own: every
 * scheduled run tells this server the scheduling host's public address. It is
 * werift's built-in default (`WERIFT_BUILT_IN_STUN_URI` in
 * apps/cli/src/connection/webrtc/weriftPeer.ts);
 * `npm run check:stun-default-claims` holds this copy to that one, since an app
 * may not import from another app. Not the web app's own ICE list
 * (`@psi/rendezvous`), which is a different list for exchanges this browser runs
 * itself.
 */
export const CLI_BUILT_IN_STUN_URI = "stun:stun.l.google.com:19302";

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
 * connection on another channel, or a document holding anything the app could not
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
