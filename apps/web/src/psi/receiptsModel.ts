import { FINGERPRINT_REGEX, MAX_TEXT_LENGTH } from "@psilink/core";

import { NOTE_CONTROL_CHAR_PATTERN } from "./retentionNoteShape";

import type { JobRendezvousConfig } from "./workInputClient";
import type { JobSigningChoice } from "@jobs/intent";

/**
 * The pure model behind the console's "Receipts and record keeping" card:
 * whether this exchange signs a certificate receipt, whose fingerprint it
 * pins, and the retention note filed with the exchange record. No React and
 * no I/O.
 *
 * The fingerprint shape and note length ceiling are core's own constants; the
 * note's control-character refusal is the console's own job-intent rule
 * ({@link NOTE_CONTROL_CHAR_PATTERN}, `@psi/retentionNoteShape`), shared with
 * the server schema that enforces it.
 *
 * Regenerating the signing identity is a command-line action, not offered
 * here ({@link IDENTITY_REGENERATION_NOTICE}); the identity's location is
 * fixed to the console's one mounted working directory
 * ({@link IDENTITY_AT_REST_NOTICE}; shared-mount hazard:
 * {@link IDENTITY_SHARED_MOUNT_ADVISORY}).
 */

/**
 * The signing mode as the card offers it: core's whole `SigningMode` enum,
 * `session-derived` included. `session-derived` is offered disabled -- core
 * refuses it before a run starts (`assertSigningModeImplemented`), since no
 * code path produces that receipt.
 */
export type ReceiptsSigningMode = "none" | "session-derived" | "certificate";

/** The modes an exchange honors, and therefore the ones the card lets a draft
 * emit. An allowlist rather than a denylist, matching core's own guard: a mode
 * later added to the format is refused until it is implemented and admitted. */
const HONORED_MODES: ReadonlySet<ReceiptsSigningMode> = new Set([
  "none",
  "certificate",
]);

/** The operator's authored receipt and record-keeping choices for one exchange. */
export interface ReceiptsDraft {
  mode: ReceiptsSigningMode;
  /**
   * This party's own fingerprint, once the console has created-or-loaded the
   * signing identity and reported it. Not an input: it is the value the
   * operator shares, held here so the card can show it and the run gate can
   * tell an identity that exists from one that does not.
   */
  ownFingerprint?: string;
  /** The partner's fingerprint as raw field text; blank means no pin. */
  partnerFingerprint: string;
  /** The retention/disposition note as raw field text; blank means no note. */
  retentionDisposition: string;
}

/**
 * The card's starting state: no receipt signed, no retention note -- the
 * behaviour an exchange has without the card. An untouched draft composes the
 * same config as an exchange that never used it.
 */
export const RECEIPTS_DEFAULT: ReceiptsDraft = {
  mode: "none",
  partnerFingerprint: "",
  retentionDisposition: "",
};

/**
 * The draft with one field set. Clearing certificate mode also drops this
 * party's resolved fingerprint, so a later return to certificate mode
 * re-asks the console rather than showing a stale value -- the identity file
 * lives in a mount the operator can edit between visits.
 */
export function receiptsWithField<TField extends keyof ReceiptsDraft>(
  draft: ReceiptsDraft,
  field: TField,
  value: ReceiptsDraft[TField],
): ReceiptsDraft {
  const changed: ReceiptsDraft = { ...draft, [field]: value };
  if (changed.mode === "certificate") return changed;
  const { ownFingerprint: _dropped, ...rest } = changed;
  return { ...rest, partnerFingerprint: "" };
}

/** The subset of a job intent this card contributes. Both fields are present
 * only when the operator authored them, so an untouched draft emits the same
 * fields as an exchange that never used the card. */
export interface ReceiptsIntentFields {
  signing?: JobSigningChoice;
  retentionDisposition?: string;
}

/**
 * The fields a draft contributes to a job intent.
 *
 * A `signing` block is emitted only for `certificate`: `none` is the absent
 * block the CLI already treats as "sign nothing", and `session-derived`
 * never reaches here -- {@link receiptsProblems} blocks the run on it first.
 *
 * The partner pin and the retention note are trimmed and dropped when blank,
 * so a field the operator left alone contributes no key.
 */
