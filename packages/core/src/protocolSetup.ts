import * as z from "zod";

import type { HandshakeRole, PsiRole } from "./types";
import type { LinkageTerms, Output } from "./config/linkageTermsSchema";
import type { PresentedHostKey } from "./connection/fileSyncConnection";
import { parseLinkageTerms } from "./config/linkageTermsSchema";
import { validateCompatibility } from "./linkageTermsNegotiation";
import { SHARED_SECRET_REGEX } from "./config/connection";
import { MAX_RECORD_COUNT } from "./connection/frameSize";
import { randomBytes, toBase64Url } from "./utils/crypto";
import { describeDecodeError } from "./utils/describeDecodeError";
import { boundedArray } from "./utils/boundedArray";
import {
  receiveParsed,
  parseOrProtocolError,
  type MessageConnection,
} from "./connection/messageConnection";

// --- Message schemas ---------------------------------------------------------

// Upper bound on the COUNT of partner-supplied abort reasons. A real abort
// holds a handful of reasons or one parse-failure string, so 256 is far above
// any real list. Without the bound, a large array of invalid entries would
// make Zod throw building its error string from every issue. boundedArray
// gates the count before per-element validation.
const MAX_ABORT_REASONS = 256;

// The optional `hostKey` advertisement rides the terms exchange so each party
// reports the SFTP host key it observed (fingerprint + key type) to the
// other, for cross-party reconciliation against a one-sided interception
// (see reconcileHostKeyFingerprints). It rides the AEAD-wrapped
// post-handshake channel, so an unauthenticated party cannot forge it. A
// party that observed no host key omits the field, so a one-sided absence
// reconciles to no divergence. The bounds below are defense-in-depth, far
// above any real value.
//
// hostKeyField is fail-soft: a malformed or over-bound advertisement is
// read as absent rather than aborting the linkage. The reconciliation only
// warns even on a genuine divergence, so a malformed advertisement must
// degrade to "no reconciliation" rather than abort the exchange over
// otherwise-valid terms.
//
// The raw field is parsed and tagged rather than collapsed to one
// `undefined`: an absent field and a well-formed value both report
// `malformed: false`, while a present-but-invalid value reports
// `malformed: true` with no `value`. That distinguishes a benign
// no-host-key partner from a non-conforming one (see
// TermsExchangeResult.partnerHostKeyMalformed).
const hostKeyAdvertisement = z.object({
  fingerprint: z.string().max(100),
  keyType: z.string().max(64),
});

/**
 * Classification of the partner's fail-soft `hostKey` advertisement after
 * parsing: `value` is the validated host key, present only when the field was on
 * the wire and well-formed; `malformed` is `true` only when the field was
 * present but failed validation. An absent field and a well-formed value both
 * report `malformed: false`, and `value` is `undefined` whenever `malformed` is
 * `true`.
 */
interface HostKeyAdvertisementParse {
  value: PresentedHostKey | undefined;
  malformed: boolean;
}

const hostKeyField = z
  .unknown()
  .optional()
  .transform((raw): HostKeyAdvertisementParse => {
    // No advertisement to classify: an omitted field and an explicit `null`
    // (JSON's representation of "no value") both arrive as the benign
    // no-host-key case, not a malformed attempt to advertise one -- a
    // conforming party that observed no host key omits the field entirely
    // (see the send-side spread in exchangeTerms).
    if (raw === undefined || raw === null)
      return { value: undefined, malformed: false };
    // Present and non-null but failing validation (wrong shape or
    // over-bound) is a malformed advertisement, reachable only from a
    // non-conforming or future-versioned peer.
    const parsed = hostKeyAdvertisement.safeParse(raw);
    return parsed.success
      ? { value: parsed.data, malformed: false }
      : { value: undefined, malformed: true };
  });

