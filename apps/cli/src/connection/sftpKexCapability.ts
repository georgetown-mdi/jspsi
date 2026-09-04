// Constrains the SSH key-exchange algorithms the SFTP client offers to those
// this process can actually perform: ssh2 builds its key-exchange offer once
// at module load with no capability probe (unlike its host-key formats), so a
// host missing X25519 would offer it, win negotiation, and only then fail
// mid-handshake. Capability is measured by performing each primitive, once
// per process. No application-level FIPS switch exists: redundant where a
// provider already enforces policy, misleading where it does not. Measured
// assumptions: docs/spec/DEPENDENCY_PINS.md ("Upgrading the SFTP Stack").

import { generateKeyPairSync } from "node:crypto";

import { UsageError } from "@psilink/core";

/**
 * A key-agreement primitive an SSH key-exchange algorithm can be built on,
 * paired with the way to find out whether this process can perform it and the
 * way to recognize the algorithms that need it.
 *
 * @internal
 */
export interface KexPrimitive {
  /** Operator-facing name of the primitive, e.g. `X25519`. */
  readonly primitive: string;
  /**
   * Matches the SSH key-exchange algorithm NAMES built on {@link primitive}.
   *
   * A pattern rather than an enumerated list: a version that adds a hybrid
   * algorithm name would slip past a list and silently reintroduce the
   * mid-handshake failure this module exists to prevent. Erring broad is
   * safe -- a needlessly withheld algorithm leaves the rest of the offer
   * standing.
   */
  readonly matchesAlgorithm: RegExp;
  /**
   * Performs the primitive, throwing when this process's crypto provider does
   * not offer it. Exactly the call ssh2 makes mid-handshake, so the answer is
   * the one that will decide the handshake rather than a proxy for it.
   */
  readonly perform: () => void;
}

/**
 * Every key-agreement primitive whose absence would make an algorithm in ssh2's
 * offer unperformable. X25519 alone today: it is the one primitive in that offer
 * outside the FIPS-approved set, the ECDH and finite-field Diffie-Hellman
 * entries beside it being approved. A primitive is added here only once its
 * absence is a real failure mode, never speculatively -- each entry costs one
 * key generation at first use.
 *
 * @internal
 */
export const KEX_PRIMITIVES: readonly KexPrimitive[] = [
  {
    primitive: "X25519",
    matchesAlgorithm: /25519/i,
    perform: () => {
      generateKeyPairSync("x25519");
    },
  },
];

/**
 * The subset of `primitives` this process cannot perform, decided by performing
 * each one. Takes the set as an argument so a caller -- a test above all -- can
 * decide the verdict rather than inherit the host's; production calls
 * {@link unavailableKexPrimitives}, which supplies {@link KEX_PRIMITIVES} and
 * memoizes.
 *
 * @internal
 */
export function detectUnavailableKexPrimitives(
  primitives: readonly KexPrimitive[],
): readonly KexPrimitive[] {
  return primitives.filter((candidate) => {
    try {
      candidate.perform();
      return false;
    } catch {
      return true;
    }
  });
}

// Memoized because the answer cannot change within a process (a provider is not
// swapped under a running program) and because every dial asks. What makes that
// "every" rather than a list is the chokepoint the constraint sits at, not an
// enumeration of callers: the first connect, the host-key probe, each
// mid-exchange recovery re-dial, and the connection-per-poll cycle-start
// reconnect all reach ssh2 through `connectLocked`.
let memoizedUnavailablePrimitives: readonly KexPrimitive[] | undefined;

/**
 * The key-agreement primitives this process cannot perform, probed once and
 * memoized for the life of the process.
 *
 * @internal
 */
export function unavailableKexPrimitives(): readonly KexPrimitive[] {
  return (memoizedUnavailablePrimitives ??=
    detectUnavailableKexPrimitives(KEX_PRIMITIVES));
}

/**
 * The fragment ssh2 raises when key-exchange negotiation finds nothing in
 * common, reached through ssh2-sftp-client's `getConnection:` wrapper: ssh2's
 * structured `level: "handshake"` does not survive that wrapper (measured),
 * so the message text is what there is to match on -- the same shape as the
 * `Host denied` match in {@link SSH2SFTPClientAdapter}. A reworded message
 * degrades to a missing diagnostic rather than a wrong one: an unmatched
 * rejection passes through untouched.
 */
const KEX_NEGOTIATION_FAILURE_FRAGMENT = "no matching key exchange algorithm";

// Identified by type rather than recognized by its text: this diagnostic
// REPLACES ssh2's message and keeps it one cause link down, so a downstream
// classifier -- the connection-per-poll cycle-start re-dial, which sees what
// the dial sequence threw rather than what ssh2 raised -- has no fragment
// left to match. A type is also the one recognizer no wire party can write:
// nothing outside this module constructs it, and only for a rejection the
// fragment and the capability verdict have already classified.
class UnperformableKexNegotiationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UnperformableKexNegotiationError";
  }
}