export function receiptsIntentFields(
  draft: ReceiptsDraft,
): ReceiptsIntentFields {
  const note = draft.retentionDisposition.trim();
  const pin = draft.partnerFingerprint.trim();
  return {
    ...(draft.mode === "certificate"
      ? {
          signing: {
            mode: "certificate" as const,
            ...(pin !== "" ? { partnerFingerprint: pin } : {}),
          },
        }
      : {}),
    ...(note !== "" ? { retentionDisposition: note } : {}),
  };
}

/** The problem a partner fingerprint that is not a canonical digest reports. */
export const PARTNER_FINGERPRINT_PROBLEM =
  "Your partner's fingerprint must be the 43-character value 'psilink " +
  "fingerprint' prints. Copy it whole, from a channel you trust.";

/**
 * The problem certificate mode reports with no partner fingerprint pinned. A
 * block, not an advisory, matching core's own refusal
 * (`assertCertificateModePinsPartner`) before any connection opens: no
 * partner or network state can make such a run finish. Authoring itself
 * stays open -- the remedy is to run unsigned now and switch once the
 * partner's fingerprint arrives.
 */
export const NO_PARTNER_PIN_PROBLEM =
  "Enter your partner's fingerprint before signing receipts. The exchange " +
  "refuses to start without one, because nothing would be on file to check the " +
  "certificate your partner presents against. Ask them to run 'psilink " +
  "fingerprint' and send you the value over a channel you trust -- a phone " +
  "call, not the same email as the invitation. A run started without it would " +
  "fail late rather than early: it goes all the way to the point where the two " +
  "sides sign -- your data has already gone to your partner by then -- and " +
  "stops there, leaving you no results and no receipt. What you are left with " +
  "is the exchange record of what you had already disclosed: the run screen " +
  "offers it for download when the run stops, and it is written as record.json " +
  "with that run's files in the mounted folder. Discarding the run removes it. " +
  "Which side sends its " +
  "signature first is settled when the two sides meet, so on a run where this " +
  "side sends first, your partner would already have your signed receipt. To " +
  "exchange before their fingerprint arrives, choose 'No receipt' now and " +
  "switch to a certificate signature once you hold it.";

/**
 * Why the card withholds the fingerprint request while this exchange states
 * no identity: the console's boundary schema requires a non-empty label, and
 * a request made without one is a 400 the operator could not act on. The one
 * hard precondition on the card; everything else here only warns.
 */
export const IDENTITY_LABEL_REQUIRED_REASON =
  "Your signing identity is bound to who you are, and this exchange states no " +
  "name yet. Fill in 'Your name' for this exchange first: it is written into " +
  "the certificate your partner checks, and a later change does not rebind the " +
  "key.";

/**
 * Why a fingerprint cannot be asked for yet, or undefined when it can. Takes
 * the exchange's `linkage_terms.identity` as the operator has typed it so
 * far, the sole value the request holds.
 */
export function fingerprintRequestProblem(
  identity: string,
): string | undefined {
  return identity.trim() === "" ? IDENTITY_LABEL_REQUIRED_REASON : undefined;
}

/**
 * The problem certificate mode reports while this exchange names no party. A
 * block, matching core's own refusal (`assertCertificateModeNamesLocalParty`)
 * before any connection opens and the console's job schema at create time: a
 * receipt is trusted by the name in the agreed terms, so an unnamed party
 * leaves the partner nothing to check it against.
 *
 * Distinct from {@link IDENTITY_LABEL_REQUIRED_REASON}, which withholds the
 * fingerprint REQUEST for want of a name; this one holds the RUN, and is
 * reachable with a fingerprint already in hand (name entered, fingerprint
 * requested, then the name cleared). Authoring stays open; a draft asking
 * for no receipt needs no name.
 */