// Each party's declared record count, which rides the terms-exchange envelope
// and feeds the role decision and every derived single-pass bound
// (docs/spec/PROTOCOL.md, "The counts ride the terms exchange"). The
// `.max(MAX_RECORD_COUNT)` bound is what keeps those bounds' products exact,
// not input hygiene, so it is not relaxed without re-deriving them
// (connection/frameSize.ts).
/** @internal exported for the record-count decode-bound test. */
export const recordCountField = z
  .number()
  .int()
  .nonnegative()
  .max(MAX_RECORD_COUNT);

// The build-level exchange-protocol version both parties advertise on the
// terms exchange and reconcile fail-closed. What the reconcile refuses, the
// three neighbouring identifiers this marker is not, and what a bump is
// reserved for: docs/spec/PROTOCOL.md ("Protocol-version reconcile at the
// terms exchange"). Bumping this literal is that reconcile's whole mechanism,
// so it is changed against that section rather than on its own.
/** @internal exported for the protocol-version reconcile tests. */
export const PROTOCOL_VERSION = 1;

/**
 * The operator-facing diagnosis reported -- and sent to the partner as the
 * abort reason -- when a partner advertises anything but this build's exact
 * {@link PROTOCOL_VERSION}. It must stay a fixed literal holding nothing the
 * partner authored, and must read correctly from either side, since both
 * parties report it.
 *
 * @internal exported for the protocol-version reconcile tests.
 */
export const PROTOCOL_VERSION_MISMATCH_MESSAGE =
  "the partner is running an incompatible psilink version; both parties must " +
  "run the same version";

// The initiator's opening terms frame. Every field beside `linkageTerms` is
// per-party envelope metadata rather than an agreed term, so none of it enters
// the canonical/agreed-terms hash; what each one is for is in
// docs/spec/PROTOCOL.md ("The counts ride the terms exchange", "Withholding
// the sender's table from a blind helper", and "Protocol-version reconcile at
// the terms exchange").
//
// Two optionality choices this schema fixes. `disclosesPayload` is optional
// even though the production caller always passes a definite boolean, and the
// withhold gate defaults an absent value to "discloses payload" (do not
// withhold), so a non-conforming peer that omits it can never drive the blind
// path against a helper that needs its table. `recordCount` is required here
// because this frame is never an abort, so a missing count is a clean decode
// failure rather than an unenforced assumption.
const termsMessage = z.object({
  linkageTerms: z.unknown(),
  recordCount: recordCountField,
  // Read as `unknown` and optional so every non-matching value reaches
  // reconcileProtocolVersion rather than throwing a generic parse error; the
  // reconcile refuses an absent advertisement itself, ahead of this parse.
  protocolVersion: z.unknown().optional(),
  save: z.boolean().optional(),
  disclosesPayload: z.boolean().optional(),
  hostKey: hostKeyField,
});

const abortReasonsField = boundedArray(
  z.string(),
  MAX_ABORT_REASONS,
  `abortReasons must not exceed ${MAX_ABORT_REASONS} entries`,
).optional();

// `recordCount` is optional here (unlike message 1) because this frame
// doubles as the responder's abort frame, which holds no role metadata --
// the same reason `save` is not spread onto an abort (see sendAbort). On a
// `proceed` decision the initiator enforces its presence; on an `abort`
// the exchange ends before the count is ever read.
const termsWithDecisionMessage = z.object({
  linkageTerms: z.unknown(),
  decision: z.enum(["proceed", "abort"]),
  abortReasons: abortReasonsField,
  recordCount: recordCountField.optional(),
  protocolVersion: z.unknown().optional(), // read as unknown; see termsMessage
  save: z.boolean().optional(),
  disclosesPayload: z.boolean().optional(), // per-party payload-intent; see termsMessage
  hostKey: hostKeyField,
});

const decisionMessage = z.object({
  decision: z.enum(["proceed", "abort"]),
  abortReasons: abortReasonsField,
});

/**
 * Every envelope field each terms-exchange slot admits, read off the schemas
 * above rather than restated, so a field added to one appears here with no second
 * edit. The conformance vectors pin the frames each slot actually emits and hold
 * their union to this, which is what keeps a newly added field from riding the
 * wire with nothing pinning it.
 *
 * @internal exported for the terms-envelope conformance vectors.
 */
