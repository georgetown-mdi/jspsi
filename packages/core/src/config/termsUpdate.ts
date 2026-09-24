import { z } from "zod";

import { UsageError } from "../errors.js";
import { parseBoundedJson } from "../utils/boundedJson.js";
import {
  bytesEqual,
  enc,
  fromBase64Url,
  hkdfDerive,
  hmacSha256,
  toBase64Url,
} from "../utils/crypto.js";
import { SHARED_SECRET_REGEX } from "./connection.js";
import {
  declaresEmptyPayloadSend,
  declaresPayloadSendColumn,
  DisclosedPayloadColumnsSchema,
  InvitationLinkageTermsSchema,
  MAX_ENCODED_INVITATION_LENGTH,
} from "./invitation.js";
import type { LinkageTerms } from "./linkageTermsSchema.js";

// --- Terms update ------------------------------------------------------------

/**
 * A change to an established partnership's linkage terms, sent by the party
 * that made it to the party that applies it. It holds the sending party's
 * linkage terms and disclosed columns and nothing else: no shared secret, no
 * credential, no connection endpoint, and no expiry. It is authenticated under
 * the shared secret both parties already hold (docs/spec/EXCHANGE_FILE.md,
 * "Terms update").
 */
export interface TermsUpdate {
  /**
   * The sending party's own linkage terms, in the form an invitation states
   * them: the applying party derives its own side with
   * `deriveAcceptedLinkageTerms`, as an acceptance does.
   */
  linkageTerms: LinkageTerms;
  /**
   * The columns the sending party transmits for matched records, in its own
   * namespace, as an invitation's `disclosedPayloadColumns` states them.
   * Omitted where the sending party's configuration declares no metadata.
   */
  disclosedPayloadColumns?: string[];
}

/** The `kind` a terms update's body states. */
const TERMS_UPDATE_KIND = "terms-update";

/**
 * The HKDF info strings a terms update derives from the shared secret, one
 * per use; a family in the domain-separation label space
 * (docs/spec/PROTOCOL.md). Frozen so the label set cannot widen at run time.
 */
export const TERMS_UPDATE_DERIVATIONS = Object.freeze([
  "partnership",
  "mac",
] as const);

type TermsUpdateDerivation = (typeof TERMS_UPDATE_DERIVATIONS)[number];

const TERMS_UPDATE_LABEL_PREFIX = "alcove-terms-update-v2:";

/** Bytes of the partnership identifier, before base64url encoding. */
const PARTNERSHIP_ID_BYTES = 16;

/** Bytes of the MAC: a whole HMAC-SHA-256 tag. */
const MAC_BYTES = 32;

/**
 * Bound on an encoded terms update, checked before any decoding work. A
 * terms update holds what an invitation's terms and disclosed columns hold,
 * less the secret and endpoint, so the invitation's bound covers it.
 */
export const MAX_ENCODED_TERMS_UPDATE_LENGTH = MAX_ENCODED_INVITATION_LENGTH;

const TermsUpdateBodySchema = z
  .strictObject({
    kind: z.literal(TERMS_UPDATE_KIND),
    version: z.literal("1"),
    partnership: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
    linkageTerms: InvitationLinkageTermsSchema,
    disclosedPayloadColumns: DisclosedPayloadColumnsSchema.optional(),
  })
  .refine(
    (body) =>
      !body.linkageTerms.output.shareWithPartner ||
      !declaresEmptyPayloadSend(body.linkageTerms) ||
      (body.disclosedPayloadColumns?.length ?? 0) === 0,
    {
      message:
        "disclosedPayloadColumns names a column while the linkage terms " +
        "declare an empty payload.send",
      path: ["disclosedPayloadColumns"],
    },
  )
  .refine(
    (body) =>
      !declaresPayloadSendColumn(body.linkageTerms) ||
      body.disclosedPayloadColumns === undefined ||
      body.disclosedPayloadColumns.length > 0,
    {
      message:
        "disclosedPayloadColumns is empty while the linkage terms declare a " +
        "payload.send naming a column",
      path: ["disclosedPayloadColumns"],
    },
  );

/**
 * Which check refused a terms update:
 *
 * - `format`: the text is not a well-formed terms update.
 * - `partnership`: it was made under a different shared secret than the one
 *   given -- another partnership, or a secret one party has since replaced.
 * - `authentication`: it names this partnership, but its MAC does not verify,
 *   so it was altered after it was made.
 */
export type TermsUpdateCheck = "format" | "partnership" | "authentication";

/**
 * A terms update refused at decode. {@link check} names which check refused
 * it; the message states the reason in terms a caller may show as they are.
 */
export class TermsUpdateRefusedError extends UsageError {
  /** The check that refused the update. */
  readonly check: TermsUpdateCheck;

  constructor(check: TermsUpdateCheck, message: string) {
    super(message);
    this.name = "TermsUpdateRefusedError";
    this.check = check;
  }
}

async function deriveFromSecret(
  sharedSecret: string,
  derivation: TermsUpdateDerivation,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!SHARED_SECRET_REGEX.test(sharedSecret))
    throw new UsageError(
      "the shared secret is not a base64url-encoded 32-byte value",
    );
  return hkdfDerive(
    fromBase64Url(sharedSecret),
    `${TERMS_UPDATE_LABEL_PREFIX}${derivation}`,
    length,
  );
}

/**
 * The partnership identifier a terms update states: a one-way derivation of
 * the shared secret, so both parties compute it from the key file they hold
 * and it reveals nothing about the secret. It follows the secret, so a
 * rotation gives the partnership a new identifier.
 *
 * @throws {UsageError} if `sharedSecret` is not a valid shared secret.
 */
