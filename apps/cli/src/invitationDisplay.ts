import { sanitizeForDisplay, summarizeInvitation } from "@psilink/core";

import { singlePassDisclosureNotice } from "./onlineBootstrap";

import type {
  InvitationKeySummary,
  InvitationSummary,
  InvitationToken,
  getLogger,
} from "@psilink/core";

/**
 * The forward-reference wording the outbound-send line carries when the acceptor's
 * own disclosed set is not yet determined at prompt time -- no input file (offline
 * accept without one) or an input whose columns cannot satisfy the invitation's
 * linkage keys, both of which leave the resolved spec without metadata. It points
 * ahead to the operator's input file rather than asserting a count it cannot yet know,
 * mirroring the web acceptor's pre-file forward-reference.
 */
const OUTBOUND_SEND_FORWARD_REFERENCE = "determined from your input file";

/** The lock-in wording a declared-but-empty payload direction carries: an empty
 * declaration is a strict "nothing crosses in this direction", not an absent one. */
const EMPTY_PAYLOAD_LOCK_IN =
  "(none) -- any payload column would abort the exchange";

/**
 * Emits one indented line per entry, so a name containing the list separator
 * cannot be misread as two entries: `sanitizeForDisplay` neutralizes control,
 * bidi, and non-ASCII code points but leaves a printable ASCII comma intact, and
 * every list this renders holds partner- or operator-controlled names.
 */
function logList(
  log: ReturnType<typeof getLogger>,
  indent: string,
  entries: ReadonlyArray<string>,
): void {
  for (const entry of entries) log.info(`${indent}- ${entry}`);
}

/**
 * The declared matching rules of one linkage key: its ordered elements with the
 * field each derives from, the transforms it applies (each with the plain-language
 * consequence, its parameters, and any runtime coercion), the fuzzy-comparison
 * expansion it declares, and the swap the key declares over two of them.
 *
 * Every value here arrives already escaped from {@link summarizeInvitation}, the
 * single display boundary; nothing is escaped again (a second pass would double a
 * backslash in a partner name). The key's `id` -- the raw, unsanitized key name --
 * is deliberately untouched: `name` is the displayable form.
 */
function displayLinkageKey(
  log: ReturnType<typeof getLogger>,
  key: InvitationKeySummary,
): void {
  log.info(`    - ${key.name}`);
  // The derived field one-liner, above the declared rules: the key's `name` is
  // partner free text and is the only other line at this key's own level, so
  // without this the operator scanning key headings reads nothing but strings the
  // inviter chose. Every entry here is a fixed compact label for the element's
  // schema-validated field type plus a fixed breadth marker, so the joined line
  // carries no partner text and cannot be misread across the separator.
  log.info(
    `      matches on: ${key.headerFields.join(" - ")}` +
      (key.hasSwap ? " (matched in either order)" : ""),
  );
  log.info("      elements:");
  for (const element of key.elements) {
    log.info(`        - ${element.fieldLabel}`);
    if (element.fuzzyComparison !== undefined)
      log.info(
        `          also matches approximate variants (${element.fuzzyComparison})` +
          (element.fuzzyComparisonApplied
            ? ""
            : " (proposed; not yet applied)"),
      );
    for (const transform of element.transforms) {
      log.info(`          transform: ${transform.function}`);
      // Lead with the plain matching consequence where there is one: the literal
      // slice phrase when it is faithful, else the glossary description. A function
      // the standardization layer does not recognize has neither, and would
      // otherwise print in the same shape as a recognized rule minus one line --
      // indistinguishable from a rule psilink understands. Mark it instead, so a
      // rule this version cannot explain is as explicit as one it cannot apply.
      if (transform.effect !== undefined)
        log.info(`            matches on ${transform.effect}`);
      else if (transform.description !== undefined)
        log.info(`            ${transform.description}`);
      else
        log.info(
          "            not recognized by this version; its effect on matching " +
            "is not shown",
        );
      logList(log, "            ", transform.params);
      // The coercion note is core-derived on both halves (the function's own
      // parameter name and the value core's coercion contract runs it as), and sits
      // on its own line rather than folded into a parameter line, so partner text
      // placed inside a parameter value cannot impersonate it.
      for (const coercion of transform.coercions ?? [])
        log.info(`            ${coercion.param} runs as ${coercion.runsAs}`);
    }
  }
  if (key.hasSwap)
    log.info(
      key.swap !== undefined
        ? `      swap: ${key.swap[0]} and ${key.swap[1]} may be matched in either order`
        : "      swap: two of these elements may be matched in either order",
    );
  // On the receiving side a swap moves each element's field reference to the other
  // element while its transforms stay put, so each element's rules run against the
  // OTHER element's value. The generic swap note above does not convey that, so the
  // interchange (both sides carry transforms) or the one-directional donor (exactly
  // one does) is stated outright.
  if (key.swapTransformInterchange && key.swap !== undefined)
    log.info(
      `      note: when matched in that order, the transforms shown for ` +
        `${key.swap[0]} are applied to ${key.swap[1]}'s value, and those for ` +
        `${key.swap[1]} to ${key.swap[0]}'s value`,
    );
  if (key.swapTransformDonor !== undefined)
    log.info(
      `      note: when matched in that order, the transforms shown for ` +
        `${key.swapTransformDonor[0]} are applied to ` +
        `${key.swapTransformDonor[1]}'s value`,
    );
}