export const TERMS_ENVELOPE_FIELDS: Readonly<Record<string, Array<string>>> = {
  "message 1": Object.keys(termsMessage.shape),
  "message 2": Object.keys(termsWithDecisionMessage.shape),
  "message 3": Object.keys(decisionMessage.shape),
};

// The dedicated frame that holds a freshly generated shared secret from the
// initiator to the responder during a both-parties `--save` bootstrap (see
// exchangeBootstrapSecret). The token format is pinned to
// SHARED_SECRET_REGEX -- a base64url-encoded 32-byte value -- so it is
// byte-for-byte the persistent secret that authenticateConnection rotates
// to and saveKeyFile persists; a malformed value is a `protocol`
// ConnectionError on the responder.
const sharedSecretMessage = z.object({
  sharedSecret: z.string().regex(SHARED_SECRET_REGEX),
});

// --- Terms exchange ----------------------------------------------------------

export interface TermsExchangeResult {
  partnerTerms: LinkageTerms;
  /**
   * Non-fatal observations from this terms exchange, for the caller to
   * report at the run boundary (runExchange hands each to its `onWarning`,
   * which the CLI puts on both stderr and the machine-readable warning
   * event). Display text, holding no `Error` of its own: any
   * partner-controlled fragment is escaped where it is composed. Currently
   * the terms-compatibility warnings (`validateCompatibility`).
   */
  warnings: string[];
  /**
   * The partner's declared dataset record count, read off the terms message
   * envelope (beside its `linkageTerms`, not inside them) -- its row count times
   * the fan-out factor its own standardization declares. Feeds {@link resolveRole}
   * and the single-pass PSI element bounds; because it rides the terms exchange,
   * no separate count exchange is needed. Always present on a successful exchange
   * (a partner that omits it fails the exchange as a non-conforming peer).
   */
  partnerRecordCount: number;
  /**
   * Whether the partner advertised zero-setup `--save` intent on this terms
   * exchange. `false` outside the save flow (the partner omitted the field).
   * The caller uses it to decide whether to establish a shared secret and which
   * post-exchange notice to emit; it never affects whether the terms are agreed.
   */
  partnerSaveIntent: boolean;
  /**
   * Whether the partner advertised that it will disclose payload (a
   * metadata column disclosed to us) on this terms exchange. `undefined`
   * when omitted, which the single-pass withhold gate treats as "discloses
   * payload" (do not withhold), so a missing advertisement never blinds a
   * helper that needs its table. Consumed only by that gate (see
   * {@link resolveRole}'s caller in exchange.ts and
   * `withholdsSenderAssociationTable` in link.ts); never affects agreement.
   */
  partnerDisclosesPayload: boolean | undefined;
  /**
   * The SFTP host key the partner advertised observing on its side of the
   * rendezvous (fingerprint + key type), or `undefined` when the partner
   * observed none, or advertised a malformed/over-bound value (read as
   * absent; see the fail-soft `hostKeyField` schema). The caller reconciles
   * it against its own observed key (see
   * {@link reconcileHostKeyFingerprints}); it never affects agreement. When
   * the value was dropped as malformed, {@link partnerHostKeyMalformed} is
   * `true`, distinguishing that case from an absence.
   */
  partnerHostKey: PresentedHostKey | undefined;
  /**
   * Whether the partner's host-key advertisement was present on the wire
   * but failed the fail-soft validation, as distinct from being absent.
   * `true` only for a present-but-rejected value; `false` both when the
   * partner advertised a well-formed key and when it advertised none at
   * all. {@link partnerHostKey} is `undefined` whenever this is `true`. It
   * is a diagnostic signal only -- a malformed advertisement is reachable
   * only from a non-conforming or future-versioned peer, never affects
   * agreement, and never aborts -- so a caller logs it at a low level (the
   * CLI logs it at debug; see apps/cli/src/protocol.ts).
   */
  partnerHostKeyMalformed: boolean;
}

