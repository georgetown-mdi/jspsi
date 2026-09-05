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
 * Marker {@link sanitizeErrorForDisplay} appends to the last link it renders
 * when the walk stops at {@link MAX_ERROR_CAUSE_DEPTH} with the chain still
 * running: the depth cutoff says so rather than shortening the chain silently,
 * the same way {@link DISPLAY_TRUNCATION_MARKER} marks a link the per-link cap
 * cut. An operator reading a chain that ends here can tell "this is the whole
 * failure" from "there was more", which is what decides whether the detail they
 * need is missing.
 *
 * It carries no count. Counting the remainder means walking the rest of the
 * chain -- the walk this bound exists to not perform, and unbounded in exactly
 * the adversarial case the bound is defensive against. A composition site that
 * knows its own link count states it in the last link it composes, where the
 * number is free (`checkLinkageSatisfiability` in
 * `apps/cli/src/commands/linkagePreflight.ts`), and this marker stays the
 * generic backstop for a chain nobody counted.
 *
 * Plain ASCII, and appended AFTER the per-link escape and cap, so the marker
 * itself can neither reintroduce a control character nor be cut off the link it
 * marks.
 *
 * Being plain ASCII also means it is not authenticated and cannot be: the escape
 * passes the marker's own text through unchanged, so a link whose message ends
 * with that text renders byte-identically to one this renderer marked. That is
 * the same open class {@link DISPLAY_TRUNCATION_MARKER} carries, where a
 * first-party fragment (an over-long filename's preview) already ends with the
 * marker by construction. What bounds the cost is the asymmetry: a copy claims a
 * loss that did not happen, and cannot conceal one that did, since the append
 * below runs after the escape whatever the link carried. So the marker's ABSENCE
 * is what an operator can rely on -- no marker means the walk dropped nothing --
 * while its presence says detail MAY be missing rather than that it is.
 */
export const CAUSE_DEPTH_ELISION_MARKER = "...[further causes elided]";

/**
 * {@link CAUSE_DEPTH_ELISION_MARKER} as it sits on a rendered chain's last link,
 * behind the single space the append below separates it with. Both the renderer
 * and the re-render seam write the marker through this constant, so the text a
 * boundary looks for is the text the renderer put there.
 */
const ELISION_SUFFIX = ` ${CAUSE_DEPTH_ELISION_MARKER}`;

/**
 * Separator placed between an error's message and each chained `cause` message.
 * The leading newline is the one control character in the assembled output, and
 * it is deliberate: a fixed formatting byte this module emits (so each cause
 * renders on its own line in a terminal), never partner-controlled input. Every
 * byte that comes from an error message is escaped by {@link sanitizeForDisplay}
 * before it is joined, so no partner-controlled control character can ride in
 * alongside this one. Consumers that render to HTML must opt into preserving the
 * newline (e.g. `white-space: pre-line`); browsers collapse it otherwise.
 *
 * That escape-then-join order is also what makes the join REVERSIBLE, which is
 * what {@link sanitizeErrorChainLinks} relies on: the escape rewrites every code
 * point outside printable ASCII, the newline among them, so the only raw newline
 * a rendered chain can carry is the one this constant put there. A link whose own
 * text reads `caused by:` therefore cannot forge a link boundary.
 */
const ERROR_CAUSE_SEPARATOR = "\ncaused by: ";

/**
 * Fallback emitted for a cause-chain link whose message cannot be read -- a
 * hostile or malformed error whose `.message`/`.cause` getter or
 * `toString`/`Symbol.toPrimitive` throws, or whose `.message` is a non-string.
 * Plain ASCII, so it passes through {@link sanitizeForDisplay} unchanged and
 * keeps this renderer total: it never throws at the operator-facing, last-resort
 * boundary it exists to protect.
 */
const UNREADABLE_LINK = "[unreadable error]";

const REDACTED_PRIVATE_KEY = "[redacted private key]";

/**
 * A PEM / OpenSSH private-key block (RSA, EC, DSA, OPENSSH, ENCRYPTED, or
 * unlabelled), from its BEGIN marker to the next END marker, plus a fallback for
 * a truncated block (a BEGIN with no END, e.g. a key sliced into an error). The
 * marker `-----BEGIN ... PRIVATE KEY-----` never legitimately appears in
 * operator-facing error or log text, so matching it carries no false-positive
 * risk. (PGP `... PRIVATE KEY BLOCK-----` is intentionally not matched: psilink
 * uses no PGP keys, so there is no such sink to back-stop.)
 *
 * The gap between BEGIN and END uses a tempered negative lookahead so it cannot
 * cross another BEGIN marker. Without it, a long run of BEGIN markers with no END
 * makes the lazy `[\s\S]*?` rescan to end-of-string for every match attempt --
 * O(n^2) backtracking (catastrophic on partner-controlled error text, which this
 * renderer is built to handle). The lookahead bounds each attempt to one block.
 */
const PRIVATE_KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?:(?!-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----)[\s\S])*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g;
const PRIVATE_KEY_DANGLING = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g;