/**
 * The PII the linkage keys are computed over, each field with the data standards
 * the inviter commits it to. The constraint phrases are fixed copy derived from the
 * schema; the allowed-character class is a partner-authored regular expression and
 * is labelled as unverified rather than paraphrased as a vetted allow-list, since a
 * crafted class (a leading `^` negation, a shorthand or bracket breakout) admits a
 * very different set than it reads as.
 */
function displayLinkageFields(
  log: ReturnType<typeof getLogger>,
  summary: InvitationSummary,
): void {
  log.info("  personal data used:");
  for (const field of summary.linkageFields) {
    log.info(`    - ${field.label}`);
    logList(log, "      ", field.constraints);
    if (field.allowedCharacters !== undefined)
      log.info(
        `      allowed characters (partner-supplied, unverified): ` +
          field.allowedCharacters,
      );
  }
}

/**
 * @internal exported for testing
 *
 * Print, before the acceptance prompt, everything the operator is consenting to:
 * their own outbound disclosure first, then every term of the inviter's proposal
 * that decides what is matched or what is disclosed -- under `psi` what is matched
 * decides which identifiers are revealed, so a matching rule this omitted would be
 * consented to unseen.
 *
 * What the operator SEES is narrower than what this prints, and the difference is
 * not something this function can close: it writes through `log.info`, so
 * `--log-file` (which replaces the stderr sink outright) or a `--log-level` above
 * info routes the whole surface away from the terminal, while `promptConfirm`
 * writes its question straight to stderr and still asks. The limit is recorded for
 * the operator in docs/CLI.md, under acceptance.
 *
 * The inviter's terms are read through `summarizeInvitation`, the display model the
 * web consent screen renders from, so the two surfaces cannot drift on what an
 * acceptor is shown or on the escaping of the partner-controlled strings in it. A
 * term today's exchange does not apply (`psi-c`, `deduplicate`, and the per-element
 * fuzzy expansion) is marked as proposed, so the prompt never states a matching
 * behavior the run does not perform.
 *
 * `ownOutboundSend` is the columns THIS party will disclose to the partner for
 * matched records -- its own outbound disclosure, the hardest-to-undo fact it
 * consents to here. It is `disclosedColumnNames` over the acceptor's own resolved
 * metadata (exactly the set `preparePayload` transmits), so the prompt cannot
 * overstate what leaves this machine; `undefined` when that set is not yet
 * determined at prompt time (see {@link OUTBOUND_SEND_FORWARD_REFERENCE}), an empty
 * array when the acceptor discloses nothing. Unlike the inviter's terms these names
 * are operator-file strings that reach no display boundary of their own, so they are
 * escaped here, at their sink.
 */