/**
 * Best-effort delivery of an abort decision to the partner. The send is
 * wrapped so a transport failure coinciding with the abort condition is
 * swallowed: the partner falls back to its own receive timeout, and the
 * caller's subsequent throw -- which holds the real diagnostic -- is
 * always what shows. Pass `localTerms` when aborting from the responder's
 * message-2 slot, which must still hold `linkageTerms`; omit it for the
 * initiator's decision-only frame.
 *
 * The protocol version is the one envelope field that rides the responder's
 * abort, and the `save` intent is not; which fields an abort frame holds and
 * why: docs/spec/PROTOCOL.md ("Protocol-version reconcile at the terms
 * exchange").
 *
 * Exported for the refusals that fire past this exchange, which
 * `runExchange` applies to the terms this function's caller returned: the
 * invitation-term binding (`assertPresentedDeduplicateMatchesInvitation`)
 * and the receipt bindings (`assertReceiptBindingsOrAbort`), the latter
 * again at the signature swap. Each is one-sided, so without the abort the
 * partner waits out its peer-inactivity budget. `abortReasons` is written
 * by the calling code and must stay a fixed literal: the frame is a
 * disclosure to the partner like any other.
 */
export async function sendAbort(
  conn: MessageConnection,
  abortReasons: string[],
  localTerms?: LinkageTerms,
): Promise<void> {
  try {
    await conn.send(
      localTerms !== undefined
        ? {
            linkageTerms: localTerms,
            decision: "abort",
            abortReasons,
            protocolVersion: PROTOCOL_VERSION,
          }
        : { decision: "abort", abortReasons },
    );
  } catch {
    /* swallow: see doc comment */
  }
}

// The lenient probe that extracts ONLY `protocolVersion` from a raw terms
// frame, read before the strict envelope parse; docs/spec/PROTOCOL.md
// ("Protocol-version reconcile at the terms exchange") states the ordering
// guarantee this exists for. A non-object frame, or one holding no version,
// probes to `undefined`, which the reconcile refuses on the same terms as a
// foreign value; `.catch` covers the non-object case.
const protocolVersionProbe = z
  .object({ protocolVersion: z.unknown().optional() })
  .catch({ protocolVersion: undefined });

/**
 * Read the partner's advertised protocol version from a raw terms frame
 * without requiring the whole envelope to parse (see
 * {@link protocolVersionProbe}), so {@link reconcileProtocolVersion} can
 * diagnose a version skew even when a sibling field would fail the strict
 * parse. Returns `undefined` for a frame that holds no version, that is
 * not an object, or whose `protocolVersion` read throws -- a throwing
 * getter degrades to the same "no readable version" outcome (pinned by
 * the "throwing protocolVersion getter" test), which the reconcile
 * refuses.
 *
 * @internal exported for the throwing-getter probe test.
 */
export function probeProtocolVersion(rawData: unknown): unknown {
  // A throwing `protocolVersion` getter escapes the schema's `.catch` (which only
  // handles validation failures), so degrade a thrown read to `undefined` here --
  // the same "no readable version" outcome as a garbled or absent value.
  try {
    return protocolVersionProbe.parse(rawData).protocolVersion;
  } catch {
    return undefined;
  }
}

/**
 * Fail-closed reconcile of the partner's advertised {@link PROTOCOL_VERSION}.
 * Only this build's exact version proceeds; every other outcome best-effort
 * sends the partner the abort, so it too fails with the named cause rather
 * than a receive timeout, and throws
 * {@link PROTOCOL_VERSION_MISMATCH_MESSAGE}. What "every other outcome"
 * covers, and why an absent advertisement is among them:
 * docs/spec/PROTOCOL.md ("Protocol-version reconcile at the terms exchange").
 *
 * Pass `localTerms` when reconciling from the responder's message-2 slot,
 * whose abort frame holds `linkageTerms`; omit it for the initiator's
 * decision-only abort.
 */
async function reconcileProtocolVersion(
  conn: MessageConnection,
  partnerVersion: unknown,
  localTerms?: LinkageTerms,
): Promise<void> {
  if (partnerVersion === PROTOCOL_VERSION) return;
  await sendAbort(conn, [PROTOCOL_VERSION_MISMATCH_MESSAGE], localTerms);
  throw new Error(PROTOCOL_VERSION_MISMATCH_MESSAGE);
}

