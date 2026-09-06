import { errorMessage } from "../connection/messageConnection";
import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  sanitizeForDisplay,
} from "./sanitizeForDisplay";
import type {
  Displayable,
  SanitizeForDisplayOptions,
} from "./sanitizeForDisplay";

/**
 * Maximum number of links {@link sanitizeErrorForDisplay} walks down an error's
 * `cause` chain before stopping. A defensive bound so a pathologically deep (or
 * adversarially constructed) chain cannot flood an operator's terminal or stall
 * the render: the cycle guard already stops a chain that revisits a link, and
 * this caps a long acyclic one.
 */
export const MAX_ERROR_CAUSE_DEPTH = 8;

/**
 * Marker {@link sanitizeErrorForDisplay} appends to the last link it
 * renders when the walk stops at {@link MAX_ERROR_CAUSE_DEPTH} with the
 * chain still running: the cutoff says so rather than shortening the chain
 * silently, the same way {@link DISPLAY_TRUNCATION_MARKER} marks a link the
 * per-link cap cut.
 *
 * Holds no count: counting the remainder means walking the rest of the
 * chain, which this bound exists to not perform. A composition site that
 * knows its own link count states it in the last link it composes, where
 * the number is free (`checkLinkageSatisfiability` in
 * `apps/cli/src/commands/linkagePreflight.ts`); this marker is the generic
 * fallback for a chain nobody counted.
 *
 * Plain ASCII, appended AFTER the per-link escape and cap, so it can
 * neither reintroduce a control character nor be cut off the link it
 * marks -- and, being plain ASCII, is not authenticated: a link whose
 * message ends with the same text renders identically to one this
 * renderer marked (the same open class {@link DISPLAY_TRUNCATION_MARKER}
 * has). What bounds the cost is the asymmetry: a copy can claim a loss
 * that did not happen but cannot conceal one that did. The marker's
 * ABSENCE is what an operator can rely on -- no marker means the walk
 * dropped nothing -- while its presence only says detail MAY be missing.
 */
export const CAUSE_DEPTH_ELISION_MARKER = "...[further causes elided]";

/**
 * {@link CAUSE_DEPTH_ELISION_MARKER} as it sits on a rendered chain's last
 * link, behind the single space the append below separates it with. Both
 * the renderer and the re-render call site write the marker through this
 * constant, so the text a boundary looks for is the text the renderer put
 * there.
 */
const ELISION_SUFFIX = ` ${CAUSE_DEPTH_ELISION_MARKER}`;

/**
 * Separator placed between an error's message and each chained `cause`
 * message. The leading newline is the one control character in the
 * assembled output, and it is by design: a fixed formatting byte this
 * module emits (so each cause renders on its own line in a terminal),
 * never partner-controlled input. Every byte from an error message is
 * escaped by {@link sanitizeForDisplay} before it is joined, so no
 * partner-controlled control character can ride in alongside this one.
 * Consumers rendering to HTML must opt into preserving the newline (e.g.
 * `white-space: pre-line`); browsers collapse it otherwise.
 *
 * That escape-then-join order also makes the join REVERSIBLE, which
 * {@link sanitizeErrorChainLinks} relies on: the escape rewrites every code
 * point outside printable ASCII, the newline among them, so the only raw
 * newline a rendered chain can have is the one this constant put there. A
 * link whose own text is `caused by:` therefore cannot forge a link
 * boundary.
 */
const ERROR_CAUSE_SEPARATOR = "\ncaused by: ";

/**
 * Fallback emitted for a cause-chain link whose message cannot be read -- a
 * hostile or malformed error whose `.message`/`.cause` getter or
 * `toString`/`Symbol.toPrimitive` throws, or whose `.message` is a
 * non-string. Plain ASCII, so it passes through {@link sanitizeForDisplay}
 * unchanged and keeps this renderer total: it never throws at the
 * operator-facing, last-resort boundary it exists to protect.
 */
const UNREADABLE_LINK = "[unreadable error]";

const REDACTED_PRIVATE_KEY = "[redacted private key]";