export const UNNAMED_PARTY_PROBLEM =
  "Fill in 'Your name' for this exchange before signing receipts. A receipt " +
  "names both parties, and the certificate you present is trusted by the name " +
  "you used in the agreed terms -- with none there, your partner has nothing " +
  "to check it against, and the exchange refuses to start. Name this party in " +
  "the terms above, or choose 'No receipt' to run unsigned, which asks for no " +
  "name at all.";

/** The problem certificate mode reports before this party's identity exists. */
export const IDENTITY_MISSING_PROBLEM =
  "Create or show your own fingerprint above before signing receipts. The " +
  "exchange refuses to start without a signing identity to sign with.";

/** The problem the unimplemented mode reports, in core's own terms: only a
 * certificate signature produces a receipt, so selecting the MAC would leave this
 * exchange with the ordinary unsigned record while the configuration asked for a
 * signature. */
export const SESSION_DERIVED_PROBLEM =
  "The session-derived receipt is not built yet, so an exchange asking for one " +
  "is refused before it runs rather than left to finish unsigned. Choose a " +
  "certificate signature, or no receipt.";

/** The problem an over-long retention note reports, stated in the ceiling core
 * puts on the record field the note is written into. */
export const RETENTION_NOTE_PROBLEM =
  `The retention note must be ${MAX_TEXT_LENGTH} characters or fewer. It is ` +
  "recorded verbatim in your exchange record, which caps it at that length.";

/** The problem a retention note containing a control character reports. A
 * tab, a line feed, or a carriage return is admissible -- the field is
 * authored in a textarea -- but any other control byte, a NUL or an ESC
 * among them, is refused: the console composes the note into the exchange
 * config and its own record verbatim, and neither is a place for a byte the
 * operator did not mean to write. */
export const RETENTION_NOTE_CONTROL_CHAR_PROBLEM =
  "The retention note must not contain a control character (a NUL or an ESC, " +
  "for instance). A tab, a line break, or a carriage return is fine -- the " +
  "console refuses any other one before the run starts.";

/**
 * Everything wrong with the draft, as messages to show beside the card --
 * empty when the draft is admissible. The run is blocked while this is
 * non-empty.
 *
 * `identity` is this exchange's `linkage_terms.identity` as authored
 * elsewhere on the page, read here because certificate mode over an unnamed
 * party is one of the refusals. It is a required argument so a caller cannot
 * forget to supply it and silently gate on less.
 *
 * Every entry mirrors a refusal the run itself would make, at the same
 * boundary that already enforces it (core, the console's job schema, or the
 * config schema); see each constant's own doc. A judgement the operator may
 * legitimately choose, rather than a refusal, belongs in
 * {@link receiptsAdvisories} instead.
 */
export function receiptsProblems(
  draft: ReceiptsDraft,
  identity: string,
): Array<string> {
  const problems: Array<string> = [];
  if (!HONORED_MODES.has(draft.mode)) problems.push(SESSION_DERIVED_PROBLEM);
  if (draft.mode === "certificate" && draft.ownFingerprint === undefined)
    problems.push(IDENTITY_MISSING_PROBLEM);
  if (draft.mode === "certificate" && identity.trim() === "")
    problems.push(UNNAMED_PARTY_PROBLEM);
  const pin = draft.partnerFingerprint.trim();
  if (draft.mode === "certificate" && pin === "")
    problems.push(NO_PARTNER_PIN_PROBLEM);
  if (
    draft.mode === "certificate" &&
    pin !== "" &&
    !FINGERPRINT_REGEX.test(pin)
  )
    problems.push(PARTNER_FINGERPRINT_PROBLEM);
  const note = draft.retentionDisposition.trim();
  if (note.length > MAX_TEXT_LENGTH) problems.push(RETENTION_NOTE_PROBLEM);
  if (NOTE_CONTROL_CHAR_PATTERN.test(note))
    problems.push(RETENTION_NOTE_CONTROL_CHAR_PROBLEM);
  return problems;
}

