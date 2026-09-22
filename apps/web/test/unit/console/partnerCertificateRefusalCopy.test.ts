import { describe, expect, test } from "vitest";

import {
  COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
  PARTNER_CERTIFICATE_REFUSAL_MESSAGES,
  sanitizeForDisplay,
} from "@psilink/core";

import { RelayedSelfExplainingError } from "@psi/jobClient/serverJobExchangeDriver";
import { consolePartnerCertificateRefusal } from "@console/partnerCertificateRefusal";
import { failureFor } from "@exchange/useInviterExchange";

// What the console tells an operator about each of core's five terms-time pin
// refusals. Core's own messages name configuration keys -- the command line's
// remedy, and not one a console operator can take, since the console writes the
// configuration each run is driven by itself -- so the seat that renders a
// relayed refusal shows console copy naming the receipts card's own controls
// instead.

const REFUSALS = Object.entries(PARTNER_CERTIFICATE_REFUSAL_MESSAGES);

/** The configuration keys core's messages prescribe an edit of, none of which
 * names anything a console operator holds. */
const CONFIGURATION_KEYS = [
  "signing.partner_fingerprint",
  "signing.mode",
] as const;

describe("the register covers every refusal core raises", () => {
  test("all five have console copy", () => {
    expect(REFUSALS).toHaveLength(5);
    for (const [kind, message] of REFUSALS)
      expect(
        consolePartnerCertificateRefusal(message),
        `no console copy for ${kind}`,
      ).toBeDefined();
  });

  test("each refusal takes its own copy", () => {
    const copy = REFUSALS.map(([, message]) =>
      consolePartnerCertificateRefusal(message),
    );
    expect(new Set(copy).size).toBe(REFUSALS.length);
  });

  test("a failure that is none of them takes no copy", () => {
    expect(
      consolePartnerCertificateRefusal(
        "the partner's signed receipt does not verify",
      ),
    ).toBeUndefined();
  });
});

describe("the refusal is found in the text the relay delivers", () => {
  // The register matches the whole literal core raised against failure text
  // every boundary between here and core has escaped. Both halves of that hold
  // only while each message is printable ASCII (escaping it changes nothing)
  // and fits the budget a relayed cause link is escaped at, so both are checked
  // rather than assumed: a message that grew past either would leave the
  // operator reading a remedy in configuration keys.
  test("escaping a message leaves it unchanged", () => {
    for (const [kind, message] of REFUSALS)
      expect(
        sanitizeForDisplay(message, { maxLength: Infinity }),
        `${kind} does not survive the display escape`,
      ).toBe(message);
  });

  test("each message fits one relayed cause link", () => {
    for (const [kind, message] of REFUSALS)
      expect(message.length, `${kind} is too long for one link`).toBeLessThan(
        COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH,
      );
  });

  test("a refusal wrapped in a longer failure is still found", () => {
    // The relayed text is a whole rendered cause chain, so the refusal arrives
    // beside whatever wrapped it.
    const wrapped = `the exchange failed\ncaused by: ${PARTNER_CERTIFICATE_REFUSAL_MESSAGES.divergent}`;
    expect(consolePartnerCertificateRefusal(wrapped)).toBe(
      consolePartnerCertificateRefusal(
        PARTNER_CERTIFICATE_REFUSAL_MESSAGES.divergent,
      ),
    );
  });
});

describe("the console's copy states the cause and a step the operator holds", () => {
  test("it names no configuration key", () => {
    for (const [kind, message] of REFUSALS) {
      const copy = consolePartnerCertificateRefusal(message)!;
      for (const key of CONFIGURATION_KEYS)
        expect(copy, `${kind} names ${key}`).not.toContain(key);
    }
  });

  test("it states that none of the operator's data was sent", () => {
    // Every one of the five fires at the terms exchange, before a linkage key
    // or a payload row moves (packages/core/src/exchange.ts, the terms-time pin
    // resolution).
    for (const [kind, message] of REFUSALS)
      expect(
        consolePartnerCertificateRefusal(message),
        `${kind} does not say the data stayed here`,
      ).toMatch(/sent none of your data/);
  });

  test("each copy names the control or the request that answers it", () => {
    // The two remedies a console operator holds: a value from the partner,
    // asked for out of band, and the receipts card's own controls.
    const byKind = Object.fromEntries(
      REFUSALS.map(([kind, message]) => [
        kind,
        consolePartnerCertificateRefusal(message)!,
      ]),
    );
    expect(byKind.unreadable).toMatch(/psilink fingerprint/);
    expect(byKind.unreadable).toMatch(/'No receipt'/);
    expect(byKind.absent).toMatch(/'No receipt'/);
    expect(byKind.unverified).toMatch(/psilink fingerprint/);
    expect(byKind.unauthorizedIdentity).toMatch(/agree terms under/);
    expect(byKind.divergent).toMatch(/your partner's fingerprint/);
    expect(byKind.divergent).toMatch(/channel you trust/);
  });
});

describe("the seat shows the console's copy", () => {
  test("a relayed pin refusal displaces core's configuration-key remedy", () => {
    const failure = failureFor(
      "security",
      new RelayedSelfExplainingError(
        PARTNER_CERTIFICATE_REFUSAL_MESSAGES.divergent,
      ),
    );
    expect(failure.title).toBe("The exchange stopped on a trust check");
    expect(failure.message).toBe(
      consolePartnerCertificateRefusal(
        PARTNER_CERTIFICATE_REFUSAL_MESSAGES.divergent,
      ),
    );
    expect(failure.message).not.toContain("signing.partner_fingerprint");
  });

  test("another self-explaining refusal keeps its own next step", () => {
    // The register answers for the five refusals whose remedy is an edit of a
    // file the console owns. Every other tagged failure states a step that
    // holds wherever it is read, so it is shown as it arrived.
    const message =
      "this invitation expired, so ask your partner for a new one";
    expect(
      failureFor("security", new RelayedSelfExplainingError(message)).message,
    ).toBe(message);
  });
});
