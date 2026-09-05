// The two-party half of linkage terms: what an ACCEPTOR runs after adopting an
// inviter's terms, and whether the two parties' terms agree closely enough to
// run at all. Neither is configuration parsing -- both read terms already
// parsed by the schema in config/linkageTermsSchema.ts -- and both are driven by the
// exchange rather than by a document load.

import { UsageError } from "./errors.js";
import { canonicalString, CanonicalEncodingError } from "./utils/canonical.js";
import { redactAndSanitizeForDisplay } from "./utils/sanitizeErrorForDisplay.js";
import {
  bareTermsValue,
  compatibilityMessage,
  quoteTermsValue,
  quoteTermsValueList,
  ruleSetCitation,
} from "./config/compatibilityMessage.js";
import type { CompatibilityMessageFragment } from "./config/compatibilityMessage.js";
import {
  assertCountOnlyTermsShape,
  assertDeduplicateImplemented,
} from "./linkageTermsPolicy.js";
import {
  LinkageTermsSchema,
  MAX_TEXT_LENGTH,
  TEXT_CONTROL_CHAR_MESSAGE,
  TEXT_CONTROL_CHAR_PATTERN,
} from "./config/linkageTermsSchema.js";
import type {
  LinkageField,
  LinkageRuleSetReference,
  LinkageTerms,
  Payload,
  PayloadColumn,
} from "./config/linkageTermsSchema.js";

/**
 * Derive the {@link LinkageTerms} an ACCEPTOR runs from the inviter's terms
 * decoded from an invitation. The acceptor adopts the inviter's shared,
 * agreed fields verbatim -- `version`, `algorithm`, `linkageFields`,
 * `linkageKeys`, `linkageRuleSet`, `legalAgreement`, and so on are
 * cross-checked for equality at exchange time -- but four facets are the
 * acceptor's own perspective and are derived, not copied:
 *
 * - `identity` is replaced with the acceptor's own name (a CLI flag or
 *   prompt, a browser field), so the inviter's identity does not leak into
 *   the acceptor's terms. Held here to the same rules the schema holds a
 *   party `identity` to (control characters, non-empty,
 *   {@link MAX_TEXT_LENGTH}), under a refusal naming the local input,
 *   rather than at the generic re-check below.
 * - `output` is MIRRORED, not copied: {@link validateCompatibility} compares
 *   it as a mirror (`local.expectsOutput` against `partner.shareWithPartner`
 *   and vice versa), so a verbatim copy is only accidentally correct for the
 *   symmetric "both receive" case.
 * - `payload` is MIRRORED for the same reason: the acceptor's `send` becomes
 *   the inviter's `receive` and vice versa. An absent inviter `receive`
 *   yields an absent acceptor `send` (lazy); an explicit empty inviter
 *   `receive: []` yields an explicit empty acceptor `send: []` (strict),
 *   matching {@link validateCompatibility}'s lazy/strict reading.
 * - `deduplicate` is DEFAULTED to false, neither copied nor mirrored: it is
 *   per-party and declares that several of the DECLARING party's own
 *   records may match the partner's, so it is never the inviter's to set
 *   for the acceptor -- copying it would let a hostile inviter claim
 *   `deduplicate: true` to put the acceptor on the "many" side, then
 *   present `false` at the terms exchange. The invitation's declared value
 *   for the inviter's own side is retained separately by a caller holding
 *   the token, as `expectedPartnerDeduplicate` (`PreparedExchange`,
 *   exchange.ts); its widened-disclosure consequence for the acceptor is
 *   stated on the consent surfaces (`DEDUPLICATE_ACCEPTOR_SIDE_NOTE`).
 *
 * Metadata and standardization stay per-party and local; this function
 * shapes only the agreed linkage terms.
 *
 * It fails closed: a config valid for the INVITER can mirror to one
 * incoherent for the acceptor (an inviter that is the sole receiver may
 * have a `payload.send` that needs the acceptor to receive output, but the
 * acceptor mirrors to `expectsOutput: false`). The derived terms are
 * re-checked against {@link LinkageTermsSchema} and an incoherent result
 * throws, aborting acceptance cleanly. The re-check's message names no
 * partner-controlled value: `identity` -- the one substituted value, and the
 * accepting operator's own -- is refused above under an account naming the
 * local input if it fails its own rules, so nothing the operator supplied
 * reaches this message.
 *
 * It also refuses a `psi-c` document outside the count-only shape
 * ({@link assertCountOnlyTermsShape}) and a deduplicating invitation under a
 * strategy that cannot match one ({@link assertDeduplicateImplemented}),
 * both read from the INVITER's terms before the mirror is built, so the
 * refusal names the rule the received document breaks and keeps such an
 * invitation off the consent surfaces and off the wire.
 *
 * @throws {UsageError} when `acceptorIdentity` contains a control character,
 *   is empty, or exceeds {@link MAX_TEXT_LENGTH}, or when the inviter's
 *   terms are `psi-c` outside the count-only shape or declare `deduplicate`
 *   under a strategy that matches no deduplicating cardinality.
 * @throws {Error} when the inviter's terms cannot be coherently accepted
 *   for the mirrored output direction.
 */
