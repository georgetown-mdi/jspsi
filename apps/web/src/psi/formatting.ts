/**
 * The display labels the exchange screens share: file sizes, invitation
 * lifetimes and their expiry, and the direction the matched results go. Pure
 * string building over values the caller already holds.
 */

import {
  MAX_INVITATION_LIFETIME_SECONDS,
  hasExpiryInstantPassed,
} from "@psilink/core";

import type { OutputDirection } from "./authoring/advancedInvite";

/** A byte count as a compact size label, e.g. `8.4 MB`, `512 KB`, `2.1 GB`. The
 * ladder floors at 1 KB and runs to GB, since CLI-scale console inputs reach
 * gigabytes; called from the inviter's and acceptor's file cards
 * ({@link fileCardMeta}, `AcceptorScreen`) and the server-file picker
 * (`ServerFilePicker`). */
export function byteSizeLabel(sizeBytes: number): string {
  if (sizeBytes >= 1024 ** 3) return `${(sizeBytes / 1024 ** 3).toFixed(1)} GB`;
  if (sizeBytes >= 1024 ** 2) return `${(sizeBytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(sizeBytes / 1024))} KB`;
}

/** The file card's metadata line, e.g. `12,408 rows - 8.4 MB`. */
export function fileCardMeta(rowCount: number, sizeBytes: number): string {
  const rows = new Intl.NumberFormat("en-US").format(rowCount);
  return `${rows} rows - ${byteSizeLabel(sizeBytes)}`;
}

/** A lifetime as a plain duration phrase, e.g. `1 hour`, `7 days`. Whole
 * days/hours cover every {@link LIFETIME_CHOICES} value; anything else falls
 * back to minutes. */
export function lifetimeNoun(seconds: number): string {
  const unit = (count: number, noun: string) =>
    `${count} ${noun}${count === 1 ? "" : "s"}`;
  if (seconds % 86400 === 0) return unit(seconds / 86400, "day");
  if (seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  return unit(Math.max(1, Math.round(seconds / 60)), "minute");
}

/** The ledger's Expires phrasing for a draft lifetime, e.g. `1 hour after you
 * share`. */
export function lifetimeLabel(seconds: number): string {
  return `${lifetimeNoun(seconds)} after you share`;
}

/** The lifetimes step 3 offers, from the recommended hour up to the bounded
 * maximum ({@link MAX_INVITATION_LIFETIME_SECONDS}, one year). */
export const LIFETIME_CHOICES: ReadonlyArray<{
  seconds: number;
  label: string;
}> = [
  { seconds: 3600, label: "1 hour" },
  { seconds: 6 * 3600, label: "6 hours" },
  { seconds: 86400, label: "1 day" },
  { seconds: 7 * 86400, label: "7 days" },
  { seconds: 30 * 86400, label: "30 days" },
  { seconds: MAX_INVITATION_LIFETIME_SECONDS, label: "1 year" },
];

/** An absolute moment phrased for display, e.g. `July 8, 2026, 3:32 PM EDT`
 * -- the minted expiry in the ledger. */
export function dateTimeLabel(moment: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(moment);
}

/** A calendar day phrased for display, e.g. `July 8, 2026` -- the date-granularity
 * form the backup surfaces read ("backed up as of <date>"), where the minute is
 * noise. */
export function dateLabel(moment: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(moment);
}

/** The absolute moment an invitation shared `now` would expire, phrased for
 * the live expiry hint. */
export function expiryLabel(lifetimeSeconds: number, now: Date): string {
  return dateTimeLabel(new Date(now.getTime() + lifetimeSeconds * 1000));
}

/** Whether a minted invitation's ISO `expires` moment is still ahead of `now`
 * -- past it, no partner can pass the credential, so a retry is pointless and
 * the link must stop being offered. False for a non-string `expiresIso`, and
 * false when the expiry or the clock cannot be read: a credential whose bound is
 * unreadable is not one to keep handing out. Otherwise the shared comparison's
 * verdict. */
export function invitationUsable(expiresIso: string, now: Date): boolean {
  // The runtime half of the `string` parameter type, for an untyped or cast
  // caller: the shared comparison reads an absent bound as none in force, which
  // would call an invitation carrying no expiry usable.
  if (typeof expiresIso !== "string") return false;
  return !hasExpiryInstantPassed(expiresIso, now, {
    onUnparseable: "fail-closed",
  });
}

/** Ledger phrasing for who receives the matched results. */
export const RESULTS_DIRECTION_LABELS: Record<OutputDirection, string> = {
  both: "You and your partner",
  inviter: "Only you",
  partner: "Only your partner",
};