/**
 * Last-resort redaction backstop for PEM / OpenSSH private-key material in text
 * about to be shown to an operator. This is NOT the primary defense:
 * secret-bearing files are parsed through the sensitive-file chokepoint (shared
 * in `@psilink/core`, re-exported by the CLI) so a parse error never carries
 * source, and that prevention is what callers must rely on. This only contains
 * an UNANTICIPATED sink -- some future code path that interpolates key material
 * into an error -- by stripping private-key blocks, which are unambiguous and
 * never a legitimate part of error output.
 *
 * The dangling rule replaces from a BEGIN marker with no END to the end of the
 * text, which is deliberately FAIL-CLOSED: a key sliced into an error carries no
 * reliable structure by the time it is rendered -- its line breaks may have been
 * folded to spaces or stripped entirely by whatever carried it -- so the only
 * bound that holds for every delivery is "everything after the marker". Any rule
 * that infers where the key body ends from the shape of the remaining bytes
 * leaks the body whenever the shape it expects is absent.
 *
 * The cost of failing closed is that the replacement also consumes whatever was
 * composed after the marker. That is why partner-controlled fragments are passed
 * through this function AT THEIR COMPOSITION SITE, before being interpolated
 * into a message: a planted marker inside an already-redacted fragment does not
 * exist by the time the whole link is rendered, so it cannot reach the operator
 * text composed behind it. The function is idempotent -- the replacement carries
 * no marker -- so the per-link application below is unaffected by a fragment
 * having been redacted already.
 *
 * This is redaction, not escaping, and it does not make a composition site a
 * second escaping altitude: the fragment is still interpolated raw and still
 * escaped exactly once, by {@link sanitizeForDisplay} at the display sink (see
 * CONTRIBUTING.md, Operator-facing escaping).
 *
 * Deliberately narrow: it does NOT scrub by secret-shape (e.g. a 43-char
 * base64url token), because the shared-secret and a host-key fingerprint share
 * that shape and fingerprints are shown to the operator on purpose -- shape
 * scrubbing would redact legitimate output. Bare-token containment belongs to the
 * chokepoint, not here.
 */
export function redactPrivateKeyMaterial(text: string): string {
  return text
    .replace(PRIVATE_KEY_BLOCK, REDACTED_PRIVATE_KEY)
    .replace(PRIVATE_KEY_DANGLING, REDACTED_PRIVATE_KEY);
}