/**
 * A PEM / OpenSSH private-key block (RSA, EC, DSA, OPENSSH, ENCRYPTED, or
 * unlabelled), from its BEGIN marker to the next END marker, plus a
 * fallback for a truncated block (a BEGIN with no END, e.g. a key sliced
 * into an error). The marker `-----BEGIN ... PRIVATE KEY-----` never
 * legitimately appears in operator-facing error or log text, so matching
 * it has no false-positive risk. (PGP `... PRIVATE KEY BLOCK-----` is
 * intentionally not matched: psilink uses no PGP keys, so there is no such
 * sink here.)
 *
 * The gap between BEGIN and END uses a tempered negative lookahead so it
 * cannot cross another BEGIN marker. Without it, a long run of BEGIN
 * markers with no END makes the lazy `[\s\S]*?` rescan to end-of-string
 * for every match attempt -- O(n^2) backtracking (catastrophic on
 * partner-controlled error text, which this renderer is built to handle).
 * The lookahead bounds each attempt to one block.
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:(?!-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S])*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_DANGLING = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g;

/**
 * Last-resort redaction safety check for PEM / OpenSSH private-key
 * material in text about to be shown to an operator. NOT the primary
 * defense: secret-bearing files are parsed through the sensitive-file
 * chokepoint (shared in `@psilink/core`, re-exported by the CLI) so a
 * parse error never holds source, and that prevention is what callers must
 * rely on. This only guards an UNANTICIPATED sink by stripping
 * private-key blocks, which are unambiguous and never legitimate in error
 * output.
 *
 * The dangling rule replaces from a BEGIN marker with no END to the end of
 * the text, FAIL-CLOSED by design: a key sliced into an error has no
 * reliable structure by the time it is rendered, so the only bound that
 * holds for every delivery is "everything after the marker". A rule
 * inferring where the key body ends from the shape of the remaining bytes
 * leaks the body whenever that shape is absent.
 *
 * The cost of failing closed is that the replacement also consumes
 * whatever was composed after the marker -- why partner-controlled
 * fragments are passed through this function AT THEIR COMPOSITION SITE,
 * before being interpolated: a planted marker inside an already-redacted
 * fragment does not exist by the time the whole link is rendered. The
 * function is idempotent (the replacement holds no marker), so redacting
 * again per link is unaffected by a fragment already redacted.
 *
 * Redaction, not escaping: the fragment still interpolates raw and is
 * escaped exactly once, by {@link sanitizeForDisplay} at the display sink
 * (CONTRIBUTING.md, Operator-facing escaping).
 *
 * Narrow by design: it does NOT scrub by secret-shape (e.g. a 43-char
 * base64url token), since a shared secret and a host-key fingerprint share
 * that shape and fingerprints are shown to the operator on purpose.
 * Bare-token containment belongs to the chokepoint, not here.
 */
export function redactPrivateKeyMaterial(text: string): string {
  return text
    .replace(PRIVATE_KEY_BLOCK, REDACTED_PRIVATE_KEY)
    .replace(PRIVATE_KEY_DANGLING, REDACTED_PRIVATE_KEY);
}

/**
 * One BEGIN or END marker, un-anchored and non-global, for the incremental
 * scan in {@link createPrivateKeyStreamRedactor}. The same shapes
 * {@link PRIVATE_KEY_BLOCK} matches, split apart because a streaming scan
 * meets each end of a block on a delivery of its own.
 */
const PRIVATE_KEY_BEGIN_MARKER = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const PRIVATE_KEY_END_MARKER = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;

/**
 * The longest marker the streaming scan holds back for, in UTF-16 code
 * units: the fixed `-----BEGIN ` opener and `PRIVATE KEY-----` closer around
 * a label of at most 64. A marker split across two deliveries is scanned
 * whole because that many code units of each delivery are held back until
 * the next one arrives.
 *
 * The label the marker patterns admit is unbounded, so this bounds the
 * LOOKAHEAD rather than what matches: a marker with a longer label is still
 * matched wherever it lands inside one delivery. What the bound gives up is
 * a marker whose label runs past 64 characters AND falls across a delivery
 * boundary -- a shape no PEM or OpenSSH label takes, the longest in use
 * being `ENCRYPTED ` at ten.
 */
const PRIVATE_KEY_MARKER_LOOKAHEAD =
  "-----BEGIN ".length + 64 + "PRIVATE KEY-----".length;