/**
 * What the console says about where the signing identity lands, before the
 * operator asks for one: the console's one mounted working directory,
 * because the key must outlive the job.
 *
 * True on every layout, so raised on every one, and an `info` rather than a
 * warning ({@link ReceiptsAdvisorySeverity}) -- it poses no hazard this run
 * makes live. The layout-gated hazard is
 * {@link IDENTITY_SHARED_MOUNT_ADVISORY}, raised above it where it applies.
 */
export const IDENTITY_AT_REST_NOTICE =
  "Your signing key is written into the folder you mounted, beside this " +
  "exchange's other files, because it has to outlive the run and be a file you " +
  "still have afterwards. Treat that folder like the results themselves: keep " +
  "it readable only by you, and do not put it on shared storage.";

/**
 * What the console says where the folder the key is written into is also the
 * folder the partner syncs: the rendezvous directory falls back to the data
 * root when not separately provisioned (`jobRendezvous.ts`), so a
 * shared-folder exchange on a single-mount console syncs the key's own
 * folder -- and its disclosure lets the holder forge receipts under this
 * party's identity for every exchange, not just the one shared.
 *
 * Raised only on that layout (see {@link receiptsAdvisories}); withheld
 * where the rendezvous has a mount of its own. This is the established
 * variant, for a report that positively determined the layout
 * ({@link JobRendezvousConfig.sharesDataRootUncertain} false); the hedged
 * sibling is {@link IDENTITY_SHARED_MOUNT_ADVISORY_UNCERTAIN}.
 */
export const IDENTITY_SHARED_MOUNT_ADVISORY =
  "This console rendezvouses out of the folder you mounted, so a " +
  "shared-folder exchange here syncs the very folder your signing key sits in. " +
  "On a run like that your long-lived private key sits where your partner " +
  "writes, and whoever reads it can sign receipts in your name -- for every " +
  "exchange, with every partner. Give the synced folder a mount of its own " +
  "(JOB_RENDEZVOUS_DIR), separate from this one, before you sign an exchange " +
  "that runs over it.";

/**
 * The hedged sibling of {@link IDENTITY_SHARED_MOUNT_ADVISORY}, raised where
 * the rendezvous report could not rule out the shared layout rather than
 * positively establishing it. States the layout as unruled-out rather than
 * established: an operator who checks and finds the folders separate must
 * not be told flatly that they are not.
 */
export const IDENTITY_SHARED_MOUNT_ADVISORY_UNCERTAIN =
  "psilink cannot rule out that this console rendezvouses out of the folder " +
  "you mounted, and on that layout a shared-folder exchange syncs the very " +
  "folder your signing key sits in. On a run like that your long-lived private " +
  "key sits where your partner writes, and whoever reads it can sign receipts " +
  "in your name -- for every exchange, with every partner. Give the synced " +
  "folder a mount of its own (JOB_RENDEZVOUS_DIR), separate from this one, " +
  "before you sign an exchange that runs over it.";

/**
 * What the console says about re-keying, so the operator learns it before a
 * partner's verification starts failing. Named, not offered: the console
 * has no one-click way to invalidate every pin a partner holds, and the
 * command line -- where the flag is explicit and the run is the operator's
 * own -- stays open.
 */
export const IDENTITY_REGENERATION_NOTICE =
  "Your signing identity is long-lived: the same key signs every exchange with " +
  "every partner, which is what lets a fingerprint stay pinned. Replacing it is " +
  "a command-line action -- psilink fingerprint --force -- because the new key " +
  "has a new fingerprint, and every partner who pinned the old one must be sent " +
  "the new one before their verification works again.";

/**
 * Where the signed receipt lands, and what removes it. Written with this
 * run's files, not the mounted folder's top level, since it belongs to one
 * exchange -- so discarding the run discards it too. Stated before the run,
 * since by the time an operator misses the file the run is gone.
 *
 * Offered on any settled run, not only a successful one
 * ({@link ./ReceiptDownload}): the receipt is written at the signature swap,
 * before this run's own writes, so a failed run may be the only artifact
 * left holding it.
 */