/**
 * Prepare a fragment somebody else chose -- a partner-, server-, or
 * operator-supplied value -- for interpolation into a line that reaches a log,
 * console, or prompt sink: {@link redactPrivateKeyMaterial} first, then
 * {@link sanitizeForDisplay}. This is the composition-site half of the
 * private-key assignment, and it pairs with the per-argument pass the log
 * prefixer applies at the sink (`setLogPrefixer` in `./logger`).
 *
 * Redacting BEFORE escaping is what bounds the fail-closed dangling rule to the
 * fragment that carried the marker. Applied here, a planted marker no longer
 * exists when the sink's pass runs, so that pass cannot consume the first-party
 * explanation or recovery step composed behind the fragment -- the failure the
 * sink pass would otherwise introduce on every line whose fragments come first.
 * The order also matters within this function: escaping first would truncate a
 * long fragment at the display cap, and a `BEGIN` whose `END` was cut off is a
 * dangling marker where a whole block stood.
 *
 * Use it wherever {@link sanitizeForDisplay} would be used on a log- or
 * prompt-bound fragment, uniformly rather than by position: "this fragment is
 * last on its line, so nothing follows it to lose" is a property that no check
 * holds and that a later copy edit silently breaks. Escaping still happens
 * exactly once -- this is the same single {@link sanitizeForDisplay} call, not a
 * second altitude (see CONTRIBUTING.md, Operator-facing escaping) -- so a
 * fragment routed into an `Error` instead keeps composing RAW and is escaped by
 * {@link sanitizeErrorForDisplay} where the chain is rendered.
 *
 * Do NOT fit a length budget by comparing this against {@link sanitizeForDisplay}
 * at the same `maxLength`: this can return the LONGER of the two. The escape
 * admits a code point only when its whole escape fits, so replacing a block with
 * the much shorter marker can let a later code point fit that the escape-only
 * form had to stop before -- measured at up to the longest escape minus one. It
 * is {@link redactPrivateKeyMaterial} that never lengthens its input, and that is
 * the function the budgeted callers fit over (the rendezvous entry guard, and the
 * host-key refusals, which redact raw and escape once at the renderer).
 */
export function redactAndSanitizeForDisplay(
  value: string,
  options?: SanitizeForDisplayOptions,
): Displayable {
  return sanitizeForDisplay(redactPrivateKeyMaterial(value), options);
}

/**
 * Render an arbitrary thrown value as operator-safe display text: its own
 * message followed by each chained `cause` message, every link passed through
 * {@link sanitizeForDisplay} so partner- or server-controlled bytes embedded in
 * any link -- control characters, the ESC that drives ANSI sequences, CR/LF
 * usable for log-line spoofing, bidi overrides, zero-width and confusable
 * characters -- cannot reach a terminal, log line, or UI element. Each link is
 * additionally passed through a narrow secret-redaction backstop that strips PEM
 * / OpenSSH private-key blocks (see {@link redactPrivateKeyMaterial}); this is a
 * last resort for an unanticipated sink, not the primary defense (secret-bearing
 * files are parsed leak-safely at their source). That backstop is fail-closed
 * past a truncated key, so a fragment a partner controls is redacted where it is
 * composed rather than here -- see {@link redactPrivateKeyMaterial}.
 *
 * This is the display-boundary seam for rendering a raw error INSTANCE to a
 * human. The transport and message layers deliberately preserve the original
 * error object so it can still be classified by type (e.g. `transport` vs
 * `closed`); the escaping therefore cannot happen there without mis-tagging the
 * error, and must happen here, where it is finally shown. Use it in place of
 * `console.error(err)` or a direct `err.message` interpolation at any
 * operator-facing sink, never on a value used for comparison, storage, or
 * hashing (it is lossy; see {@link sanitizeForDisplay}).
 *
 * The walk is deliberately narrow and defensive:
 * - it reads only each link's `.message` (via {@link errorMessage}) and
 *   `.cause`, never `.stack` or any other property, so no stack frame or
 *   credential-bearing field is ever rendered;
 * - it is cycle-safe (a chain that revisits a link stops) and depth-bounded (at
 *   most {@link MAX_ERROR_CAUSE_DEPTH} links, each capped by
 *   {@link sanitizeForDisplay} at {@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH},
 *   the budget for a whole composed message rather than the per-value default),
 *   so a malformed or hostile chain cannot loop or flood -- the whole output is
 *   bounded without a separate total-length cap;
 * - a chain that outruns the depth bound is marked rather than shortened in
 *   silence: the last rendered link carries {@link CAUSE_DEPTH_ELISION_MARKER},
 *   so an operator can tell a complete chain from a cut one (a chain that ends
 *   on its own, or stops on the cycle guard having already rendered the link it
 *   revisits, carries no marker);
 * - it suppresses a link whose raw message repeats the link before it -- the
 *   common case, since `asConnectionError` sets a wrapper's message to its
 *   cause's message -- so the same text is not printed twice;
 * - it never throws: a link whose message cannot be read (a throwing
 *   `.message`/`.cause` getter or `toString`, or a non-string `.message`)
 *   renders as `[unreadable error]` rather than propagating, since a renderer at
 *   a last-resort catch boundary must not become a second failure.
 *
 * An error with no `cause` renders exactly as `errorMessage(err)` escaped at
 * {@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH}, and a non-`Error` value
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
    // built by asConnectionError carries its cause's message verbatim, so the
    // outer and first inner links are usually byte-identical.
    if (rawMessages[rawMessages.length - 1] !== message) {
      rawMessages.push(message);
    }
    seen.add(current);
    // Follow `.cause` on any object link, like {@link causeChainSome}; a
    // non-object link has no chain to follow. typeof null is "object", so the
    // null guard is load-bearing. This walk stays its own rather than delegating
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
 * {@link ERROR_CAUSE_SEPARATOR} framing. It is what a boundary that carried the
 * chain link by link renders with, so the text an operator reads is assembled by
 * the same code on either route.
 */
