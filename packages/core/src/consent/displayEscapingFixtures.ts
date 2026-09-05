// Shared fixtures for the display-escaping halves that run over the invitation
// consent summary: the object walk in this package, and the web app's
// render-boundary walk over the mounted consent screen. One copy, behind the
// `./testing` subpath, so the two cannot drift apart on what a hostile
// invitation looks like.

import type { InvitationToken } from "../config/invitation.js";
import type { LinkageTerms } from "../config/linkageTerms.js";

/**
 * @internal
 *
 * Inviter-crafted characters neither a terminal nor JSX escaping neutralizes,
 * built from their code points so this source holds no raw control or bidi
 * byte: an ESC that drives ANSI, a right-to-left override, and a BEL.
 */
export const ESC = String.fromCodePoint(0x1b);
export const RLO = String.fromCodePoint(0x202e);
export const BEL = String.fromCodePoint(0x07);

/**
 * @internal
 *
 * Printable ASCII (U+0020-U+007E), the character set `sanitizeForDisplay` leaves
 * intact and escapes everything else into. Shared by the unit walk over the
 * summary and the render-boundary walk over the mounted DOM so the two halves
 * cannot drift apart on what "escaped" means.
 */
export const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * @internal
 *
 * Linkage terms in which EVERY partner-controlled string holds one of the
 * hostile code points above, so a summary or a rendered screen built from them
 * reaches each field with something to escape -- and a field that reaches
 * either without escaping is caught wherever it lands, with nothing to
 * enumerate.
 *
 * The exceptions are the values a summary position is KEYED ON rather than filled
 * from: the `replace_regex` function name and its `pattern` / `replacement`
 * parameter names, and the `generateFuzzyComparisons` enum. Each must be exactly
 * what the standardization layer recognizes for the position it unlocks (the
 * glossary description, the runtime-coercion note, the fuzzy-comparison label)
 * to exist at all, and each of
 * those positions holds first-party copy keyed by that recognized value. Reaching
 * them is what the walk needs; the hostile bytes sit in the partner text beside
 * them (the pattern's value, the field and key names).
 *
 * By design, this goes beyond what the schema admits, on two counts.
 * `version`, `date`, `expirationDate`, and the two rule-set `version` strings
 * are format-constrained (semver, `z.iso.date`). `identity` and the constraint
 * `exclude` value are free text held to the control-character rule
 * (`TEXT_CONTROL_CHAR_PATTERN`, config/linkageTerms.ts), which refuses the ESC
 * and BEL they hold here; the bidi override in `purpose` and in the payload
 * `description` is not a control character, so those two stay within what a
 * decoded token can hold -- a real parse of this fixture's own values accepts
 * both -- and it is exactly what the display-escaping assertions over those
 * two fields exercise. They hold one here because the display boundary's
 * contract is uniform and does not depend on that validation staying in place
 * -- the same reason `summarizeInvitation` routes the dates through the
 * sanitizer.
 */
/**
 * @internal
 *
 * {@link hostileTerms}' own identity, exported so a display-boundary test can
 * name the string without reading it back through the terms' optional
 * `identity`, which types as possibly absent.
 */
export const HOSTILE_IDENTITY = `Acme${ESC}[31m${RLO}org`;

export const hostileTerms: LinkageTerms = {
  version: `1.0.0${BEL}`,
  identity: HOSTILE_IDENTITY,
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
            // A recognized function declaring `replacement` as null, so the
            // step holds both a glossary description and the runtime-coercion
            // note describeTransformCoercions derives from that null.
            {
              function: "replace_regex",
              params: { pattern: `[${BEL}]`, replacement: null },
            },
          ],
        },
        {
          field: `unde${BEL}clared`,
          generateFuzzyComparisons: "transpositions",
        },
      ],
      swap: [`elem${RLO}one`, `last${BEL}name`],
    },
  ],
  linkageRuleSet: {
    fieldSet: { name: `base${BEL}line`, version: `1.0.0${RLO}` },
    keySet: { name: `key${RLO}set`, version: `2.0.0${BEL}` },
  },
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
 * @internal
 *
 * {@link hostileTerms} with a swap whose transforms sit on ONE side only. The
 * swap in those terms holds a transform on both of its elements, which
 * summarizes as the bidirectional interchange; a single transform-carrier
 * summarizes as the one-directional donor instead -- the other arm of the same
 * branch, so one terms document cannot reach both and a second one is what
 * reaches the donor.
 */
const swapDonorTerms: LinkageTerms = {
  ...hostileTerms,
  linkageKeys: [
    {
      name: `key${BEL}two`,
      elements: [
        {
          field: "first_name",
          name: `donor${RLO}elem`,
          transform: [
            { function: "substring", params: { start: 2, length: 4 } },
          ],
        },
        { field: `last${BEL}name` },
      ],
      swap: [`donor${RLO}elem`, `last${BEL}name`],
    },
  ],
};

/**
 * @internal
 *
 * The decoded-token subset `summarizeInvitation` takes: linkage terms plus the
 * partner-controlled values the terms themselves do not hold -- the invitation's
 * expiry instant and a file-drop endpoint's advisory path.
 */
type HostileSource = Pick<
  InvitationToken,
  "linkageTerms" | "expires" | "disclosedPayloadColumns" | "connectionEndpoint"
>;

/**
 * @internal
 *
 * {@link hostileTerms} as the decoded-token subset.
 */
export const hostileSource: HostileSource = {
  linkageTerms: hostileTerms,
  expires: `2026-02-01T00:00:00.000Z${BEL}`,
  connectionEndpoint: { channel: "filedrop", path: `drop${BEL}box` },
};

/**
 * @internal
 *
 * {@link swapDonorTerms} as the decoded-token subset.
 */
const swapDonorSource: HostileSource = {
  ...hostileSource,
  linkageTerms: swapDonorTerms,
};

/**
 * @internal
 *
 * Every hostile variant the display-escaping halves run over, named for the
 * failure message. Both walk this list -- the unit walk summarizes each and the
 * browser walk mounts each -- so a variant added to reach a summary position one
 * terms document cannot hold alongside the others is escaped-checked at both
 * altitudes rather than only where it was added.
 */
export const hostileVariants: ReadonlyArray<{
  name: string;
  source: HostileSource;
}> = [
  { name: "transforms on both swapped elements", source: hostileSource },
  { name: "a transform on one swapped element", source: swapDonorSource },
];
