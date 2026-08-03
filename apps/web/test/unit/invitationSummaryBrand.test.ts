import { describe, expect, test } from "vitest";

import { sanitizeForDisplay } from "@psilink/core";

import { summarizeInvitation } from "@psi/invitationSummary";

import type { Displayable, LinkageTerms } from "@psilink/core";
import type {
  InvitationLegalAgreementSummary,
  InvitationSummary,
} from "@psi/invitationSummary";

// Inviter-crafted characters JSX escaping does not neutralize, built from their
// code points so this source carries no raw control or bidi byte: an ESC that
// drives ANSI, a right-to-left override, and a BEL.
const ESC = String.fromCodePoint(0x1b);
const RLO = String.fromCodePoint(0x202e);
const BEL = String.fromCodePoint(0x07);

// Every partner-controlled string in the terms carries one, so a summary built
// from these reaches each branded field with something to escape.
const hostileTerms: LinkageTerms = {
  version: "1.0.0",
  identity: `Acme${ESC}[31m${RLO}org`,
  date: "2026-01-15",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [
    { name: `last${BEL}name`, type: "last_name" },
    {
      name: "first_name",
      type: "first_name",
      constraints: { allowedCharacters: `A-Z${RLO}` },
    },
    { name: `unde${BEL}clared`, type: "ssn" },
  ],
  linkageKeys: [
    {
      name: `key${BEL}one`,
      elements: [
        {
          field: "first_name",
          transform: [
            { function: "substring", params: { start: 1, length: 3 } },
          ],
        },
        {
          field: `last${BEL}name`,
          transform: [
            {
              function: `mystery${BEL}fn`,
              params: { [`pat${RLO}tern`]: `${ESC}[31m` },
            },
          ],
        },
      ],
      swap: ["first_name", `last${BEL}name`],
    },
  ],
  payload: {
    send: [{ name: `risk${BEL}score` }],
    receive: [{ name: `outcome${RLO}` }],
  },
  legalAgreement: {
    reference: `MOU${BEL}-0042`,
    purpose: `Audit${RLO} and evaluation`,
    expirationDate: "2027-12-31",
  },
};

const hostileSource = {
  linkageTerms: hostileTerms,
  expires: "2026-02-01T00:00:00.000Z",
  connectionEndpoint: { channel: "filedrop" as const, path: `drop${BEL}box` },
};

/**
 * Every value in the summary whose field is declared {@link Displayable} -- the
 * enumeration a partner-controlled value can reach. It fails to COMPILE if any
 * of those fields is widened back to a plain `string`, and its runtime assertion
 * below is the other half: each collected value has actually been escaped.
 *
 * A linkage key's deliberately raw `id` is absent because it is never rendered,
 * as is every field only fixed first-party copy reaches.
 */
function brandedDisplayValues(summary: InvitationSummary): Array<Displayable> {
  const values: Array<Displayable | undefined> = [
    summary.invitingParty,
    summary.expires,
    summary.connectionPath,
    ...summary.matchedFields,
    ...(summary.legalAgreement === undefined
      ? []
      : [
          summary.legalAgreement.reference,
          summary.legalAgreement.purpose,
          summary.legalAgreement.expirationDate,
        ]),
    ...(summary.payload?.send ?? []),
    ...(summary.payload?.receive ?? []),
    ...summary.linkageFields.map((field) => field.allowedCharacters),
    ...summary.linkageKeys.flatMap((key) => [
      key.name,
      ...key.headerFields,
      ...(key.swap ?? []),
      ...(key.swapTransformDonor ?? []),
      ...key.elements.flatMap((element) => [
        element.fieldLabel,
        ...element.transforms.flatMap((transform) => [
          transform.function,
          transform.effect,
          ...transform.params,
        ]),
      ]),
    ]),
  ];
  return values.filter((value) => value !== undefined);
}

describe("the display-struct brand", () => {
  test("rejects an un-sanitized string in a display struct", () => {
    const raw: string = hostileTerms.identity;
    const agreement: InvitationLegalAgreementSummary = {
      // @ts-expect-error -- a field filled without the sanitize call
      reference: raw,
      purpose: sanitizeForDisplay(raw),
      expirationDate: sanitizeForDisplay("2027-12-31"),
    };
    expect(agreement.reference).toBe(raw);
  });

  test("rejects an un-sanitized string in each display struct that carries partner text", () => {
    const raw: string = hostileTerms.identity;
    // @ts-expect-error -- the inviter's self-asserted identity
    const invitingParty: InvitationSummary["invitingParty"] = raw;
    // @ts-expect-error -- a linkage key's partner-authored name
    const keyName: InvitationSummary["linkageKeys"][number]["name"] = raw;
    // @ts-expect-error -- a transform's partner-declared function name
    const transformFunction: InvitationSummary["linkageKeys"][number]["elements"][number]["transforms"][number]["function"] =
      raw;
    // @ts-expect-error -- a partner-authored allowed-character class
    const allowedCharacters: InvitationSummary["linkageFields"][number]["allowedCharacters"] =
      raw;
    // @ts-expect-error -- a declared payload column name
    const payloadColumn: NonNullable<
      InvitationSummary["payload"]
    >["send"][number] = raw;
    expect([
      invitingParty,
      keyName,
      transformFunction,
      allowedCharacters,
      payloadColumn,
    ]).toEqual([raw, raw, raw, raw, raw]);
  });

  test("accepts a sanitizeForDisplay return value", () => {
    const sanitized = sanitizeForDisplay(hostileTerms.identity);
    const invitingParty: InvitationSummary["invitingParty"] = sanitized;
    const agreement: InvitationLegalAgreementSummary = {
      reference: sanitized,
      purpose: sanitized,
      expirationDate: sanitized,
    };
    expect(invitingParty).toBe(agreement.reference);
  });

  test("brands every summary field a partner-controlled value reaches, and each is escaped", () => {
    const values = brandedDisplayValues(summarizeInvitation(hostileSource));
    // The enumeration reaches every nested struct, so an empty or collapsed
    // fixture cannot let the assertion below pass vacuously.
    expect(values.length).toBeGreaterThan(20);
    for (const value of values) expect(value).toMatch(/^[\x20-\x7e]*$/);
  });

  test("stays a plain string at the renderer, needing no cast or unwrapping", () => {
    const summary = summarizeInvitation(hostileSource);
    // The shapes a renderer uses: JSX text children, joins, interpolation, and
    // handing a field to something typed `string`.
    const children: Array<string> = [summary.invitingParty];
    const joined: string = summary.matchedFields.join(", ");
    const heading = `Proposed by ${summary.invitingParty}`;
    const measured: number = summary.invitingParty.length;
    expect(children[0]).toBe(summary.invitingParty);
    expect(joined).toContain("last name");
    expect(heading.startsWith("Proposed by Acme")).toBe(true);
    expect(measured).toBe(summary.invitingParty.length);
  });
});