export function joinErrorCauseChain(links: ReadonlyArray<string>): string {
  return links.join(ERROR_CAUSE_SEPARATOR);
}

/**
 * Take a chain {@link sanitizeErrorForDisplay} already rendered and return its
 * links, each escaped and bounded as that renderer bounds them: at most
 * {@link MAX_ERROR_CAUSE_DEPTH} links, each escaped at
 * {@link COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH}, a longer chain marked with
 * {@link CAUSE_DEPTH_ELISION_MARKER} rather than shortened in silence.
 *
 * This is for a boundary that receives a rendered chain as TEXT and must carry it
 * onward or show it -- the console relay reading the CLI's fd-3 terminal error,
 * and the console seat that renders one. Such a boundary re-escapes what it
 * received (defense in depth: it does not trust the sender's own pass), and the
 * budget it re-escapes under is the point of splitting first. A chain is not one
 * value: charging the whole of it to the per-value {@link
 * DEFAULT_MAX_DISPLAY_LENGTH} cuts it wherever 256 characters fall, which on a
 * refusal composed as a partition by chooser is inside its first link or two, so
 * the recovery step a later link carries never reaches the operator. Escaping
 * link by link gives each link the budget the renderer already gave it, and takes
 * the renderer's own depth bound for the count, so the boundary admits exactly
 * the volume the renderer emits and no more.
 *
 * The split is exact rather than heuristic, and {@link ERROR_CAUSE_SEPARATOR}
 * carries why: a link's own text cannot forge a boundary.
 *
 * A chain that arrives already carrying {@link CAUSE_DEPTH_ELISION_MARKER}
 * leaves still carrying it: the marker is lifted off the last link before that
 * link is escaped and appended again afterwards, since the renderer appends it
 * past the cap and re-escaping the link whole would spend the budget on the
 * marker itself. What that preserves is the marker's ABSENCE, which is the half
 * an operator can rely on -- a boundary that cut the marker off would deliver a
 * cut chain reading as the whole failure.
 *
 * It escapes and does not redact, which is what a re-render boundary does with
 * text somebody else composed: {@link redactPrivateKeyMaterial} runs where a
 * fragment is composed and again per link where the chain is first rendered, and
 * its dangling rule is fail-closed past a truncated marker, so a further pass
 * here would buy nothing on a chain this renderer produced while giving a planted
 * marker a second chance to consume the recovery text composed behind it.
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
