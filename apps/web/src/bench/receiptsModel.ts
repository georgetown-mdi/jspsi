import { FINGERPRINT_REGEX, MAX_TEXT_LENGTH } from "@psilink/core";

import type { JobSigningChoice } from "@jobs/intent";

/**
 * The pure model behind the console's "Receipts and record keeping" card: whether
 * this exchange signs a third-party-verifiable receipt, whose certificate it
 * trusts to verify the partner's, and the retention note it files with its own
 * exchange record.
 *
 * No React and no I/O, so the emitted intent fields, what the card refuses before
 * the run, and the advisories it raises are the tested boundary. The values
 * themselves are core's -- the fingerprint shape and the note's length ceiling are
 * core's exported constants -- so the console can neither drift from the command
 * line nor invent a rule of its own.
 *
 * Two things are deliberately NOT here. Regenerating the signing identity is not
 * offered: a re-key invalidates every fingerprint a partner has pinned, so it
 * stays a command-line action named for what it does
 * ({@link IDENTITY_REGENERATION_NOTICE}) rather than a button beside the pin it
 * breaks -- the same treatment the sweep card gives `--force-retain-sweep`. And
 * the identity's LOCATION is not an operator choice: the appliance's one mounted
 * working directory is the only place a long-lived key both survives the job and
 * exists on the operator's own host, so the card states where the file lands and
 * what that means ({@link IDENTITY_LOCATION_ADVISORY}) instead of offering a
 * placement the console could not honour.
 */

/**
 * The signing mode as the CARD offers it, which is core's whole
 * `SigningMode` enum -- `session-derived` included, so the choice the operator
 * faces is the one the configuration format has. It is offered DISABLED: core
 * refuses it before an exchange runs (`assertSigningModeImplemented`), because no
 * code path produces such a receipt, and a run that completed unsigned while the
 * configuration asked for a signature would say nothing about it. The same
 * treatment the algorithm and deduplicate controls give their unimplemented
 * values.
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
   * This party's own fingerprint, once the appliance has created-or-loaded the
   * signing identity and reported it. Not an input: it is the value the operator
   * SHARES, held here so the card can show it and so the run gate can tell an
   * identity that exists from one that does not.
   */
  ownFingerprint?: string;
  /** The partner's fingerprint as raw field text; blank means no pin. */
  partnerFingerprint: string;
  /** The retention/disposition note as raw field text; blank means no note. */
  retentionDisposition: string;
}

/**
 * The card's starting state: no receipt signed and no retention note, which is the
 * behaviour a console exchange has without the card. An untouched draft therefore
 * composes a config byte-identical to the one composed before this surface
 * existed.
 */
export const RECEIPTS_DEFAULT: ReceiptsDraft = {
  mode: "none",
  partnerFingerprint: "",
  retentionDisposition: "",
};

/**
 * The draft with one field set. Clearing certificate mode also drops this party's
 * resolved fingerprint, so a later return to certificate mode re-asks the
 * appliance rather than showing a value nothing has re-confirmed -- the identity
 * file lives in a mount the operator can edit between visits.
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

/** The subset of a job intent this card contributes. Both fields are present only
 * when the operator authored them, so a run that changed nothing sends the intent
 * it sent before the card existed. */
export interface ReceiptsIntentFields {
  signing?: JobSigningChoice;
  retentionDisposition?: string;
}

/**
 * The fields a draft contributes to a job intent.
 *
 * A `signing` block is emitted only for `certificate`: `none` is the absent block
 * the CLI already reads as "sign nothing", so emitting one would put a key in the
 * composed config that changes nothing. `session-derived` emits nothing either --
 * {@link receiptsProblems} blocks the run on it, so no intent is built from such
 * a draft in the first place, and the boundary schema refuses the value regardless.
 *
 * The partner pin and the retention note are trimmed and dropped when blank, so a
 * field the operator opened and left alone contributes no key.
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

/**
 * Everything wrong with the draft, as messages to show beside the card -- empty
 * when it is admissible. The run is blocked while this is non-empty.
 *
 * Every entry is a refusal the RUN itself would make: core refuses the
 * unimplemented mode before the exchange starts, the CLI exits 64 on certificate
 * mode with no identity file, and the config schema refuses a non-canonical pin
 * and an over-long note. None of them is a judgement about a value both
 * boundaries accept -- certificate mode with no partner pin is legitimate and
 * draws an advisory, not a block.
 */