export function displayInvitation(
  token: InvitationToken,
  ownOutboundSend: ReadonlyArray<string> | undefined,
  log: ReturnType<typeof getLogger>,
): void {
  const summary = summarizeInvitation(token);
  log.info("Invitation details:");
  // Lead with the acceptor's OWN outbound disclosure -- the columns it will send to
  // the partner for matched records, its hardest-to-undo consent -- before the
  // inviter's proposed terms, matching the web acceptor flow. undefined is the
  // not-yet-known case (no metadata resolved): forward-reference rather than assert
  // a count. An empty set is a truthful "(none)", not a presupposed non-empty
  // disclosure.
  if (ownOutboundSend === undefined)
    log.info(`  columns you will send: ${OUTBOUND_SEND_FORWARD_REFERENCE}`);
  else if (ownOutboundSend.length === 0)
    log.info("  columns you will send: (none) -- only matched records");
  else {
    log.info("  columns you will send:");
    logList(
      log,
      "    ",
      ownOutboundSend.map((column) => sanitizeForDisplay(column)),
    );
  }

  log.info(`  inviting party: ${summary.invitingParty}`);
  log.info(`  PSI algorithm: ${summary.algorithm}`);
  // A proposed count-only algorithm states a DISCLOSURE guarantee the run does not
  // honor, so the caveat sits with the headline it contradicts. What not-applied
  // means here is a refusal, not a looser run: the acceptor adopts the algorithm
  // verbatim and every run path asserts it (assertAlgorithmImplemented), so the
  // exchange aborts before any identifier is revealed. Name that, and what to ask
  // the inviter for, the way the deduplicate note below does.
  if (summary.algorithm === "psi-c" && !summary.psiCApplied)
    log.info(
      "  note: the inviting party proposes a count-only exchange, but this " +
        "version does not yet apply it and will refuse to run; ask for an " +
        'invitation using the "psi" algorithm.',
    );
  // The linkage strategy is a mandatory-consistency term (like the algorithm),
  // and single-pass is disclosure-affecting -- it is the load-bearing thing the
  // acceptor consents to here -- so show it plainly and, for single-pass, the
  // disclosure-tradeoff note. The value is a schema enum, not partner free text;
  // the note is shared with the inviter's selection surface so both parties read
  // identical framing.
  log.info(`  linkage strategy: ${summary.linkageStrategy}`);
  if (summary.linkageStrategy === "single-pass")
    log.info(`  note: ${singlePassDisclosureNotice()}`);
  // Stated from the accepting party's perspective (this summary is shown only to
  // the acceptor, before it confirms): YOU receive iff the inviter shares, and the
  // inviter receives iff its terms expect output. For a one-sided invitation this
  // tells the acceptor plainly whether it gets a result, rather than leaving it to
  // invert the inviter's "shares with partner" bit.
  log.info(
    `  you will receive the result: ${summary.inviterSharesResult ? "yes" : "no"}`,
  );
  log.info(
    `  the inviting party will receive the result: ` +
      `${summary.inviterReceivesOutput ? "yes" : "no"}`,
  );
  log.info(
    `  duplicate matches: ` +
      (summary.deduplicate
        ? "a record may match more than one of the partner's records"
        : "each record matches at most one of the partner's records"),
  );
  if (summary.deduplicate && !summary.deduplicateApplied)
    log.info(
      "  note: the inviting party proposes this, but this version does not " +
        "yet apply it and will refuse to run; ask for an invitation without " +
        "deduplication.",
    );

  // The fields the keys actually match on, one short line ahead of the two long
  // matching blocks, so the single fact consent most depends on is legible without
  // scrolling back through the keys and their combinations. Each entry is a fixed
  // compact label for a schema-validated field type, so the joined line carries no
  // partner text.
  if (summary.matchedFields.length > 0)
    log.info(`  matched on: ${summary.matchedFields.join(", ")}`);

  // The short, high-level field list precedes the long key list: the keys enumerate
  // the combinations OF these fields, and on a terminal the block printed second is
  // the one that scrolls the first off the screen.
  displayLinkageFields(log, summary);
  log.info("  linkage keys:");
  for (const key of summary.linkageKeys) displayLinkageKey(log, key);

  // The columns the inviter declares it will transmit for matched records, in the
  // inviter's namespace -- what this party will RECEIVE. Derived from the wire's own
  // disclosure predicate (the token's carried disclosedPayloadColumns) when the
  // invitation carries one, falling back to the authored payload.send otherwise. A
  // declared-but-empty set is a real "you will receive no payload columns" lock-in (a
  // later non-empty payload aborts), shown as (none); a lazy send -- no carried subset
  // and nothing authored -- is omitted, since it reconciles at exchange time.
  if (summary.payload?.sendDeclared === true) {
    if (summary.payload.send.length === 0)
      log.info(`  columns you will receive: ${EMPTY_PAYLOAD_LOCK_IN}`);
    else {
      log.info("  columns you will receive:");
      logList(log, "    ", summary.payload.send);
    }
  }
  // The opposite direction: the columns the inviter requests FROM this party for
  // matched records -- what YOU may send. A declared receive (present, even if
  // empty) is cross-checked: an empty set strictly asserts you send nothing (a
  // non-empty send then aborts), shown as (none); an absent receive reconciles
  // lazily (the inviter takes whatever your metadata discloses) and is omitted.
  if (summary.payload?.receiveDeclared === true) {
    if (summary.payload.receive.length === 0)
      log.info(
        `  columns the inviting party requests from you: ${EMPTY_PAYLOAD_LOCK_IN}`,
      );
    else {
      log.info("  columns the inviting party requests from you:");
      logList(log, "    ", summary.payload.receive);
    }
  }

  if (summary.legalAgreement !== undefined) {
    log.info("  legal agreement:");
    log.info(`    reference: ${summary.legalAgreement.reference}`);
    // "stated purpose", not "purpose": the value is partner-authored free text,
    // sanitized but never vetted -- only byte-compared against this party's own copy
    // at exchange time -- so the label marks it as partner-attested.
    log.info(`    stated purpose: ${summary.legalAgreement.purpose}`);
    log.info(
      `    agreement valid through: ${summary.legalAgreement.expirationDate}`,
    );
  }

  if (summary.expires !== undefined) log.info(`  expires: ${summary.expires}`);
}