export async function termsUpdatePartnership(
  sharedSecret: string,
): Promise<string> {
  return toBase64Url(
    await deriveFromSecret(sharedSecret, "partnership", PARTNERSHIP_ID_BYTES),
  );
}

async function termsUpdateMac(
  sharedSecret: string,
  body: Uint8Array<ArrayBuffer>,
): Promise<Uint8Array<ArrayBuffer>> {
  return hmacSha256(
    await deriveFromSecret(sharedSecret, "mac", MAC_BYTES),
    body,
  );
}

/**
 * Encode a {@link TermsUpdate} under `sharedSecret`: the base64url JSON body,
 * a `.`, and the base64url HMAC-SHA-256 of the body bytes under a key derived
 * from the secret. The body is validated against the same schema
 * {@link decodeTermsUpdate} applies, so nothing is encoded that a decoder
 * would refuse.
 *
 * @throws {UsageError} if `sharedSecret` is not a valid shared secret or the
 *   encoded update exceeds {@link MAX_ENCODED_TERMS_UPDATE_LENGTH}.
 * @throws {ZodError} if the update fails the schema.
 */
export async function encodeTermsUpdate(
  update: TermsUpdate,
  sharedSecret: string,
): Promise<string> {
  const body = TermsUpdateBodySchema.parse({
    kind: TERMS_UPDATE_KIND,
    version: "1",
    partnership: await termsUpdatePartnership(sharedSecret),
    linkageTerms: update.linkageTerms,
    ...(update.disclosedPayloadColumns !== undefined
      ? { disclosedPayloadColumns: update.disclosedPayloadColumns }
      : {}),
  });
  const bytes = enc.encode(JSON.stringify(body));
  const encoded = `${toBase64Url(bytes)}.${toBase64Url(
    await termsUpdateMac(sharedSecret, bytes),
  )}`;
  if (encoded.length > MAX_ENCODED_TERMS_UPDATE_LENGTH)
    throw new UsageError(
      "the terms update is longer than the " +
        `${MAX_ENCODED_TERMS_UPDATE_LENGTH} characters a terms update may be`,
    );
  return encoded;
}

function refusedFormat(reason: string): TermsUpdateRefusedError {
  return new TermsUpdateRefusedError(
    "format",
    `this is not an Alcove terms update: ${reason}`,
  );
}

/**
 * The partnership identifier an unauthenticated body states, or `undefined`
 * where it states none that could be read. Used only to choose which refusal
 * names a body whose MAC failed.
 */
function statedPartnership(body: Uint8Array<ArrayBuffer>): string | undefined {
  try {
    const parsed = parseBoundedJson(body);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const stated = (parsed as Record<string, unknown>)["partnership"];
    return typeof stated === "string" ? stated : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decode and verify a terms update against the shared secret this party
 * holds. The MAC is verified over the body bytes before the body is
 * validated or returned; a body whose MAC fails is read only far enough to
 * tell a different partnership from an altered update.
 *
 * `encoded` is taken as given; strip a hard-wrapped paste's whitespace first
 * (`stripInvitationWhitespace`).
 *
 * @throws {TermsUpdateRefusedError} naming the check that refused it.
 * @throws {UsageError} if `sharedSecret` is not a valid shared secret.
 */
export async function decodeTermsUpdate(
  encoded: string,
  sharedSecret: string,
): Promise<TermsUpdate> {
  if (encoded.length > MAX_ENCODED_TERMS_UPDATE_LENGTH)
    throw refusedFormat(
      `it is longer than the ${MAX_ENCODED_TERMS_UPDATE_LENGTH} characters ` +
        "a terms update may be",
    );
  const parts = encoded.split(".");
  if (parts.length !== 2)
    throw refusedFormat("it does not have the form BODY.MAC");
  let body: Uint8Array<ArrayBuffer>;
  let mac: Uint8Array<ArrayBuffer>;
  try {
    body = fromBase64Url(parts[0] as string);
    mac = fromBase64Url(parts[1] as string);
  } catch {
    throw refusedFormat("it is not valid base64url");
  }
  if (mac.length !== MAC_BYTES)
    throw refusedFormat(`its MAC is not ${MAC_BYTES} bytes`);

  const partnership = await termsUpdatePartnership(sharedSecret);
  if (!bytesEqual(mac, await termsUpdateMac(sharedSecret, body))) {
    const stated = statedPartnership(body);
    if (stated !== undefined && stated !== partnership)
      throw new TermsUpdateRefusedError(
        "partnership",
        "this terms update was made for a different partnership: it was " +
          "made under a shared secret other than the one in your key file",
      );
    throw new TermsUpdateRefusedError(
      "authentication",
      "this terms update's MAC does not verify: its content was changed " +
        "after it was made",
    );
  }

  let parsed: z.infer<typeof TermsUpdateBodySchema>;
  try {
    parsed = TermsUpdateBodySchema.parse(parseBoundedJson(body));
  } catch {
    throw refusedFormat("its content does not match the terms update format");
  }
  if (parsed.partnership !== partnership)
    throw new TermsUpdateRefusedError(
      "partnership",
      "this terms update names a different partnership than the shared " +
        "secret it was authenticated under",
    );
  return {
    linkageTerms: parsed.linkageTerms,
    ...(parsed.disclosedPayloadColumns !== undefined
      ? { disclosedPayloadColumns: parsed.disclosedPayloadColumns }
      : {}),
  };
}