/**
 * A redactor for private-key material arriving in pieces, for a sink that
 * keeps a WINDOW of what it is given rather than the whole of it -- the
 * console's retained stderr tail (`attachStderrTail` in
 * `apps/web/src/jobs/cliDriver.ts`).
 *
 * A window clips before anything renders, so a key longer than the window
 * lands in it as body alone: its BEGIN marker already evicted, its END not
 * yet written. {@link redactPrivateKeyMaterial} cannot see that shape, since
 * it holds no marker at all, and no rule reading the window can -- a rule
 * inferring a key body from the shape of the remaining bytes would strip
 * fingerprints and shared secrets with it. Redacting the STREAM in front of
 * the window is what closes it: every marker passes this scan in the order
 * the child wrote it, so the window only ever holds output this has already
 * redacted.
 *
 * The scan holds "inside a block" across deliveries: on a BEGIN marker it
 * emits {@link REDACTED_PRIVATE_KEY} once and emits nothing further until an
 * END marker is consumed, so a block spanning any number of deliveries costs
 * one replacement. A block still open at {@link PrivateKeyStreamRedactor.close}
 * stays redacted to the end, the same fail-closed reach the dangling rule
 * takes. An END marker with no BEGIN of its own is ordinary text: the reach
 * is forward only, here as at the render boundary, so no delivery can delete
 * what an earlier one already emitted.
 */
export interface PrivateKeyStreamRedactor {
  /** Redact `chunk` in the stream's state and return what may be emitted. */
  push(chunk: string): string;
  /**
   * The held-back remainder, redacted; nothing while a block is still open.
   * A caller that never calls it loses at most
   * {@link PRIVATE_KEY_MARKER_LOOKAHEAD} code units of the last delivery.
   */
  close(): string;
}

/** Open a {@link PrivateKeyStreamRedactor} over a fresh, empty stream. */
export function createPrivateKeyStreamRedactor(): PrivateKeyStreamRedactor {
  let held = "";
  let insideBlock = false;

  return {
    push(chunk: string): string {
      let pending = held + chunk;
      let emitted = "";
      for (;;) {
        if (insideBlock) {
          const end = PRIVATE_KEY_END_MARKER.exec(pending);
          if (end === null) break;
          pending = pending.slice(end.index + end[0].length);
          insideBlock = false;
          continue;
        }
        const begin = PRIVATE_KEY_BEGIN_MARKER.exec(pending);
        if (begin === null) break;
        emitted += pending.slice(0, begin.index) + REDACTED_PRIVATE_KEY;
        pending = pending.slice(begin.index + begin[0].length);
        insideBlock = true;
      }
      // Inside a block the remainder is body, held only as the context an
      // END marker may span; outside one it is emitted except for the
      // lookahead a marker may span.
      const kept = Math.min(pending.length, PRIVATE_KEY_MARKER_LOOKAHEAD);
      if (!insideBlock) emitted += pending.slice(0, pending.length - kept);
      held = pending.slice(pending.length - kept);
      return emitted;
    },
    close(): string {
      const remainder = insideBlock ? "" : redactPrivateKeyMaterial(held);
      held = "";
      return remainder;
    },
  };
}

/**
 * Prepare a fragment somebody else chose -- a partner-, server-, or
 * operator-supplied value -- for interpolation into a line that reaches a
 * log, console, or prompt sink: {@link redactPrivateKeyMaterial} first,
 * then {@link sanitizeForDisplay}. The composition-site half of the
 * private-key assignment, pairing with the per-argument pass the log
 * prefixer applies at the sink (`setLogPrefixer` in `./logger`).
 *
 * Redacting BEFORE escaping bounds the fail-closed dangling rule to the
 * fragment that held the marker: a planted marker no longer exists when
 * the sink's pass runs, so that pass cannot consume the first-party
 * explanation or recovery step composed behind the fragment. The order
 * also matters within this function: escaping first would truncate a long
 * fragment at the display cap, leaving a `BEGIN` whose `END` was cut off
 * as a dangling marker where a whole block stood.
 *
 * Use it wherever {@link sanitizeForDisplay} would be used on a log- or
 * prompt-bound fragment, uniformly rather than by position: "this fragment
 * is last on its line, so nothing follows it to lose" is a property no
 * check holds and a later copy edit silently breaks. Escaping still
 * happens exactly once -- the same single {@link sanitizeForDisplay} call,
 * not a second altitude (CONTRIBUTING.md, Operator-facing escaping) -- so
 * a fragment routed into an `Error` instead keeps composing RAW and is
 * escaped by {@link sanitizeErrorForDisplay} where the chain is rendered.
 *
 * Do NOT fit a length budget by comparing this against
 * {@link sanitizeForDisplay} at the same `maxLength`: this can return the
 * LONGER of the two, since replacing a block with the much shorter marker
 * can let a later code point fit that the escape-only form had to stop
 * before. It is {@link redactPrivateKeyMaterial} that never lengthens its
 * input, and that is the function the budgeted callers (the rendezvous
 * entry guard, and the host-key refusals) fit over.
 */
