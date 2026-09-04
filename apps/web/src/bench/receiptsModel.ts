import { FINGERPRINT_REGEX, MAX_TEXT_LENGTH } from "@psilink/core";

import { NOTE_CONTROL_CHAR_PATTERN } from "@psi/retentionNoteShape";

import type { JobRendezvousConfig } from "@psi/workInputClient";
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
 * line nor invent a rule of its own. The note's control-character refusal is not
 * core's: it is the console's own job-intent boundary rule
 * ({@link NOTE_CONTROL_CHAR_PATTERN}, `@psi/retentionNoteShape`), shared with the
 * server schema that enforces it so this card cannot admit a note the submit
 * step would still refuse.
 *
 * Two things are deliberately NOT here. Regenerating the signing identity is not
 * offered: a re-key invalidates every fingerprint a partner has pinned, so it
 * stays a command-line action named for what it does
 * ({@link IDENTITY_REGENERATION_NOTICE}) rather than a button beside the pin it
 * breaks -- the same treatment the sweep card gives `--force-retain-sweep`. And
 * the identity's LOCATION is not an operator choice: the appliance's one mounted
 * working directory is the only place a long-lived key both survives the job and
 * exists on the operator's own host, so the card states where the file lands
 * ({@link IDENTITY_AT_REST_NOTICE}), and what that costs on the layout where the
 * partner syncs that folder ({@link IDENTITY_SHARED_MOUNT_ADVISORY}), instead of
 * offering a placement the console could not honour.
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

/**
 * The problem certificate mode reports with no partner fingerprint pinned, in
 * the terms the run measurably behaves in rather than softened ones. Core's
 * signature swap runs inside the exchange, after the payloads have crossed, and
 * an absent pin is a hard refusal there that terminates the run; the results and
 * the receipt are written only once the exchange has returned. So a run started
 * this way would put the operator's data in their partner's hands and leave them
 * nothing back but the exchange record of that disclosure, which is a materially
 * worse outcome than a missing receipt and has to be said in those words.
 *
 * The copy places that record rather than leaving the operator to find it: the run
 * writes it into its own folder in the mounted data root, and the run screen
 * offers it there as a download once the run stops ({@link ./RecordDownload}, off
 * `recordAvailable` in jobManager, which gates on the record existing rather than
 * on the run having succeeded). What it does NOT promise is a usable pair: a
 * terminated run wrote no result file, so nothing re-supplies the commitments the
 * keys would open. And discarding the run removes both with the rest of the
 * folder, which is why the sentence names the download and the folder together.
 *
 * Nor would the refusal be symmetric across the two sides: the initiator sends
 * its own `{certificate, signature}` frame BEFORE it verifies the partner's,
 * while the responder verifies first (`exchangeSignedReceipt` in core), so on the
 * initiating side the partner would hold this party's signed receipt by the time
 * the run stopped. Which role this side takes is not the operator's to choose
 * while authoring -- a file-sync exchange settles it at rendezvous -- so the copy
 * states that disclosure conditionally, and says nothing about what the partner
 * writes down locally, which no party can observe.
 *
 * A block rather than an advisory, and the same block core makes
 * (`assertCertificateModePinsPartner`, before any connection is opened): no
 * partner and no network state can make such a run finish, so it is a
 * configuration error and not an operator posture the console defers to.
 * AUTHORING is untouched -- the mode, the fingerprint request, and the pin field
 * all stay open -- and the copy names the exit for an operator part-way through
 * the two-sided ceremony: run unsigned now, switch to a certificate signature
 * once the partner's fingerprint arrives.
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
 * Why the card withholds the fingerprint request while this exchange states no
 * identity. The one hard precondition on the whole card, and the only thing here
 * the console does not merely warn about: the appliance's boundary schema requires
 * a non-empty label, so a request made without one is a 400 the operator could not
 * have acted on -- an empty required field, not a choice of theirs to respect.
 */
export const IDENTITY_LABEL_REQUIRED_REASON =
  "Your signing identity is bound to who you are, and this exchange states no " +
  "name yet. Fill in 'Your name' for this exchange first: it is written into " +
  "the certificate your partner checks, and a later change does not rebind the " +
  "key.";

/**
 * Why a fingerprint cannot be asked for yet, or undefined when it can. Takes the
 * exchange's `linkage_terms.identity` as the operator has typed it so far, which
 * is the sole value the request carries.
 */
export function fingerprintRequestProblem(
  identity: string,
): string | undefined {
  return identity.trim() === "" ? IDENTITY_LABEL_REQUIRED_REASON : undefined;
}