export function deriveAcceptedLinkageTerms(
  inviterTerms: LinkageTerms,
  acceptorIdentity: string,
): LinkageTerms {
  // This party's own name takes the rules the schema holds a party `identity` to
  // here, before it is substituted (see the doc comment): left to the re-check at
  // the end, the same value is refused as an invitation that cannot be accepted --
  // an account of an input the operator supplied itself.
  if (TEXT_CONTROL_CHAR_PATTERN.test(acceptorIdentity))
    throw new UsageError(
      "the identity supplied for this party cannot be used: " +
        `${TEXT_CONTROL_CHAR_MESSAGE}. Supply one that has none.`,
    );
  if (acceptorIdentity.length === 0)
    throw new UsageError(
      "the identity supplied for this party cannot be used: it is empty. " +
        "Supply a name for this party.",
    );
  if (acceptorIdentity.length > MAX_TEXT_LENGTH)
    throw new UsageError(
      "the identity supplied for this party cannot be used: it is longer than " +
        `${MAX_TEXT_LENGTH} characters. Supply a shorter one.`,
    );
  assertCountOnlyTermsShape(inviterTerms);
  assertDeduplicateImplemented(inviterTerms);
  const derived: LinkageTerms = {
    ...inviterTerms,
    identity: acceptorIdentity,
    // This party's own side of the cardinality, which the invitation does
    // not pass to it: whether SEVERAL of this party's records may match one
    // of the partner's is a disclosure about this party's own data, so it
    // starts closed and is authored in this party's own configuration (see
    // the doc comment).
    deduplicate: false,
    output: {
      expectsOutput: inviterTerms.output.shareWithPartner,
      shareWithPartner: inviterTerms.output.expectsOutput,
    },
  };
  // Mirror the payload `send`/`receive` (see the doc comment). Built explicitly so
  // an absent inviter `receive` yields an absent acceptor `send` (rather than an
  // empty list), keeping the acceptor lazy on a direction the inviter left open; an
  // explicit empty inviter `receive: []` mirrors to an explicit empty acceptor
  // `send: []` (present, not absent), preserving the strict reading on that direction.
  if (inviterTerms.payload !== undefined) {
    const mirrored: Payload = {};
    if (inviterTerms.payload.receive !== undefined)
      mirrored.send = inviterTerms.payload.receive;
    if (inviterTerms.payload.send !== undefined)
      mirrored.receive = inviterTerms.payload.send;
    derived.payload = mirrored;
  }
  // Fail closed on an inviter config that mirrors to an incoherent acceptor config
  // (see the doc comment). safeParse is a validity gate only; return the object we
  // built, not parsed.data, so the canonical/agreed-terms bytes are unchanged.
  if (!LinkageTermsSchema.safeParse(derived).success) {
    throw new Error(
      "the invitation's linkage terms cannot be accepted unchanged: mirroring " +
        "the output direction for the accepting party produced an incompatible " +
        "configuration. The inviter is the sole receiver of the matched result, " +
        "yet its terms also have the accepting party receive payload columns " +
        "the inviter sends -- which no party that receives no result can do. " +
        "Ask the inviter to share the result, or to drop those columns.",
    );
  }
  return derived;
}

// --- Compatibility -----------------------------------------------------------