export function redactAndSanitizeForDisplay(
  value: string,
  options?: SanitizeForDisplayOptions,
): Displayable {
  return sanitizeForDisplay(redactPrivateKeyMaterial(value), options);
}

/**
 * Render an arbitrary thrown value as operator-safe display text: its own
 * message followed by each chained `cause` message, every link passed
 * through {@link sanitizeForDisplay} so partner- or server-controlled
 * bytes embedded in any link -- control characters, the ESC that drives
 * ANSI sequences, CR/LF usable for log-line spoofing, bidi overrides,
 * zero-width and confusable characters -- cannot reach a terminal, log
 * line, or UI element. Each link also passes through a narrow
 * secret-redaction safety check that strips PEM / OpenSSH private-key
 * blocks (see {@link redactPrivateKeyMaterial}); this is a last resort for
 * an unanticipated sink, not the primary defense (secret-bearing files are
 * parsed leak-safely at their source). That check is fail-closed past a
 * truncated key, so a fragment a partner controls is redacted where it is
 * composed rather than here -- see {@link redactPrivateKeyMaterial}.
 *
 * This is the display-boundary call site for rendering a raw error
 * INSTANCE to a human. The transport and message layers preserve the
 * original error object by design so it can still be classified by type
 * (e.g. `transport` vs `closed`); the escaping therefore cannot happen
 * there without mis-tagging the error, and must happen here, where it is
 * finally shown. Use it in place of `console.error(err)` or a direct
 * `err.message` interpolation at any operator-facing sink, never on a
 * value used for comparison, storage, or hashing (it is lossy; see
 * {@link sanitizeForDisplay}).
 *
 * The walk is narrow and defensive by design:
 * - it reads only each link's `.message` (via {@link errorMessage}) and
 *   `.cause`, never `.stack` or any other property, so no stack frame or
 *   credential-bearing field is ever rendered;
 * - it is cycle-safe (a chain that revisits a link stops) and
 *   depth-bounded (at most {@link MAX_ERROR_CAUSE_DEPTH} links, each
 *   capped by {@link sanitizeForDisplay} at
 *   {@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH}, the budget for a whole
 *   composed message rather than the per-value default), so a malformed
 *   or hostile chain cannot loop or flood -- the whole output is bounded
 *   without a separate total-length cap;
 * - a chain that outruns the depth bound is marked rather than shortened
 *   in silence: the last rendered link has
 *   {@link CAUSE_DEPTH_ELISION_MARKER}, so an operator can tell a
 *   complete chain from a cut one (a chain that ends on its own, or stops
 *   on the cycle guard having already rendered the link it revisits, has
 *   no marker);
 * - it suppresses a link whose raw message repeats the link before it --
 *   the common case, since `asConnectionError` sets a wrapper's message
 *   to its cause's message -- so the same text is not printed twice;
 * - it never throws: a link whose message cannot be read (a throwing
 *   `.message`/`.cause` getter or `toString`, or a non-string `.message`)
 *   renders as `[unreadable error]` rather than propagating, since a
 *   renderer at a last-resort catch boundary must not become a second
 *   failure.
 *
 * An error with no `cause` renders exactly as `errorMessage(err)` escaped
 * at {@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH}, and a non-`Error` value
 * (including `null`/`undefined`) renders its `String(...)` form, matching
 * {@link errorMessage}.
 */
export function sanitizeErrorForDisplay(err: unknown): string {
  const rawMessages: string[] = [];
  const seen = new Set<unknown>();
  let current: unknown = err;
  let elided = false;
  for (let depth = 0; depth < MAX_ERROR_CAUSE_DEPTH; depth++) {
    // Read each link defensively. This is a last-resort display path, so a
    // hostile or malformed error -- a `.message` getter or `toString` that
    // throws, or a non-string `.message` that would make sanitizeForDisplay's
    // code-point walk throw -- must yield a marker, never crash the renderer.
    let message: string;
    try {
      const raw = errorMessage(current);
      message = typeof raw === "string" ? raw : String(raw);
    } catch {
      message = UNREADABLE_LINK;
    }
    // Suppress a link that repeats the previous link's raw message: a wrapper
    // built by asConnectionError has its cause's message verbatim, so the
    // outer and first inner links are usually byte-identical.
    if (rawMessages[rawMessages.length - 1] !== message) {
      rawMessages.push(message);
    }
    seen.add(current);
    // Follow `.cause` on any object link, like {@link causeChainSome}; a
    // non-object link has no chain to follow. typeof null is "object", so the
    // null guard is required. This walk stays its own rather than delegating
    // to that helper: it renders every link under a depth bound and an elision
    // marker instead of stopping at a match, and reads each one defensively. A
    // throwing `.cause` getter ends the chain rather than propagating.
    let next: unknown;
    try {
      next =
        typeof current === "object" && current !== null
          ? (current as { cause?: unknown }).cause
          : undefined;
    } catch {
      next = undefined;
    }
    if (next === undefined || next === null || seen.has(next)) break;
    // The bound is spent and a further link is still there to read. Record that
    // rather than falling out of the loop, so the cut is marked on the rendered
    // output instead of deleting the rest of the chain in silence.
    if (depth === MAX_ERROR_CAUSE_DEPTH - 1) {
      elided = true;
      break;
    }
    current = next;
  }
  const links: string[] = rawMessages.map((message) =>
    sanitizeForDisplay(redactPrivateKeyMaterial(message), {
      maxLength: COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
    }),
  );
  // Appended after the escape and the cap, like the truncation marker inside
  // sanitizeForDisplay: the marker is this module's own fixed ASCII, and a link
  // that spent its whole budget must still be able to say the chain went on.
  if (elided)
    links[links.length - 1] = `${links[links.length - 1]}${ELISION_SUFFIX}`;
  return joinErrorCauseChain(links);
}

