import { describe, expect, test, vi } from "vitest";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  UsageError,
  sanitizeErrorForDisplay,
} from "@psilink/core";

import {
  KEX_PRIMITIVES,
  constrainKexToPlatformCapabilities,
  detectUnavailableKexPrimitives,
  explainKexNegotiationFailure,
  isUnperformableKexNegotiationFailure,
  unavailableKexPrimitives,
} from "../../src/connection/sftpKexCapability";
import type { KexPrimitive } from "../../src/connection/sftpKexCapability";

// The platform-capability constraint on the SFTP client's key-exchange offer.
// These pin the shape of the offer with the probe's verdict forced BOTH ways --
// the verdict a real host supplies is the one thing here not under a test's
// control -- plus the refusal when an operator's own list has nothing left in it.
// What the constrained offer means to the installed ssh2 is not asserted here but
// DRIVEN, off the wire, in test/integration/sftpKexOffer.test.ts.

// Stands in for a primitive the host cannot perform, without needing a host that
// cannot perform one.
const MISSING: KexPrimitive = {
  primitive: "X25519",
  matchesAlgorithm: /25519/i,
  perform: () => {
    throw new Error("error:0308010C:digital envelope routines::unsupported");
  },
};

const AVAILABLE: KexPrimitive = {
  primitive: "X25519",
  matchesAlgorithm: /25519/i,
  perform: () => {},
};

const sink = () => ({ warn: vi.fn() });

describe("detectUnavailableKexPrimitives", () => {
  test("reports a primitive this process can perform as available", () => {
    expect(detectUnavailableKexPrimitives([AVAILABLE])).toEqual([]);
  });

  test("reports a primitive whose performance throws as unavailable", () => {
    expect(detectUnavailableKexPrimitives([MISSING])).toEqual([MISSING]);
  });

  test("performs each candidate exactly once per detection", () => {
    const perform = vi.fn();
    detectUnavailableKexPrimitives([{ ...AVAILABLE, perform }]);
    expect(perform).toHaveBeenCalledTimes(1);
  });
});

describe("unavailableKexPrimitives", () => {
  test("memoizes the probe: repeat calls return the same array", () => {
    // Identity rather than equality, so this fails if the probe is ever re-run
    // per dial (it runs on the first connect, the host-key probe, and every
    // recovery re-dial).
    expect(unavailableKexPrimitives()).toBe(unavailableKexPrimitives());
  });

  test("probes X25519 by generating a key, the call ssh2 makes mid-handshake", () => {
    // The one entry, and the reason the module exists: ssh2's own
    // generateKeyPairSync("x25519") is what dies on a provider without it.
    expect(KEX_PRIMITIVES).toHaveLength(1);
    expect(KEX_PRIMITIVES[0]?.primitive).toBe("X25519");
  });

  test("the X25519 pattern matches every algorithm name built on it", () => {
    const pattern = KEX_PRIMITIVES[0]!.matchesAlgorithm;
    // The two RFC 8731 spellings ssh2 offers today, plus the hybrids a later
    // version can add -- the reason the entry holds a pattern and not a list.
    for (const name of [
      "curve25519-sha256",
      "curve25519-sha256@libssh.org",
      "sntrup761x25519-sha512@openssh.com",
      "mlkem768x25519-sha256",
    ])
      expect(pattern.test(name)).toBe(true);
    // And nothing in the approved remainder of ssh2's offer.
    for (const name of [
      "ecdh-sha2-nistp256",
      "ecdh-sha2-nistp384",
      "ecdh-sha2-nistp521",
      "diffie-hellman-group-exchange-sha256",
      "diffie-hellman-group14-sha256",
      "diffie-hellman-group18-sha512",
      "ext-info-c",
      "kex-strict-c-v00@openssh.com",
    ])
      expect(pattern.test(name)).toBe(false);
  });

  test("no pattern has the global flag, which would make matching stateful", () => {
    // A `g` pattern advances `lastIndex` on every `test`, so the same name would
    // match and then not match -- here, and inside ssh2, which is handed these
    // very objects as its `remove` filters.
    for (const entry of KEX_PRIMITIVES) {
      expect(entry.matchesAlgorithm.global).toBe(false);
      expect(entry.matchesAlgorithm.sticky).toBe(false);
    }
  });
});