/**
 * A rule-set reference as one readable clause, keys first: the keys are the
 * specific artifact and the fields the substrate they are built from, so a
 * reader meets the narrower claim before the broader one.
 *
 * Each half renders through {@link ruleSetCitation}, which supplies the
 * shared grammar for the pair, so a name holding a space, this clause's own
 * " over ", or a delimiter of its own is treated as content of one value
 * rather than as structure the clause asserted.
 */
export function describeRuleSet(
  reference: LinkageRuleSetReference,
): CompatibilityMessageFragment {
  return compatibilityMessage`${ruleSetCitation(reference.keySet.name, reference.keySet.version)} over ${ruleSetCitation(reference.fieldSet.name, reference.fieldSet.version)}`;
}

interface CompatibilityResult {
  errors: string[];
  warnings: string[];
}

/**
 * Cross-party consistency check for a pair of {@link LinkageTerms}.
 *
 * Returns errors for mandatory mismatches that must cancel the exchange,
 * and warnings for soft mismatches (currently only `date`) that produce a
 * notice but allow the exchange to continue.
 *
 * Every diagnostic it composes names its terms values through the
 * delimiting boundary in `config/compatibilityMessage.ts`, so no value a
 * partner chooses can close a delimiter or spell a second clause of
 * psilink's own prose. Enforced by type: the two accumulators hold
 * `CompatibilityMessageFragment`, so a message composed any other way does
 * not compile. `test/compatibilityMessage.test.ts` drives adversarial value
 * shapes through each message and asserts the clause structure holds.
 */
