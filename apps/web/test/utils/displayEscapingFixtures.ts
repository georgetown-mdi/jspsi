import type { InvitationToken, LinkageTerms } from "@psilink/core";

/**
 * Inviter-crafted characters JSX escaping does not neutralize, built from their
 * code points so this source carries no raw control or bidi byte: an ESC that
 * drives ANSI, a right-to-left override, and a BEL.
 */
export const ESC = String.fromCodePoint(0x1b);
export const RLO = String.fromCodePoint(0x202e);
export const BEL = String.fromCodePoint(0x07);

/**
 * Printable ASCII (U+0020-U+007E), the character set `sanitizeForDisplay` leaves
 * intact and escapes everything else into. Shared by the unit walk over the
 * summary and the render-boundary walk over the mounted DOM so the two halves
 * cannot drift apart on what "escaped" means.
 */
export const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * Linkage terms in which EVERY partner-controlled string carries one of the
 * hostile code points above, so a summary or a rendered screen built from them
 * reaches each field with something to escape -- and a field that reaches either
 * without escaping is caught wherever it lands, with nothing to enumerate.
 *
 * Deliberately beyond what the schema admits: `version`, `date`, and
 * `expirationDate` are format-constrained (semver, `z.iso.date`), so a decoded
 * token cannot carry a hostile byte in them today. They carry one here because
 * the display boundary's contract is uniform and does not depend on that
 * validation staying in place -- the same reason `summarizeInvitation` routes
 * the dates through the sanitizer.
 */
export const hostileTerms: LinkageTerms = {
  version: `1.0.0${BEL}`,
  identity: `Acme${ESC}[31m${RLO}org`,
  date: `2026-01-15${BEL}`,
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [
    { name: `last${BEL}name`, type: "last_name" },
    {
      name: "first_name",
      type: "first_name",
      constraints: {
        allowedCharacters: `A-Z${RLO}`,
        exclude: [`exclu${BEL}ded`],
      },
    },
    { name: `unde${BEL}clared`, type: "ssn" },
  ],
  linkageKeys: [
    {
      name: `key${BEL}one`,
      elements: [
        {
          field: "first_name",
          name: `elem${RLO}one`,
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
      swap: [`elem${RLO}one`, `last${BEL}name`],
    },
  ],
  payload: {
    send: [{ name: `risk${BEL}score`, description: `sco${RLO}re` }],
    receive: [{ name: `outcome${RLO}` }],
  },
  legalAgreement: {
    reference: `MOU${BEL}-0042`,
    purpose: `Audit${RLO} and evaluation`,
    expirationDate: `2027-12-31${BEL}`,
  },
};

/**
 * The decoded-token subset `summarizeInvitation` takes, carrying
 * {@link hostileTerms} plus the two partner-controlled values the terms
 * themselves do not hold: the invitation's expiry instant and a file-drop
 * endpoint's advisory path.
 */
export const hostileSource: Pick<
  InvitationToken,
  "linkageTerms" | "expires" | "disclosedPayloadColumns" | "connectionEndpoint"
> = {
  linkageTerms: hostileTerms,
  expires: `2026-02-01T00:00:00.000Z${BEL}`,
  connectionEndpoint: { channel: "filedrop", path: `drop${BEL}box` },
};