/**
 * Exchange {@link LinkageTerms} with a partner over an established
 * connection, validate compatibility, and obtain agreement from both parties to
 * proceed.
 *
 * The three-message protocol mirrors the sequencing of the handshake:
 *   1. Initiator  -> Responder : `{ linkageTerms, recordCount, protocolVersion }`
 *   2. Responder  -> Initiator : `{ linkageTerms, recordCount, decision, protocolVersion }`
 *   3. Initiator  -> Responder : `{ decision }`
 *
 * If either party finds the terms incompatible, it sends `decision: "abort"`
 * with its reasons and this function throws. On success, returns the partner's
 * validated terms, its record count, and any non-fatal warnings (e.g. a `date`
 * mismatch). Call {@link resolveRole} afterwards to determine each party's PSI
 * role -- it is a local computation over the counts exchanged here, with no
 * further messages.
 *
 * Each optional argument below is a per-party envelope advertisement, none of
 * which affects whether the terms are agreed. Passing `undefined` omits the
 * field entirely rather than sending a default, so a party with nothing to
 * advertise leaves the wire format unchanged. What each one is consumed for:
 * docs/spec/PROTOCOL.md ("The counts ride the terms exchange" for
 * `localRecordCount`, "Withholding the sender's table from a blind helper" for
 * `localDisclosesPayload`, "Protocol-version reconcile at the terms exchange"
 * for the version this function advertises on its own) and
 * docs/SECURITY_DESIGN.md for `localSaveIntent` and the host-key
 * reconciliation `localHostKey` feeds.
 *
 * No width rides the envelope: the per-key candidate widths every derived
 * single-pass bound reads are a function of the agreed terms, which both
 * parties hold once this exchange returns, so each derives the other's
 * without a further field or round-trip (`declaredEffectiveKeyCount`,
 * fanOutFunctions.ts).
 *
 * The partner's host-key advertisement is fail-soft: a present-but-malformed
 * value is dropped (read as no host key) rather than aborting, and the drop is
 * reported via {@link TermsExchangeResult.partnerHostKeyMalformed} so a caller
 * can tell a non-conforming peer from one that observed no host key.
 */