/**
 * Join already-escaped links into the rendered chain
 * {@link sanitizeErrorForDisplay} produces, adding only this module's own
 * {@link ERROR_CAUSE_SEPARATOR} framing. It is what a boundary that held
 * the chain link by link renders with, so the text an operator reads is
 * assembled by the same code on either route.
 */
export function joinErrorCauseChain(links: ReadonlyArray<string>): string {
  return links.join(ERROR_CAUSE_SEPARATOR);
}

/**
 * Take a chain {@link sanitizeErrorForDisplay} already rendered and return
 * its links, each escaped and bounded as that renderer bounds them: at
 * most {@link MAX_ERROR_CAUSE_DEPTH} links, each escaped at
 * {@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH}, a longer chain marked with
 * {@link CAUSE_DEPTH_ELISION_MARKER} rather than shortened in silence.
 *
 * For a boundary that receives a rendered chain as TEXT and must pass it
 * onward or show it -- the console relay reading the CLI's fd-3 terminal
 * error, and the console seat rendering one. Such a boundary re-escapes
 * what it received (defense in depth) under a budget split first rather
 * than charged whole to the per-value {@link DEFAULT_MAX_DISPLAY_LENGTH}:
 * a chain composed as a partition by chooser would otherwise be cut inside
 * its first link or two, so a later link's recovery step never reaches
 * the operator. Escaping link by link gives each link the renderer's own
 * budget and depth bound, so the boundary admits exactly the volume the
 * renderer emits and no more.
 *
 * The split is exact rather than heuristic: {@link ERROR_CAUSE_SEPARATOR}
 * is why a link's own text cannot forge a boundary.
 *
 * A chain that arrives already holding {@link CAUSE_DEPTH_ELISION_MARKER}
 * leaves still holding it: the marker is lifted off the last link before
 * it is escaped and appended again afterwards, since the renderer appends
 * it past the cap and re-escaping the link whole would spend the budget
 * on the marker itself. What that preserves is the marker's ABSENCE, the
 * half an operator can rely on -- a boundary that cut the marker off
 * would deliver a cut chain that displays as the whole failure.
 *
 * It escapes and does not redact: {@link redactPrivateKeyMaterial} runs
 * where a fragment is composed and again per link where the chain is
 * first rendered, and its dangling rule is fail-closed past a truncated
 * marker, so a further pass here would buy nothing on a chain this
 * renderer produced while giving a planted marker a second chance to
 * consume the recovery text composed behind it.
 */
export function sanitizeErrorChainLinks(rendered: string): Array<string> {
  const links = rendered.split(ERROR_CAUSE_SEPARATOR);
  const kept = links.slice(0, MAX_ERROR_CAUSE_DEPTH);
  const last = kept.length - 1;
  const arrivedElided = kept[last].endsWith(ELISION_SUFFIX);
  if (arrivedElided) kept[last] = kept[last].slice(0, -ELISION_SUFFIX.length);
  const escaped = kept.map((link) =>
    sanitizeForDisplay(link, {
      maxLength: COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
    }),
  ) as Array<string>;
  // Appended after the escape and the cap, exactly as the renderer appends it.
  if (arrivedElided || links.length > MAX_ERROR_CAUSE_DEPTH)
    escaped[last] = `${escaped[last]}${ELISION_SUFFIX}`;
  return escaped;
}