describe("constrainKexToPlatformCapabilities with every primitive available", () => {
  test("returns the options untouched, so a healthy host is unaffected", () => {
    const log = sink();
    const options = { host: "sftp.example", algorithms: { cipher: ["aes"] } };
    expect(constrainKexToPlatformCapabilities(options, [], log)).toBe(options);
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("leaves an operator's own kex list exactly as written", () => {
    const options = { algorithms: { kex: ["curve25519-sha256"] } };
    expect(constrainKexToPlatformCapabilities(options, [], sink())).toBe(
      options,
    );
  });
});

describe("constrainKexToPlatformCapabilities with X25519 unavailable", () => {
  test("offers ssh2's defaults minus X25519 when the operator set no kex", () => {
    const log = sink();
    const constrained = constrainKexToPlatformCapabilities(
      { host: "sftp.example" },
      [MISSING],
      log,
    );
    // ssh2 stays the owner of WHICH algorithms are offered: psilink supplies the
    // subtraction, never a list of its own.
    expect(constrained).toEqual({
      host: "sftp.example",
      algorithms: { kex: { remove: [MISSING.matchesAlgorithm] } },
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("keeps the operator's other algorithm categories alongside the removal", () => {
    const constrained = constrainKexToPlatformCapabilities(
      {
        algorithms: { cipher: ["aes256-gcm@openssh.com"], compress: ["none"] },
      },
      [MISSING],
      sink(),
    );
    expect(constrained["algorithms"]).toEqual({
      cipher: ["aes256-gcm@openssh.com"],
      compress: ["none"],
      kex: { remove: [MISSING.matchesAlgorithm] },
    });
  });

  test("filters an operator's kex list and warns about what it dropped", () => {
    const log = sink();
    const constrained = constrainKexToPlatformCapabilities(
      {
        algorithms: {
          kex: [
            "curve25519-sha256@libssh.org",
            "ecdh-sha2-nistp256",
            "curve25519-sha256",
            "diffie-hellman-group14-sha256",
          ],
        },
      },
      [MISSING],
      log,
    );
    expect(constrained["algorithms"]).toEqual({
      kex: ["ecdh-sha2-nistp256", "diffie-hellman-group14-sha256"],
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toContain("X25519");
  });

  test("leaves an operator list that needs no filtering alone and warns nothing", () => {
    const log = sink();
    const constrained = constrainKexToPlatformCapabilities(
      { algorithms: { kex: ["ecdh-sha2-nistp256"] } },
      [MISSING],
      log,
    );
    expect(constrained["algorithms"]).toEqual({
      kex: ["ecdh-sha2-nistp256"],
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  test("refuses rather than forwarding an operator list filtered to empty", () => {
    // An empty list is NOT an empty offer to ssh2: it is treated as "unspecified"
    // and falls back to the very defaults the filter rejected, so the refusal is
    // what keeps an unperformable algorithm off the wire.
    let thrown: unknown;
    try {
      constrainKexToPlatformCapabilities(
        {
          algorithms: {
            kex: ["curve25519-sha256", "curve25519-sha256@libssh.org"],
          },
        },
        [MISSING],
        sink(),
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    const error = thrown as UsageError;
    expect(error.message).toContain("X25519");
    expect(error.message).toContain(
      "connection.provider_options.algorithms.kex",
    );
    // The operator's own unbounded list rides its own cause link, so it cannot
    // spend the display budget the instruction needs.
    expect((error.cause as Error).message).toContain("curve25519-sha256");
    expect(error.message).not.toContain("curve25519-sha256");
  });

  test("replaces an operator list that arrives empty, which offers nothing", () => {
    // An empty list drops no algorithm, so the filter has nothing to reject and
    // the refusal is not the answer -- but forwarding it would restore ssh2's
    // full defaults, X25519 included (driven on the wire in
    // test/integration/sftpKexOffer.test.ts). The removal modifier is what an
    // empty list means to ssh2, minus what this process cannot perform.
    const log = sink();
    const constrained = constrainKexToPlatformCapabilities(
      { algorithms: { kex: [] } },
      [MISSING],
      log,
    );
    expect(constrained["algorithms"]).toEqual({
      kex: { remove: [MISSING.matchesAlgorithm] },
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toContain(
      "connection.provider_options.algorithms.kex",
    );
  });

  test("merges the removal into an operator's modifier object", () => {
    const constrained = constrainKexToPlatformCapabilities(
      {
        algorithms: {
          kex: {
            append: ["diffie-hellman-group14-sha256"],
            remove: ["ssh-rsa"],
          },
        },
      },
      [MISSING],
      sink(),
    );
    // ssh2 applies `remove` after `append`/`prepend`, so a re-added unperformable
    // algorithm is still withheld.
    expect(constrained["algorithms"]).toEqual({
      kex: {
        append: ["diffie-hellman-group14-sha256"],
        remove: ["ssh-rsa", MISSING.matchesAlgorithm],
      },
    });
  });

  // A RegExp stringifies to its own literal, so an operator who writes that
  // literal AS A STRING reads the same as this module's own matcher. Keying the
  // dedupe on the text alone would take the module's removal for one already
  // present and drop it -- and ssh2 matches a string `remove` entry exactly, so
  // the survivor would remove nothing and the unperformable names would go back
  // on the wire, silently.
  test("keeps its own removal when an operator removes the same text as a string", () => {
    const constrained = constrainKexToPlatformCapabilities(
      { algorithms: { kex: { remove: [String(MISSING.matchesAlgorithm)] } } },
      [MISSING],
      sink(),
    );
    expect(constrained["algorithms"]).toEqual({
      kex: { remove: ["/25519/i", MISSING.matchesAlgorithm] },
    });
  });

  test("normalizes a single-valued operator remove before merging", () => {
    const constrained = constrainKexToPlatformCapabilities(
      { algorithms: { kex: { remove: "ssh-rsa" } } },
      [MISSING],
      sink(),
    );
    expect(constrained["algorithms"]).toEqual({
      kex: { remove: ["ssh-rsa", MISSING.matchesAlgorithm] },
    });
  });

  test("replaces an unrecognized kex value and warns that it was inert", () => {
    const log = sink();
    const constrained = constrainKexToPlatformCapabilities(
      { algorithms: { kex: "ecdh-sha2-nistp256" } },
      [MISSING],
      log,
    );
    expect(constrained["algorithms"]).toEqual({
      kex: { remove: [MISSING.matchesAlgorithm] },
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn.mock.calls[0]?.[0]).toContain(
      "connection.provider_options.algorithms.kex",
    );
  });

  test("is idempotent, so a recovery re-dial on retained options adds nothing", () => {
    const once = constrainKexToPlatformCapabilities(
      { host: "sftp.example" },
      [MISSING],
      sink(),
    );
    const twice = constrainKexToPlatformCapabilities(once, [MISSING], sink());
    expect(twice).toEqual(once);
  });

  test("is idempotent over a filtered operator list too", () => {
    const options = {
      algorithms: { kex: ["curve25519-sha256", "ecdh-sha2-nistp256"] },
    };
    const once = constrainKexToPlatformCapabilities(options, [MISSING], sink());
    expect(constrainKexToPlatformCapabilities(once, [MISSING], sink())).toEqual(
      once,
    );
  });

  test("does not mutate the options it was given", () => {
    const options = {
      algorithms: { kex: ["curve25519-sha256", "ecdh-sha2-nistp256"] },
    };
    constrainKexToPlatformCapabilities(options, [MISSING], sink());
    expect(options.algorithms.kex).toEqual([
      "curve25519-sha256",
      "ecdh-sha2-nistp256",
    ]);
  });
});

describe("explainKexNegotiationFailure", () => {
  // The message ssh2-sftp-client shows when the two ends share no key-exchange
  // algorithm, measured against the pinned versions.
  const negotiationFailure = new Error(
    "getConnection: Handshake failed: no matching key exchange algorithm",
  );

  test("passes the rejection through when every primitive is available", () => {
    expect(explainKexNegotiationFailure(negotiationFailure, [])).toBe(
      negotiationFailure,
    );
  });

  test("passes an unrelated rejection through untouched", () => {
    const other = new Error("getConnection: Host denied (verification failed)");
    expect(explainKexNegotiationFailure(other, [MISSING])).toBe(other);
  });

  test("passes a non-Error rejection through untouched", () => {
    expect(explainKexNegotiationFailure("nope", [MISSING])).toBe("nope");
  });

  test("names the missing primitive, keeping ssh2's own error as the cause", () => {
    const explained = explainKexNegotiationFailure(negotiationFailure, [
      MISSING,
    ]) as Error;
    expect(explained).not.toBe(negotiationFailure);
    expect(explained.message).toContain("X25519");
    expect(explained.message).toContain("server's administrator");
    expect(explained.cause).toBe(negotiationFailure);
  });

  test("leaves its own diagnostic alone rather than wrapping it twice", () => {
    // The classification below answers for the diagnostic as well as for ssh2's
    // rejection, so an explanation keyed on it would nest a second copy of itself
    // and bury ssh2's error a link deeper than the display sink renders.
    const explained = explainKexNegotiationFailure(negotiationFailure, [
      MISSING,
    ]);
    expect(explainKexNegotiationFailure(explained, [MISSING])).toBe(explained);
  });
});

// The one classifier both dial paths call. They classify on opposite sides of the
// diagnostic -- the connect loop's retry predicate reads ssh2's rejection, the
// connection-per-poll cycle-start re-dial reads what the dial sequence threw
// after explainKexNegotiationFailure replaced its message -- so answering for
// both shapes is what keeps the two paths from disagreeing about one rejection.
describe("isUnperformableKexNegotiationFailure", () => {
  const negotiationFailure = new Error(
    "getConnection: Handshake failed: no matching key exchange algorithm",
  );
  const explained = explainKexNegotiationFailure(negotiationFailure, [MISSING]);

  test("recognizes ssh2's own rejection", () => {
    expect(
      isUnperformableKexNegotiationFailure(negotiationFailure, [MISSING]),
    ).toBe(true);
  });

  test("recognizes the diagnostic raised for it, whose message no longer has the fragment", () => {
    expect((explained as Error).message).not.toContain(
      "no matching key exchange algorithm",
    );
    expect(isUnperformableKexNegotiationFailure(explained, [MISSING])).toBe(
      true,
    );
  });

  test("answers no for either shape once every primitive is available", () => {
    // The verdict holds the whole weight: the fragment is written by whoever
    // sends the SSH_MSG_DISCONNECT description, and a disconnect precedes host-key
    // verification. On a host that can perform everything ssh2 offers, a written
    // fragment decides nothing at all.
    expect(isUnperformableKexNegotiationFailure(negotiationFailure, [])).toBe(
      false,
    );
    expect(isUnperformableKexNegotiationFailure(explained, [])).toBe(false);
  });

  test("answers no for an unrelated rejection and for a non-Error", () => {
    expect(
      isUnperformableKexNegotiationFailure(
        new Error("getConnection: Host denied (verification failed)"),
        [MISSING],
      ),
    ).toBe(false);
    expect(isUnperformableKexNegotiationFailure("nope", [MISSING])).toBe(false);
  });
});

// Both messages this module composes are the operator's only instruction for a
// connection that cannot be made to work by retrying, and the display sink caps
// EACH link of a rendered cause chain at DEFAULT_MAX_DISPLAY_LENGTH. A message
// written past that cap loses its tail, which is where the remedy sits -- so the
// cap is asserted against the real sink rather than trusted to a reading.
describe("what the operator actually reads", () => {
  // The TOP link is the one that must survive whole: it holds the remedy. By
  // design, the cause link may not -- it holds the operator's own algorithm
  // list, which is unbounded, and splitting it off is what keeps the remedy out
  // of its way. Asserting over every link would therefore assert something
  // input-dependent rather than the property being held.
  const topLink = (error: unknown): string =>
    sanitizeErrorForDisplay(error).split("\n")[0]!;

  const refusalOver = (unavailable: readonly KexPrimitive[]): unknown => {
    try {
      constrainKexToPlatformCapabilities(
        { algorithms: { kex: ["curve25519-sha256"] } },
        unavailable,
        sink(),
      );
    } catch (error) {
      return error;
    }
    throw new Error("expected the emptied-list refusal to throw");
  };

  const explanationOver = (unavailable: readonly KexPrimitive[]): unknown =>
    explainKexNegotiationFailure(
      new Error("Handshake failed: no matching key exchange algorithm"),
      unavailable,
    );

  test("the emptied-list refusal renders whole, remedy included", () => {
    const thrown = refusalOver([MISSING]);

    expect(thrown).toBeInstanceOf(UsageError);
    expect(topLink(thrown)).not.toContain("[truncated]");
    expect(topLink(thrown)).toContain("or remove the setting");
    expect(topLink(thrown).length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH,
    );
  });

  test("the no-common-key-exchange explanation renders whole, remedy included", () => {
    const explained = explanationOver([MISSING]);

    expect(topLink(explained)).not.toContain("[truncated]");
    expect(topLink(explained)).toContain(
      "or run psilink on a host that provides",
    );
    expect(topLink(explained).length).toBeLessThanOrEqual(
      DEFAULT_MAX_DISPLAY_LENGTH,
    );
  });

  // Driven off KEX_PRIMITIVES rather than the fixture above, because each
  // message interpolates the primitive names TWICE: a second entry added to that
  // list, with a name much longer than X25519, would push the remedy back out of
  // the cap -- the regression these cases exist to catch. Bound to the shipped
  // list, the check grows with it instead of going quietly stale.
  test("both messages still fit the cap for the primitives actually shipped", () => {
    for (const rendered of [
      topLink(refusalOver(KEX_PRIMITIVES)),
      topLink(explanationOver(KEX_PRIMITIVES)),
    ]) {
      expect(rendered).not.toContain("[truncated]");
      expect(rendered.length).toBeLessThanOrEqual(DEFAULT_MAX_DISPLAY_LENGTH);
    }
  });
});