export const RECEIPT_LOCATION_NOTICE =
  "The signed receipt is written with this run's files in your mounted folder, " +
  "as receipt.json inside the run's own directory, and the run screen offers " +
  "it as a download once the run finishes or fails. Discarding the run removes " +
  "it along with the results, so keep a copy of your own if you mean to keep " +
  "it -- it is the artifact an auditor checks, and neither party can recreate " +
  "it afterwards.";

/** What the console says about the certificate export, so an operator who
 * ticks it knows what leaves the console. */
export const CERTIFICATE_EXPORT_NOTICE =
  "The export is the public certificate only -- never your private key -- and " +
  "it lands in the same mounted folder. Your partner needs only the fingerprint " +
  "to pin you; the certificate file is for an auditor who wants to check a " +
  "receipt without either party's help.";

/** What the console says about the retention note's audience and its limits. */
export const RETENTION_NOTE_NOTICE =
  "This note is filed with your own exchange record and nothing else: it is " +
  "never sent to your partner, never checked against theirs, and never part of " +
  "the agreed terms. Write where this result is filed and how long it is kept -- " +
  "never a name, an identifier, or any value from the data.";

/**
 * The weight the card shows one advisory at. Both are warn-and-guide and
 * neither blocks the run: a `warning` is what this run costs the operator
 * if started as authored; an `info` states where a file lands and how to
 * look after it. Held here, not the card, since it follows from what the
 * advisory says.
 */
export type ReceiptsAdvisorySeverity = "warning" | "info";

/** One non-blocking advisory, with the weight it is shown at. */
export interface ReceiptsAdvisory {
  message: string;
  severity: ReceiptsAdvisorySeverity;
}

/**
 * The non-blocking advisories the draft draws. Warn and guide, never a
 * block: every one is a legitimate run the command line accepts too.
 * Grouped by severity; the order here is the order within a group.
 *
 * `rendezvous` is the console's own rendezvous report, deciding the one
 * advisory about the DEPLOYMENT rather than the draft
 * ({@link IDENTITY_SHARED_MOUNT_ADVISORY} /
 * {@link IDENTITY_SHARED_MOUNT_ADVISORY_UNCERTAIN}): raised only where the
 * rendezvous folder holds the mounted working directory, and withheld only
 * on a report that positively says otherwise -- an unanswered or failed
 * probe keeps it. Which of the two messages shows follows the same report
 * (`sharesDataRootUncertain`).
 *
 * A draft the run itself would refuse belongs in {@link receiptsProblems},
 * not here.
 */
export function receiptsAdvisories(
  draft: ReceiptsDraft,
  rendezvous: JobRendezvousConfig | undefined,
): Array<ReceiptsAdvisory> {
  if (draft.mode !== "certificate") return [];
  const separatelyMounted =
    rendezvous?.configured === true && rendezvous.sharesDataRoot === false;
  const sharedLayoutEstablished =
    rendezvous?.configured === true &&
    rendezvous.sharesDataRoot === true &&
    rendezvous.sharesDataRootUncertain === false;
  return [
    ...(separatelyMounted
      ? []
      : [
          {
            message: sharedLayoutEstablished
              ? IDENTITY_SHARED_MOUNT_ADVISORY
              : IDENTITY_SHARED_MOUNT_ADVISORY_UNCERTAIN,
            severity: "warning" as const,
          },
        ]),
    { message: IDENTITY_AT_REST_NOTICE, severity: "info" },
    { message: RECEIPT_LOCATION_NOTICE, severity: "info" },
  ];
}

/**
 * The card's collapsed summary: what this exchange will produce beyond the
 * ordinary record, shown even while the card is closed. Lives with the
 * model rather than the card because which fields count is the emission
 * rule ({@link receiptsIntentFields}), not a presentation choice.
 */
export function receiptsSummary(draft: ReceiptsDraft): string {
  const fields = receiptsIntentFields(draft);
  const signed = fields.signing !== undefined;
  const noted = fields.retentionDisposition !== undefined;
  if (signed && noted) return "Signed receipt, retention note";
  if (signed) return "Signed receipt";
  if (noted) return "Retention note";
  return "Unsigned record only";
}