export function validateCompatibility(
  local: LinkageTerms,
  partner: LinkageTerms,
): CompatibilityResult {
  // Both accumulators hold CompatibilityMessageFragment rather than string, which
  // is the whole of the sweep below: a diagnostic reaches either list only
  // through the compatibilityMessage tagged template, whose interpolations are
  // fragments and whose fixed spans the compiler supplies. So a terms value put
  // into a message without passing the delimiting boundary -- an edit to a
  // message here, or a mismatch check added later -- does not compile. Both
  // lists are returned as the `string[]` of CompatibilityResult, which the
  // brand is transparent to.
  const errors: CompatibilityMessageFragment[] = [];
  const warnings: CompatibilityMessageFragment[] = [];

  // Both arrays below answer the same threat: a mutually-distrusting
  // partner controls reference/purpose/set/column names, and controls them
  // on the side these messages call "local" too, since
  // deriveAcceptedLinkageTerms adopts the inviter's legalAgreement and
  // linkageRuleSet verbatim.
  //
  // DELIMITING is applied here, at composition, to every value either list
  // names (config/compatibilityMessage.ts). ESCAPING stays assigned to one
  // altitude per route: `errors` becomes an Error message, escaped once by
  // sanitizeErrorForDisplay where it is shown, so the values inside the
  // delimiters are the RAW ones; `warnings` is handed to the caller as
  // display text with no error to hold it, so it is escaped and redacted
  // here. The CLI escapes each warning again downstream, which stays
  // unobservable because every value interpolated below is
  // schema-constrained to a shape the escape does not rewrite. Full
  // reasoning: docs/spec/CHANNEL_SECURITY.md, "Display sanitization escape
  // format".
  //
  // The equality CHECKS always compare the RAW values either way -- both
  // transforms are display-only and the escape is lossy, so comparing
  // transformed forms could mask a genuine mismatch.
  if (local.version !== partner.version) {
    // TODO: implement migration when new versions exist
    errors.push(
      compatibilityMessage`version mismatch: local is ${bareTermsValue(local.version)}, partner is ${bareTermsValue(partner.version)}`,
    );
  }

  if (local.algorithm !== partner.algorithm) {
    errors.push(
      compatibilityMessage`algorithm mismatch: local is ${bareTermsValue(local.algorithm)}, partner is ${bareTermsValue(partner.algorithm)}`,
    );
  }

  // Strictly consistent, like algorithm: both parties must use the same strategy
  // or they would compute different matches. The schema fills in "cascade" when
  // omitted, so the value is always present and compared directly.
  if (local.linkageStrategy !== partner.linkageStrategy) {
    errors.push(
      compatibilityMessage`linkage strategy mismatch: local is ${bareTermsValue(local.linkageStrategy)}, partner is ${bareTermsValue(partner.linkageStrategy)}`,
    );
  }

  // Each branch spells its whole sentence rather than interpolating a phrase
  // chosen by a ternary: the four readings are fixed first-party copy, and
  // writing them out is what lets the tagged template above hold for every
  // message in this function without a `string` step for a first-party fragment
  // to slip through.
  if (local.output.shareWithPartner !== partner.output.expectsOutput) {
    errors.push(
      local.output.shareWithPartner
        ? compatibilityMessage`output mismatch: local will share with partner, but partner does not expect output`
        : compatibilityMessage`output mismatch: local will not share with partner, but partner expects output`,
    );
  }
  if (local.output.expectsOutput !== partner.output.shareWithPartner) {
    errors.push(
      local.output.expectsOutput
        ? compatibilityMessage`output mismatch: local expects output, but partner will not share`
        : compatibilityMessage`output mismatch: local does not expect output, but partner will share`,
    );
  }
  if (!local.output.expectsOutput && !partner.output.expectsOutput) {
    errors.push(compatibilityMessage`neither party expects output`);
  }

  if (local.date !== partner.date) {
    warnings.push(
      compatibilityMessage`date mismatch: local is ${bareTermsValue(redactAndSanitizeForDisplay(local.date))}, partner is ${bareTermsValue(redactAndSanitizeForDisplay(partner.date))}; one party may have a stale copy of the linkage terms`,
    );
  }

  // Compare by canonical form (RFC 8785): two field/key sets are equal iff
  // their canonical encodings match -- the same encoding hashed into the
  // exchange-agreement receipt, so equality here means hash-equality there.
  // The canonical encoder sorts keys, so property-insertion order does not
  // affect the result; fields are pre-sorted by name (their array order is
  // not significant), while linkage keys are ordered most-to-least precise
  // and compared in place.
  //
  // No casing fold is applied here: `transform.params` keys are normalized
  // to camelCase at every parse chokepoint that produces a LinkageTerms, so
  // both sides reach this comparison in the one camelCase form already.
  //
  // canonicalString throws CanonicalEncodingError on a value outside the
  // reproducible domain -- a partner can reach this via a `transform.params`
  // JSON integer beyond 2^53. validateCompatibility's contract is to report
  // problems via `errors`, not to throw, so such a value becomes an error
  // instead of a crash.
  //
  // When canonicalOrError returns null the value could not be encoded, so
  // the mismatch comparisons below are skipped for that side: an
  // un-encodable value cannot be compared, and the encoding error already
  // aborts the exchange.
  //
  // `label` is first-party copy composed through the same tagged template;
  // the encoder's own message is delimited, naming the offending JSON path.
  const canonicalOrError = (
    value: unknown,
    label: CompatibilityMessageFragment,
  ): string | null => {
    try {
      return canonicalString(value);
    } catch (err) {
      if (err instanceof CanonicalEncodingError) {
        errors.push(
          compatibilityMessage`${label} cannot be canonically encoded: ${quoteTermsValue(err.message)}`,
        );
        return null;
      }
      throw err;
    }
  };

  // Sort by UTF-16 code unit, not localeCompare: this comparator decides the
  // element order and therefore the canonical bytes (canonical encoding
  // preserves array order), and localeCompare is locale-dependent for non-ASCII
  // names -- two parties under different locales could otherwise derive
  // different bytes, and different receipt hashes, for the same terms. This is
  // the same code-unit ordering the canonical encoder applies to object keys.
  const byName = (a: LinkageField, b: LinkageField): number =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  const localFields = [...local.linkageFields].sort(byName);
  const partnerFields = [...partner.linkageFields].sort(byName);
  const localFieldsCanonical = canonicalOrError(
    localFields,
    compatibilityMessage`local linkage fields`,
  );
  const partnerFieldsCanonical = canonicalOrError(
    partnerFields,
    compatibilityMessage`partner linkage fields`,
  );
  if (
    localFieldsCanonical !== null &&
    partnerFieldsCanonical !== null &&
    localFieldsCanonical !== partnerFieldsCanonical
  ) {
    errors.push(compatibilityMessage`linkage fields do not match`);
  }

  const localKeysCanonical = canonicalOrError(
    local.linkageKeys,
    compatibilityMessage`local linkage keys`,
  );
  const partnerKeysCanonical = canonicalOrError(
    partner.linkageKeys,
    compatibilityMessage`partner linkage keys`,
  );
  if (
    localKeysCanonical !== null &&
    partnerKeysCanonical !== null &&
    localKeysCanonical !== partnerKeysCanonical
  ) {
    errors.push(compatibilityMessage`linkage keys do not match`);
  }

  // The rule-set citation, checked only where BOTH parties declare one. It
  // names rules the two documents already had to agree on field by field
  // and key by key, so a disagreement here is a disagreement about the NAME
  // of matching content -- which still cancels, since each party records
  // its own citation in its own exchange record. Skipped where either party
  // declares none: a hand-authored document has no citation, and holding it
  // to the partner's would refuse an exchange whose rules match exactly.
  // Compared by canonical form, like the fields and keys above. The set
  // names are delimited by describeRuleSet, and the values inside those
  // delimiters stay raw for the same reason the legal-agreement mismatches
  // below are: an error is escaped once where it is shown.
  if (
    local.linkageRuleSet !== undefined &&
    partner.linkageRuleSet !== undefined
  ) {
    const localRuleSet = canonicalOrError(
      local.linkageRuleSet,
      compatibilityMessage`local linkage rule set`,
    );
    const partnerRuleSet = canonicalOrError(
      partner.linkageRuleSet,
      compatibilityMessage`partner linkage rule set`,
    );
    if (
      localRuleSet !== null &&
      partnerRuleSet !== null &&
      localRuleSet !== partnerRuleSet
    ) {
      errors.push(
        compatibilityMessage`linkage rule set mismatch: local names ${describeRuleSet(local.linkageRuleSet)}, partner names ${describeRuleSet(partner.linkageRuleSet)}`,
      );
    }
  }

  if (
    local.legalAgreement !== undefined ||
    partner.legalAgreement !== undefined
  ) {
    if (local.legalAgreement === undefined) {
      errors.push(
        compatibilityMessage`partner has a legal agreement but local does not`,
      );
    } else if (partner.legalAgreement === undefined) {
      errors.push(
        compatibilityMessage`local has a legal agreement but partner does not`,
      );
    } else {
      if (local.legalAgreement.reference !== partner.legalAgreement.reference) {
        errors.push(
          compatibilityMessage`legal agreement reference mismatch: local is ${quoteTermsValue(local.legalAgreement.reference)}, partner is ${quoteTermsValue(partner.legalAgreement.reference)}`,
        );
      }
      if (local.legalAgreement.purpose !== partner.legalAgreement.purpose) {
        errors.push(
          compatibilityMessage`legal agreement purpose mismatch: local is ${quoteTermsValue(local.legalAgreement.purpose)}, partner is ${quoteTermsValue(partner.legalAgreement.purpose)}`,
        );
      }
      if (
        local.legalAgreement.expirationDate !==
        partner.legalAgreement.expirationDate
      ) {
        errors.push(
          compatibilityMessage`legal agreement expiration date mismatch: local is ${bareTermsValue(local.legalAgreement.expirationDate)}, partner is ${bareTermsValue(partner.legalAgreement.expirationDate)}`,
        );
      }
      const today = new Date().toISOString().slice(0, 10);
      if (local.legalAgreement.expirationDate < today) {
        errors.push(
          compatibilityMessage`legal agreement expired on ${bareTermsValue(local.legalAgreement.expirationDate)}`,
        );
      }
    }
  }

  // Payload mirror, LAZY on the receive side. Each of the two directions is
  // gated on whether the RECEIVING party declared a `payload.receive`
  // expectation:
  //
  // - `receive` DECLARED (present, even if empty) asserts "I expect exactly
  //   these columns": the partner's `send` must match it byte-for-byte or
  //   the exchange aborts. An explicit empty `receive: []` is strict BY
  //   INTENT -- "the partner sends nothing" -- distinct from an absent
  //   `receive`, matching the received-payload runtime enforcement (an
  //   empty committed set is likewise strict; only `undefined` is lazy) and
  //   the web consent display, which renders a declared-empty receive as a
  //   "(none)" commitment, not lazy.
  // - `receive` ABSENT means "take whatever I'm given": that direction is
  //   skipped. This is what lets the invite/accept flow reconcile without
  //   the inviter knowing the acceptor's schema -- the inviter authors only
  //   `send` and leaves `receive` unset; the acceptor mirrors the inviter's
  //   `send` into its own `receive`; a zero-setup exchange is lazy on both
  //   sides.
  //
  // Laziness relaxes only this cross-party DECLARATION check; it never
  // widens what a party sends -- transmission is governed by each party's
  // own metadata (`isDisclosedToPartner`) and `assertPayloadSendDisclosed`,
  // unchanged. The gate is symmetric: each direction keys on the same
  // receiver's declared `receive`, so the two parties (which call this with
  // swapped arguments) compute identical verdicts. The equality is
  // byte-exact and element-wise -- compared per sorted column, NOT by a
  // delimiter-joined string, so a partner-controlled name containing the
  // separator cannot make two distinct sets join equal (`["a,b"]` vs
  // `["a","b"]`) and slip a genuine mismatch past the check.
  const sameColumnSet = (a: Array<string>, b: Array<string>): boolean =>
    a.length === b.length && a.every((name, i) => name === b[i]);

  // One direction of the payload mirror: the receiver's declared `receive` must
  // match the sender's `send`, byte-exact and element-wise. Both directions share
  // the sort/compare/delimit-join logic; only the two messages vary, so they are
  // supplied by the caller (emptyReceiveMessage for the strict empty `receive: []`
  // case, mismatchMessage otherwise).
  const checkPayloadDirection = (
    receiverReceive: ReadonlyArray<PayloadColumn>,
    senderSend: ReadonlyArray<PayloadColumn>,
    messages: {
      emptyReceiveMessage: (
        senderShown: CompatibilityMessageFragment,
      ) => CompatibilityMessageFragment;
      mismatchMessage: (
        receiverShown: CompatibilityMessageFragment,
        senderShown: CompatibilityMessageFragment,
      ) => CompatibilityMessageFragment;
    },
  ): void => {
    const receiverNames = receiverReceive.map((c) => c.name).sort();
    const senderNames = senderSend.map((c) => c.name).sort();
    if (sameColumnSet(senderNames, receiverNames)) return;
    const receiverShown = quoteTermsValueList(receiverNames);
    const senderShown = quoteTermsValueList(senderNames);
    errors.push(
      receiverNames.length === 0
        ? messages.emptyReceiveMessage(senderShown)
        : messages.mismatchMessage(receiverShown, senderShown),
    );
  };

  if (partner.payload?.receive !== undefined) {
    checkPayloadDirection(partner.payload.receive, local.payload?.send ?? [], {
      // An empty partner receive is the strict "partner expects no payload"
      // declaration (see the gate comment above); spell that out rather than
      // printing an empty bracket pair that reads like a rendering glitch.
      emptyReceiveMessage: (localShown) =>
        compatibilityMessage`payload mismatch: partner declared an empty payload.receive (asserting local sends no payload columns), but local sends [${localShown}]`,
      mismatchMessage: (partnerShown, localShown) =>
        compatibilityMessage`payload mismatch: local send columns [${localShown}] do not match partner receive columns [${partnerShown}]`,
    });
  }

  if (local.payload?.receive !== undefined) {
    checkPayloadDirection(local.payload.receive, partner.payload?.send ?? [], {
      // An empty local receive is the strict "I expect no payload" declaration;
      // name it and point the operator at the lazy alternative (omit the field),
      // since a hand-authored `receive: []` is the most likely way to land here.
      emptyReceiveMessage: (partnerShown) =>
        compatibilityMessage`payload mismatch: local declared an empty payload.receive (asserting partner sends no payload columns), but partner sends [${partnerShown}]. Omit payload.receive to accept whatever the partner sends.`,
      mismatchMessage: (localShown, partnerShown) =>
        compatibilityMessage`payload mismatch: local receive columns [${localShown}] do not match partner send columns [${partnerShown}]`,
    });
  }

  return { errors, warnings };
}