const hasNegotiationFailureFragment = (error: unknown): boolean =>
  error instanceof Error &&
  error.message.includes(KEX_NEGOTIATION_FAILURE_FRAGMENT);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Keyed by KIND, not just text: a RegExp stringifies to its own literal, so an
// operator's string entry "/25519/i" would read identically to this module's
// own /25519/i, and keying by text alone would treat the module's removal as
// already present and drop it -- silently readmitting the unperformable
// algorithm, since ssh2 matches a string `remove` entry exactly (measured).
// Tagging the kind also makes a second constrain of the same options a no-op,
// which matters because the adapter re-dials from its stored options.
const filterKey = (entry: unknown): string =>
  entry instanceof RegExp ? `re:${String(entry)}` : `raw:${String(entry)}`;

const asArray = (value: unknown): unknown[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const primitiveNames = (primitives: readonly KexPrimitive[]): string =>
  primitives.map((entry) => entry.primitive).join(", ");

/** A warning sink, so this module has no dependency on the logger's type. */
interface WarnSink {
  warn(message: string): void;
}

/**
 * Rewrite `connectOptions` so the key-exchange algorithms it offers exclude
 * every one built on a primitive `unavailable` names, and return the result. The
 * argument is left untouched.
 *
 * With nothing unavailable -- every supported host -- the options are returned
 * as they came, so a healthy platform negotiates exactly what it negotiated
 * before this module existed.
 *
 * The offer is expressed through ssh2's own `algorithms.kex` modifier object
 * (`{ remove: [...] }`) rather than through a list psilink enumerates, so ssh2
 * keeps ownership of WHICH algorithms are offered and in what order, and this
 * module owns only the subtraction. Three shapes reach here and each keeps that
 * property:
 *
 * - No operator `kex` at all (the default): the removal modifier alone, applied
 *   to ssh2's own defaults.
 * - An operator LIST: filtered directly, since a list replaces ssh2's defaults
 *   outright and a modifier cannot reach into it. An emptied list is refused
 *   rather than forwarded -- ssh2 reads an empty list as "unspecified" and falls
 *   back to the very defaults the filter just rejected (measured). A list that
 *   ARRIVES empty rejects nothing and so is not refused: it takes the removal
 *   modifier, which is ssh2's own reading of it minus the unperformable entries.
 * - An operator MODIFIER: the removal merged into its own `remove`, which ssh2
 *   applies after `append`/`prepend` (measured), so an unperformable algorithm
 *   cannot be re-added by the entry beside it.
 *
 * @throws UsageError when an operator-supplied list names only algorithms this
 *   process cannot perform, so nothing survives to offer.
 * @internal
 */
export function constrainKexToPlatformCapabilities(
  connectOptions: Record<string, unknown>,
  unavailable: readonly KexPrimitive[],
  log: WarnSink,
): Record<string, unknown> {
  if (unavailable.length === 0) return connectOptions;

  const algorithms = connectOptions["algorithms"];
  const base = isPlainObject(algorithms) ? algorithms : undefined;
  return {
    ...connectOptions,
    algorithms: {
      ...base,
      kex: constrainKexValue(base?.["kex"], unavailable, log),
    },
  };
}

function constrainKexValue(
  requested: unknown,
  unavailable: readonly KexPrimitive[],
  log: WarnSink,
): unknown {
  const unperformable = (name: unknown): boolean =>
    typeof name === "string" &&
    unavailable.some((entry) => entry.matchesAlgorithm.test(name));
  const removals = unavailable.map((entry) => entry.matchesAlgorithm);

  if (Array.isArray(requested)) {
    // An empty list drops nothing, so the filter below would hand it back
    // untouched and ssh2 would read it as "unspecified" and restore its full
    // defaults (measured) -- the algorithms this module exists to withhold.
    if (requested.length === 0) {
      log.warn(
        `connection.provider_options.algorithms.kex is an empty list, which ` +
          `selects nothing rather than restricting the offer: the default ` +
          `key-exchange algorithms apply. Offering those minus the ones ` +
          `requiring ${primitiveNames(unavailable)}, which this process's ` +
          `crypto provider does not offer.`,
      );
      return { remove: removals };
    }
    const kept = requested.filter((name) => !unperformable(name));
    const dropped = requested.filter(unperformable);
    if (dropped.length === 0) return requested;
    if (kept.length === 0)
      throw emptiedOperatorListError(requested, unavailable);
    log.warn(
      `dropping ${dropped.length} key-exchange algorithm(s) from ` +
        `connection.provider_options.algorithms.kex: this process's crypto ` +
        `provider does not offer ${primitiveNames(unavailable)}, so offering ` +
        `them would fail the handshake after winning the negotiation. ` +
        `${kept.length} remain.`,
    );
    return kept;
  }

  if (requested === undefined) return { remove: removals };

  if (isPlainObject(requested)) {
    const existing = asArray(requested["remove"]);
    const existingKeys = new Set(existing.map(filterKey));
    return {
      ...requested,
      remove: [
        ...existing,
        ...removals.filter((entry) => !existingKeys.has(filterKey(entry))),
      ],
    };
  }

  // Neither a list nor a modifier: ssh2 ignores such a value and falls back to
  // its defaults (measured), so replacing it withholds nothing the operator was
  // getting, and leaving it would offer the algorithms this process cannot
  // perform. The warning is what tells an operator their setting was inert.
  log.warn(
    `ignoring connection.provider_options.algorithms.kex: expected a list of ` +
      `algorithm names or an append/prepend/remove object. Offering ssh2's ` +
      `default key-exchange algorithms minus those requiring ` +
      `${primitiveNames(unavailable)}, which this process's crypto provider ` +
      `does not offer.`,
  );
  return { remove: removals };
}

function emptiedOperatorListError(
  requested: readonly unknown[],
  unavailable: readonly KexPrimitive[],
): UsageError {
  // The requested names are the operator's own bytes under no length bound, so
  // they ride a cause link of their own: the display boundary caps each link
  // separately, and a long list sharing this one would delete the instruction
  // the operator has to act on. Composed raw -- the display sink escapes the
  // rendered chain once (see CONTRIBUTING.md, Operator-facing escaping).
  return new UsageError(
    `connection.provider_options.algorithms.kex names only key exchanges this ` +
      `host cannot perform, its crypto provider offering no ` +
      `${primitiveNames(unavailable)}. Name one that does not need ` +
      `${primitiveNames(unavailable)}, or remove the setting to offer ssh2's ` +
      `defaults minus those.`,
    {
      cause: new Error(
        `requested key-exchange algorithms: ${requested.join(", ")}`,
      ),
    },
  );
}

/**
 * Whether `error` is a key-exchange negotiation failure on a process that
 * cannot perform one of `unavailable` -- the permanently incompatible case,
 * where no re-dial and no elapsed time changes anything. Recognizes both
 * ssh2's own rejection and {@link explainKexNegotiationFailure}'s re-raise, so
 * the connect loop's retry predicate and the connection-per-poll cycle-start
 * re-dial reach one verdict without each needing its own matcher.
 *
 * The capability verdict decides this, not the message text: ssh2 renders a
 * server's `SSH_MSG_DISCONNECT` description into the same message, and a
 * disconnect precedes host-key verification, so a server or an on-path
 * attacker can write the fragment verbatim. The verdict is this process's own
 * reading of its own crypto provider, taken before the dial -- on a capable
 * host a spoofed fragment decides nothing; on an incapable one the writer
 * could already deny the exchange outright, gaining only a faster failure.
 *
 * @internal
 */
export function isUnperformableKexNegotiationFailure(
  error: unknown,
  unavailable: readonly KexPrimitive[],
): boolean {
  return (
    unavailable.length > 0 &&
    (error instanceof UnperformableKexNegotiationError ||
      hasNegotiationFailureFragment(error))
  );
}

/**
 * Given a dial rejection, return it as it stands, or -- when it is a
 * key-exchange negotiation failure on a process missing a primitive -- an
 * error naming the platform capability behind it, holding the original as
 * its `cause`. This is the permanently-incompatible case: nothing psilink
 * offers can satisfy a server that accepts only algorithms built on a
 * missing primitive, and ssh2's own "no matching key exchange algorithm"
 * names neither the withheld algorithms nor the reason, leaving an operator
 * to conclude the server is misconfigured.
 *
 * @internal
 */
export function explainKexNegotiationFailure(
  error: unknown,
  unavailable: readonly KexPrimitive[],
): unknown {
  // The fragment rather than the wider classification above, which also answers
  // for a rejection this function has already explained: matching that one would
  // wrap the diagnostic in a second copy of itself.
  if (unavailable.length === 0 || !hasNegotiationFailureFragment(error))
    return error;
  const names = primitiveNames(unavailable);
  return new UnperformableKexNegotiationError(
    `the SFTP server accepts no key exchange this host can perform: its ` +
      `crypto provider offers no ${names}. Ask the server's administrator to ` +
      `enable an ECDH or Diffie-Hellman group exchange, or run psilink on a ` +
      `host that provides ${names}.`,
    { cause: error },
  );
}