/**
 * The problem certificate mode reports while this exchange names no party, in the
 * same terms as {@link NO_PARTNER_PIN_PROBLEM}: a run configured this way cannot
 * finish. A receipt names both parties, and a certificate is trusted by the
 * identity its holder used in the AGREED TERMS rather than the one the
 * certificate carries, so an unnamed party leaves its partner nothing to check
 * the certificate against -- core refuses such a run before any connection is
 * opened (`assertCertificateModeNamesLocalParty`), and the appliance's job schema
 * refuses the intent at create time.
 *
 * A block for the same reason the missing pin is one: no partner and no network
 * state makes the run finish. It is not a re-statement of
 * {@link IDENTITY_LABEL_REQUIRED_REASON}, which withholds the fingerprint REQUEST
 * for want of a name to bind; this one holds the RUN, and is reachable with a
 * fingerprint already in hand -- a name entered, a fingerprint requested, then the
 * name cleared. The remedy names the field and the unsigned exit, which is what
 * keeps this a gate on the certificate configuration rather than a name every
 * exchange must state: authoring stays open, and a draft asking for no receipt is
 * asked for no name.
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

/** The problem a retention note carrying a control character reports. A tab,
 * a line feed, or a carriage return is admissible -- the field is authored in
 * a textarea -- but any other control byte, a NUL or an ESC among them, is
 * refused: the appliance composes the note into the exchange config and its
 * own record verbatim, and neither is a place for a byte the operator did not
 * mean to write. */
export const RETENTION_NOTE_CONTROL_CHAR_PROBLEM =
  "The retention note must not contain a control character (a NUL or an ESC, " +
  "for instance). A tab, a line break, or a carriage return is fine -- the " +
  "console refuses any other one before the run starts.";

/**
 * Everything wrong with the draft, as messages to show beside the card -- empty
 * when it is admissible. The run is blocked while this is non-empty.
 *
 * `identity` is this exchange's `linkage_terms.identity` as the operator has it
 * so far -- authored elsewhere on the page, but read here because one refusal
 * turns on it: certificate mode over an exchange that names no party. It is a
 * required argument rather than an optional one so a surface that gates a run on
 * this cannot forget to supply it and silently gate on less.
 *
 * Every entry is a refusal the RUN itself would make: core refuses the
 * unimplemented mode before the exchange starts, the CLI exits 64 on certificate
 * mode with no identity file, core refuses certificate mode with no partner pin
 * ({@link NO_PARTNER_PIN_PROBLEM}) and certificate mode over terms that name no
 * party ({@link UNNAMED_PARTY_PROBLEM}) before any connection is opened -- and
 * the appliance's job schema refuses both intents at create time -- and the config
 * schema refuses a non-canonical pin and an over-long note. The server's
 * job-intent schema refuses a note carrying a control character the same way, so
 * that rule is mirrored here too ({@link NOTE_CONTROL_CHAR_PATTERN}) --
 * otherwise a pasted control byte would report no card problem and fail only at
 * submit with a generic message. None of them is a judgement about a value both
 * boundaries accept: what the console warns and guides about instead, because
 * the operator may legitimately choose it, is in {@link receiptsAdvisories}.
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
 * operator asks for one. The console has one mounted working directory and the key
 * must outlive the job, so that folder is the only place it can go -- and it is
 * the folder this exchange's other material is already in.
 *
 * True on EVERY layout, so it is raised on every one: the key is at rest in a
 * folder on the operator's own host whatever the rendezvous is provisioned as, and
 * how that folder is looked after is the operator's to act on. It carries no
 * hazard this run makes live, which is why it is an `info` beside
 * {@link RECEIPT_LOCATION_NOTICE} rather than a warning
 * (see {@link ReceiptsAdvisorySeverity}); the layout-gated hazard is
 * {@link IDENTITY_SHARED_MOUNT_ADVISORY}, which the same card raises above it
 * where it applies.
 */
export const IDENTITY_AT_REST_NOTICE =
  "Your signing key is written into the folder you mounted, beside this " +
  "exchange's other files, because it has to outlive the run and be a file you " +
  "still have afterwards. Treat that folder like the results themselves: keep " +
  "it readable only by you, and do not put it on shared storage.";