export function receiptsProblems(draft: ReceiptsDraft): Array<string> {
  const problems: Array<string> = [];
  if (!HONORED_MODES.has(draft.mode)) problems.push(SESSION_DERIVED_PROBLEM);
  if (draft.mode === "certificate" && draft.ownFingerprint === undefined)
    problems.push(IDENTITY_MISSING_PROBLEM);
  const pin = draft.partnerFingerprint.trim();
  if (
    draft.mode === "certificate" &&
    pin !== "" &&
    !FINGERPRINT_REGEX.test(pin)
  )
    problems.push(PARTNER_FINGERPRINT_PROBLEM);
  if (draft.retentionDisposition.trim().length > MAX_TEXT_LENGTH)
    problems.push(RETENTION_NOTE_PROBLEM);
  return problems;
}

/**
 * What the console says about where the signing identity lands, before the
 * operator asks for one. The console has one mounted working directory and the key
 * must outlive the job, so that folder is the only place it can go -- and it is
 * the folder this exchange's other material is already in. Warn and guide: the
 * operator's own machine, the operator's own folder, and the practice worth
 * following is stated rather than enforced.
 */
export const IDENTITY_LOCATION_ADVISORY =
  "Your signing key is written into the folder you mounted, beside this " +
  "exchange's other files, because it has to outlive the run and be a file you " +
  "still have afterwards. Treat that folder like the results themselves: keep " +
  "it readable only by you, and do not put it on shared storage.";

/**
 * What the console says about re-keying, so the operator learns it here rather
 * than from a partner whose verification started failing. Named, not offered: the
 * console carries no one-click way to invalidate every pin a partner holds, and
 * the command line -- where the flag is spelled out and the run is the operator's
 * own -- stays open.
 */
export const IDENTITY_REGENERATION_NOTICE =
  "Your signing identity is long-lived: the same key signs every exchange with " +
  "every partner, which is what lets a fingerprint stay pinned. Replacing it is " +
  "a command-line action -- psilink fingerprint --force -- because the new key " +
  "has a new fingerprint, and every partner who pinned the old one must be sent " +
  "the new one before their verification works again.";

/** What the console says about signing without a partner pin: this side still
 * signs and the receipt is still written, but nothing anchors the partner's half
 * of it, so the run cannot verify what the partner presents. */
export const NO_PARTNER_PIN_ADVISORY =
  "Without your partner's fingerprint, this exchange cannot verify the " +
  "certificate they present, so the signature swap fails and no receipt is " +
  "written. Ask them to run 'psilink fingerprint' and send you the value over a " +
  "channel you trust -- a phone call, not the same email as the invitation.";

/**
 * Where the signed receipt lands, and what removes it. The receipt is written
 * with this run's files rather than into the mounted folder's top level -- it
 * belongs to one exchange, unlike the identity -- so discarding the run discards
 * it too. Stated before the run rather than after, because by the time an
 * operator misses the file the run they would have copied it from is gone.
 */
export const RECEIPT_LOCATION_NOTICE =
  "The signed receipt is written with this run's files in your mounted folder, " +
  "as receipt.json inside the run's own directory. Discarding the run removes " +
  "it along with the results, so copy it somewhere of your own if you mean to " +
  "keep it -- it is the artifact an auditor checks, and neither party can " +
  "recreate it afterwards.";

/** What the console says about the certificate export, so an operator who ticks
 * it knows what leaves the appliance. */
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
 * The non-blocking advisories the draft draws. Warn and guide, never a block:
 * every one of these is a legitimate run the command line accepts too.
 */
export function receiptsAdvisories(draft: ReceiptsDraft): Array<string> {
  if (draft.mode !== "certificate") return [];
  return [
    IDENTITY_LOCATION_ADVISORY,
    RECEIPT_LOCATION_NOTICE,
    ...(draft.partnerFingerprint.trim() === ""
      ? [NO_PARTNER_PIN_ADVISORY]
      : []),
  ];
}

/**
 * The card's collapsed summary, so a closed card is not a blind box: what this
 * exchange will produce beyond the ordinary record. Lives with the model rather
 * than the card because which fields count is the emission rule
 * ({@link receiptsIntentFields}), not a presentation choice.
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