export async function exchangeTerms(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
  localTerms: LinkageTerms,
  localRecordCount: number,
  localSaveIntent?: boolean,
  localHostKey?: PresentedHostKey,
  localDisclosesPayload?: boolean,
): Promise<TermsExchangeResult> {
  // Spread into the outgoing terms frame only when this party is saving, so a
  // non-save exchange sends no `save` field at all.
  const saveField = localSaveIntent === true ? { save: true } : {};
  // Likewise the observed host key: spread only when this party observed one, so
  // a party with nothing to advertise sends no `hostKey` field at all.
  const hostKeyField =
    localHostKey !== undefined ? { hostKey: localHostKey } : {};
  // The payload-intent advertisement: spread when the caller supplies it
  // (the production caller always does, as a definite boolean), so both a
  // payload-disclosing and a no-payload party holds an explicit flag the
  // partner's single-pass withhold gate reads. Omitted only by a caller
  // that passes nothing (test helpers that do not exercise the withhold
  // path); an omitted flag is read by the gate as "discloses payload" (do
  // not withhold). See the schema comment.
  const disclosesPayloadField =
    localDisclosesPayload !== undefined
      ? { disclosesPayload: localDisclosesPayload }
      : {};

  if (handshakeRole === "initiator") {
    await conn.send({
      linkageTerms: localTerms,
      recordCount: localRecordCount,
      protocolVersion: PROTOCOL_VERSION,
      ...saveField,
      ...disclosesPayloadField,
      ...hostKeyField,
    });

    // Message 2: receive partner's terms + decision. Raw receive so the
    // protocol version is read from the lenient probe and reconciled before
    // the strict parse: a malformed sibling field on this frame must not
    // throw the parse before the skew is diagnosed, which would strand the
    // responder awaiting our message 3 with no abort sent (see
    // protocolVersionProbe / reconcileProtocolVersion).
    const rawMsg = await conn.receive();

    // Fail-closed protocol-version check first -- before the strict parse
    // and before any terms are weighed. A version skew is the root cause,
    // so its diagnosis wins over a record-count, terms, or sibling-field
    // parse difference the mismatch might also produce. A conforming
    // responder advertises its version whether it proceeds or aborts (see
    // sendAbort), so an abort passes the reconcile and reports its own
    // reasons at the decision check below.
    await reconcileProtocolVersion(conn, probeProtocolVersion(rawMsg));

    const msg = parseOrProtocolError(termsWithDecisionMessage, rawMsg);

    if (msg.decision === "abort") {
      throw new Error(
        "partner aborted linkage terms exchange" +
          (msg.abortReasons?.length ? `: ${msg.abortReasons.join("; ")}` : ""),
      );
    }

    // A `proceed` frame always holds the partner's record count (only the
    // abort frame omits it; see termsWithDecisionMessage). Its absence here
    // is a non-conforming or version-mismatched peer -- the count feeds
    // role resolution and the single-pass element bounds, so a missing one
    // is a protocol failure, not something to default.
    if (msg.recordCount === undefined) {
      await sendAbort(conn, ["partner omitted record count"]);
      throw new Error("partner omitted record count on terms exchange");
    }

    let partnerTerms: LinkageTerms;
    try {
      partnerTerms = parseLinkageTerms(msg.linkageTerms);
    } catch (parseErr) {
      await sendAbort(conn, ["partner linkage terms failed to parse"]);
      // These terms are partner-controlled, so the parse error is rendered
      // through describeDecodeError, which escapes each Zod issue-path
      // segment via sanitizeForDisplay and relays the schema-fixed message
      // text (see utils/describeDecodeError). The path escaping is
      // critical, not cosmetic: Zod's `invalid_key` code on the bounded
      // `z.record` key in `transform.params`
      // (z.string().max(MAX_NAME_LENGTH)) places the offending raw key
      // verbatim into the issue path, which a raw `ZodError.message`
      // JSON-dumps -- so a partner key holding bidi-override / zero-width /
      // homoglyph bytes would otherwise reach the operator unescaped.
      // Escaping at the source makes the invariant hold here rather than
      // leaning on the display-sink safety check.
      //
      // The message text needs no escaping: unknown keys are stripped by
      // the non-strict `z.object` schemas rather than echoed via
      // `unrecognized_keys` (pinned by the "strips an unknown partner key"
      // test), and the other reachable codes (type mismatch, enum,
      // semver/date format, too_small) report the expected type/options,
      // not the received value -- only the path holds partner bytes.
      throw new Error(
        "partner linkage terms failed to parse: " +
          describeDecodeError(parseErr),
      );
    }

    const { errors, warnings } = validateCompatibility(
      localTerms,
      partnerTerms,
    );

    if (errors.length > 0) {
      await sendAbort(conn, errors);
      throw new Error(`linkage terms are incompatible: ${errors.join("; ")}`);
    }

    await conn.send({ decision: "proceed" });

    return {
      partnerTerms,
      warnings,
      partnerRecordCount: msg.recordCount,
      partnerSaveIntent: msg.save === true,
      partnerDisclosesPayload: msg.disclosesPayload,
      partnerHostKey: msg.hostKey.value,
      partnerHostKeyMalformed: msg.hostKey.malformed,
    };
  } else {
    // Message 1: receive partner's terms. Raw receive + inline parse (rather
    // than receiveParsed) so a malformed frame can be answered with an
    // abort-with-reasons message before we throw, rather than stranding the
    // initiator until its receive timeout.
    const rawData = await conn.receive();

    let partnerTerms: LinkageTerms;
    // Placeholder overwritten by the parse below; only read on the success path,
    // which requires `recordCount` (message 1's schema makes it mandatory, so a
    // missing count is caught as a parse error before this value is returned).
    let partnerRecordCount = 0;
    let partnerSaveIntent = false;
    let partnerDisclosesPayload: boolean | undefined;
    let partnerHostKey: PresentedHostKey | undefined;
    let partnerHostKeyMalformed = false;
    // Read the version from the lenient probe before the strict parse, so
    // the reconcile below runs on the peer's version even when
    // `termsMessage.parse` throws -- whether on the linkage terms (a
    // version skew is the likely cause) or on any other envelope field a
    // future version might reshape (see protocolVersionProbe).
    const partnerProtocolVersion: unknown = probeProtocolVersion(rawData);
    let parseError: string | undefined;
    try {
      const parsed = termsMessage.parse(rawData);
      partnerRecordCount = parsed.recordCount;
      partnerSaveIntent = parsed.save === true;
      partnerDisclosesPayload = parsed.disclosesPayload;
      partnerHostKey = parsed.hostKey.value;
      partnerHostKeyMalformed = parsed.hostKey.malformed;
      partnerTerms = parseLinkageTerms(parsed.linkageTerms);
    } catch (parseErr) {
      // describeDecodeError escapes the partner-controlled Zod issue path at the
      // source (the `invalid_key`/bounded-`z.record`-key path included) and
      // relays the schema-fixed message text -- see the parse-error note in the
      // initiator branch above.
      parseError = describeDecodeError(parseErr);
    }

    // Fail-closed protocol-version check first: a version skew is the root
    // cause, so its diagnosis wins over a terms parse/compat error the same
    // mismatch would otherwise show. The abort holds localTerms (the
    // responder's message-2 slot always does).
    await reconcileProtocolVersion(conn, partnerProtocolVersion, localTerms);

    const { errors, warnings } =
      parseError !== undefined
        ? {
            errors: [`partner linkage terms failed to parse: ${parseError}`],
            warnings: [],
          }
        : validateCompatibility(localTerms, partnerTerms!);

    if (errors.length > 0) {
      await sendAbort(conn, errors, localTerms);
      throw new Error(`linkage terms are incompatible: ${errors.join("; ")}`);
    }

    await conn.send({
      linkageTerms: localTerms,
      decision: "proceed",
      recordCount: localRecordCount,
      protocolVersion: PROTOCOL_VERSION,
      ...saveField,
      ...disclosesPayloadField,
      ...hostKeyField,
    });

    const msg = await receiveParsed(conn, decisionMessage);
    if (msg.decision === "abort") {
      throw new Error(
        "partner aborted linkage terms exchange" +
          (msg.abortReasons?.length ? `: ${msg.abortReasons.join("; ")}` : ""),
      );
    }

    return {
      partnerTerms: partnerTerms!,
      warnings,
      partnerRecordCount,
      partnerSaveIntent,
      partnerDisclosesPayload,
      partnerHostKey,
      partnerHostKeyMalformed,
    };
  }
}