/**
 * What the console says where the folder the key is written into is also the folder
 * the partner syncs: the rendezvous directory falls back to the data root when it is
 * not separately provisioned (`jobRendezvous.ts`), so on a single-mount appliance a
 * shared-folder exchange syncs the very folder holding this key -- and its
 * disclosure lets the holder forge receipts under this party's identity for every
 * exchange, not just the one the partner shares. The advisory names that collision
 * where the operator chooses to sign rather than only in the deployment guide, which
 * documents the split layout that resolves it. Warn and guide: the operator's own
 * machine and the operator's own directory layout, so the practice worth following
 * is stated rather than enforced.
 *
 * Raised on that layout ALONE (see {@link receiptsAdvisories}). An appliance whose
 * rendezvous has a mount of its own has already done what the closing sentence asks
 * for, and an advisory that fires there too would spend the warning channel on a
 * hazard that is not live -- which is what makes the same channel's live warnings
 * worth reading. What the key-hygiene half of the news is holds on every layout and
 * is stated separately ({@link IDENTITY_AT_REST_NOTICE}), so withholding this one
 * leaves the card saying where the key lands rather than saying nothing about it.
 *
 * Two variants carry this news, chosen by what the rendezvous report established
 * (see {@link receiptsAdvisories}): this one states the shared layout as fact,
 * for the case the report positively determined it -- a lexical or filesystem
 * match ({@link JobRendezvousConfig.sharesDataRootUncertain} false). The report is
 * fail-closed rather than silent where it could not determine the layout -- a leg
 * or a data root whose real path cannot be read counts as holding
 * (`jobRendezvous.ts`), and an appliance that has not answered keeps the advisory
 * too -- and that case takes {@link IDENTITY_SHARED_MOUNT_ADVISORY_UNCERTAIN}
 * instead, so an operator who checks and finds the folders separate is never told
 * flatly that they are not.
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
 * The hedged sibling of {@link IDENTITY_SHARED_MOUNT_ADVISORY}, raised where the
 * rendezvous report could not rule out the shared layout rather than positively
 * establishing it -- an appliance that has not answered, or a comparison the walk
 * defaulted on rather than matched. States the layout as unruled-out rather than
 * established, since that is all raising it in this case means: an operator who
 * checks and finds the folders separate must not have been told flatly that they
 * are not.
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

/**
 * Where the signed receipt lands, and what removes it. The receipt is written
 * with this run's files rather than into the mounted folder's top level -- it
 * belongs to one exchange, unlike the identity -- so discarding the run discards
 * it too. Stated before the run rather than after, because by the time an
 * operator misses the file the run they would have copied it from is gone. It
 * names the download alongside the folder, so an operator reading this while
 * authoring knows the keeping step does not require reaching into the mount --
 * and names WHERE that download appears, since this notice renders on the
 * authoring screens and the control it points at renders on the run screen.
 *
 * That control is offered on any SETTLED run rather than a successful one
 * ({@link ./ReceiptDownload}): the receipt is written at the signature swap,
 * before this run's own writes, so a failure is precisely the run whose receipt
 * may be the only artifact left. The sentence therefore names failure outright,
 * an operator being free to read "finishes" as "succeeds" and never go looking
 * after a run that failed.
 */
export const RECEIPT_LOCATION_NOTICE =
  "The signed receipt is written with this run's files in your mounted folder, " +
  "as receipt.json inside the run's own directory, and the run screen offers " +
  "it as a download once the run finishes or fails. Discarding the run removes " +
  "it along with the results, so keep a copy of your own if you mean to keep " +
  "it -- it is the artifact an auditor checks, and neither party can recreate " +
  "it afterwards.";

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
 * The weight the card shows one advisory at. Both are warn-and-guide and neither
 * blocks the run, but they are not the same news: a `warning` is what this run
 * costs the operator if they start it as authored, while an `info` states where a
 * file lands and how to look after it. Carried here rather than in the card
 * because it follows from what the advisory says, not from how it is laid out.
 */
export type ReceiptsAdvisorySeverity = "warning" | "info";

/** One non-blocking advisory, with the weight it is shown at. */
export interface ReceiptsAdvisory {
  message: string;
  severity: ReceiptsAdvisorySeverity;
}

/**
 * The non-blocking advisories the draft draws. Warn and guide, never a block:
 * every one of these is a legitimate run the command line accepts too. The card
 * groups them by severity, so the order here is the order within a group.
 *
 * `rendezvous` is this appliance's own rendezvous report, which decides the one
 * advisory that is about the DEPLOYMENT rather than the draft
 * ({@link IDENTITY_SHARED_MOUNT_ADVISORY} / {@link
 * IDENTITY_SHARED_MOUNT_ADVISORY_UNCERTAIN}): it is raised only where a rendezvous
 * folder holds the mounted working directory, the layout in which the partner syncs
 * the folder the signing key sits in. Withheld only on a report that positively says
 * otherwise -- an appliance that has not answered yet, or one whose probe failed,
 * keeps the advisory, since an unread report is not evidence of a separate mount.
 * Which of the two messages is shown follows the same report: the established
 * variant only where the report positively determined the layout
 * (`sharesDataRootUncertain: false`), the hedged variant everywhere else the
 * advisory is raised. The two notices are unchanged by the layout: where the
 * receipt lands, and the at-rest notice about the key file, which is news on every
 * layout and is what a card on a separately-mounted appliance still says about
 * where the key lands.
 *
 * A draft the run itself would refuse belongs in {@link receiptsProblems}, not
 * here: an advisory the operator cannot proceed past is a block wearing the
 * wrong weight.
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