// --- Shared-secret bootstrap -------------------------------------------------

/**
 * Establish a fresh persistent shared secret in-band, for a zero-setup
 * exchange in which both parties passed `--save`. Both ends return the same
 * value, which the caller persists to its key file as the basis for future
 * recurring exchanges. The frame's placement, its format, and what protects
 * it are in docs/spec/PROTOCOL.md ("The zero-setup bootstrap frame").
 *
 * Call this only when both parties advertised save intent (see
 * {@link exchangeTerms}); calling it otherwise leaves one party sending a
 * frame the other never reads, or awaiting one never sent.
 *
 * @returns the established shared secret, identical on both sides.
 */
export async function exchangeBootstrapSecret(
  conn: MessageConnection,
  handshakeRole: HandshakeRole,
): Promise<string> {
  if (handshakeRole === "initiator") {
    const sharedSecret = toBase64Url(randomBytes(32));
    await conn.send({ sharedSecret });
    return sharedSecret;
  }
  const msg = await receiveParsed(conn, sharedSecretMessage);
  return msg.sharedSecret;
}

// --- Count-only report leg ---------------------------------------------------

// The count-only round's report frame, over which the receiver reports its
// tally to the sender. The bound the caller supplies as `maxCount`, and what
// it does and does not buy, are in docs/spec/PROTOCOL.md ("Count reporting
// and entitlement").
const countReportMessage = (maxCount: number) =>
  z.object({ intersectionCount: recordCountField.max(maxCount) });

/**
 * Whether a count-only (`psi-c`) round's tally travels from the receiver
 * to the sender: exactly when both parties' agreed terms entitle them to
 * output.
 *
 * Symmetric in its arguments: each party calls it with the same agreed
 * pair (its own entitlement plus the partner's, cross-validated by
 * `validateCompatibility`), so the receiver's decision to send and the
 * sender's decision to await are always the same verdict. Why the frame is
 * suppressed entirely in the one-sided case rather than sent empty:
 * docs/spec/PROTOCOL.md ("Count reporting and entitlement").
 */
export function reportsCountToSender(
  localExpectsOutput: boolean,
  partnerExpectsOutput: boolean,
): boolean {
  return localExpectsOutput && partnerExpectsOutput;
}

/**
 * Send the count-only round's tally to the sender. Called by the RECEIVER, and only
 * when {@link reportsCountToSender} holds.
 */
export async function sendCountReport(
  conn: MessageConnection,
  intersectionCount: number,
): Promise<void> {
  await conn.send({ intersectionCount });
}

/**
 * Receive the count-only round's tally. Called by the SENDER, and only when
 * {@link reportsCountToSender} holds.
 *
 * @param maxCount The largest count this exchange could legitimately produce --
 *   the smaller of the two parties' record counts, both authenticated session state
 *   from the terms exchange. A larger figure is a protocol violation, not a result.
 */
export async function receiveCountReport(
  conn: MessageConnection,
  maxCount: number,
): Promise<number> {
  const message = await receiveParsed(conn, countReportMessage(maxCount));
  return message.intersectionCount;
}

// --- Role resolution ---------------------------------------------------------

// The work-minimizing PSI role assignment for two both-output parties, from
// their exchanged declared counts, derived in docs/spec/PROTOCOL.md ("Role
// resolution and work minimization"). Both parties run this over the same
// inputs, so the tie-break has to be deterministic rather than merely
// work-neutral, or the two would resolve to the same role.
function pickRole(
  localCount: number,
  partnerCount: number,
  handshakeRole: HandshakeRole,
): PsiRole {
  if (localCount < partnerCount) return "receiver";
  if (localCount > partnerCount) return "sender";
  return handshakeRole === "initiator" ? "receiver" : "sender";
}

/**
 * Determine this party's PSI role from the declared record counts already
 * exchanged.
 *
 * A pure local computation with no connection I/O: both parties' declared
 * counts ride the terms exchange (see {@link exchangeTerms}), so once terms
 * are agreed each party holds its own count and the partner's, and the
 * role follows without a further message.
 *
 * The rule both branches implement is docs/spec/PROTOCOL.md ("Role resolution
 * and work minimization"). The counts still ride the terms exchange in the
 * one-sided case, where the role does not consume them but the single-pass
 * element bounds do (see exchange.ts, psiElementBounds).
 *
 * Call this after a successful {@link exchangeTerms}, whose
 * {@link TermsExchangeResult.partnerRecordCount} supplies
 * `partnerRecordCount`.
 */
export function resolveRole(
  handshakeRole: HandshakeRole,
  localOutput: Output,
  partnerOutput: Output,
  localRecordCount: number,
  partnerRecordCount: number,
): PsiRole {
  // One-sided output: the party that expects output is the receiver regardless
  // of the counts -- it is the only party that learns the result.
  if (localOutput.expectsOutput && !partnerOutput.expectsOutput)
    return "receiver";
  if (!localOutput.expectsOutput && partnerOutput.expectsOutput)
    return "sender";

  // Both expect output: the assignment is free, so minimize total work.
  return pickRole(localRecordCount, partnerRecordCount, handshakeRole);
}
