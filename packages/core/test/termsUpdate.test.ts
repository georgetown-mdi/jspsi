import { describe, expect, test } from "vitest";

import { generateSharedSecret } from "../src/config/connection";
import {
  MAX_ENCODED_TERMS_UPDATE_LENGTH,
  TermsUpdateRefusedError,
  decodeTermsUpdate,
  encodeTermsUpdate,
  termsUpdatePartnership,
} from "../src/config/termsUpdate";
import { getDefaultLinkageTerms } from "../src/defaults/builtInLinkageTerms";
import { fromBase64Url, toBase64Url } from "../src/utils/crypto";

const terms = getDefaultLinkageTerms("Agency A");

async function refusal(
  encoded: string,
  secret: string,
): Promise<TermsUpdateRefusedError> {
  try {
    await decodeTermsUpdate(encoded, secret);
  } catch (err) {
    expect(err).toBeInstanceOf(TermsUpdateRefusedError);
    return err as TermsUpdateRefusedError;
  }
  throw new Error("the terms update was not refused");
}

function body(encoded: string): Record<string, unknown> {
  const [bodyPart] = encoded.split(".");
  return JSON.parse(
    new TextDecoder().decode(fromBase64Url(bodyPart as string)),
  ) as Record<string, unknown>;
}

function reencode(content: unknown, mac: string): string {
  return `${toBase64Url(
    new TextEncoder().encode(JSON.stringify(content)),
  )}.${mac}`;
}

describe("terms update", () => {
  test("round-trips the terms and disclosed columns under the secret it was made with", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate(
      { linkageTerms: terms, disclosedPayloadColumns: ["program", "county"] },
      secret,
    );
    const decoded = await decodeTermsUpdate(encoded, secret);
    expect(decoded.linkageTerms).toEqual(terms);
    expect(decoded.disclosedPayloadColumns).toEqual(["program", "county"]);
  });

  test("holds no shared secret, credential, or connection endpoint", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    const content = body(encoded);
    expect(Object.keys(content).sort()).toEqual([
      "kind",
      "linkageTerms",
      "partnership",
      "version",
    ]);
    expect(encoded).not.toContain(secret);
    expect(JSON.stringify(content)).not.toContain(secret);
    expect(content["partnership"]).toBe(await termsUpdatePartnership(secret));
  });

  test("the partnership identifier differs between secrets and is stable for one", async () => {
    const secret = generateSharedSecret();
    expect(await termsUpdatePartnership(secret)).toBe(
      await termsUpdatePartnership(secret),
    );
    expect(await termsUpdatePartnership(secret)).not.toBe(
      await termsUpdatePartnership(generateSharedSecret()),
    );
  });

  test("an update made under another secret is refused by the partnership check", async () => {
    const encoded = await encodeTermsUpdate(
      { linkageTerms: terms },
      generateSharedSecret(),
    );
    const err = await refusal(encoded, generateSharedSecret());
    expect(err.check).toBe("partnership");
  });

  test("an altered body is refused by the MAC check", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate(
      { linkageTerms: terms, disclosedPayloadColumns: ["program"] },
      secret,
    );
    const content = body(encoded);
    content["disclosedPayloadColumns"] = ["program", "ssn"];
    const err = await refusal(
      reencode(content, encoded.split(".")[1] as string),
      secret,
    );
    expect(err.check).toBe("authentication");
  });

  test("an altered MAC is refused by the MAC check", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    const [bodyPart, macPart] = encoded.split(".") as [string, string];
    const mac = fromBase64Url(macPart);
    mac[0] = (mac[0] as number) ^ 1;
    const err = await refusal(`${bodyPart}.${toBase64Url(mac)}`, secret);
    expect(err.check).toBe("authentication");
  });

  test("a body naming this partnership under a forged MAC is refused by the MAC check", async () => {
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    const content = body(encoded);
    content["linkageTerms"] = { ...terms, algorithm: "psi-c" };
    const err = await refusal(
      reencode(content, toBase64Url(new Uint8Array(32))),
      secret,
    );
    expect(err.check).toBe("authentication");
  });

  test.each([
    ["no separator", "abcdef"],
    ["two separators", "a.b.c"],
    ["a non-base64url body", "a*b.AAAA"],
    ["a short MAC", `${toBase64Url(new TextEncoder().encode("{}"))}.AAAA`],
    ["an oversized string", "A".repeat(MAX_ENCODED_TERMS_UPDATE_LENGTH + 1)],
  ])("%s is refused by the format check", async (_label, encoded) => {
    const err = await refusal(encoded, generateSharedSecret());
    expect(err.check).toBe("format");
  });

  test("an authenticated body with a field outside the format is refused by the format check", async () => {
    // A body only the secret's holder could have authenticated, holding a
    // field a terms update may not: the schema refuses it after the MAC check.
    const secret = generateSharedSecret();
    const encoded = await encodeTermsUpdate({ linkageTerms: terms }, secret);
    const content = { ...body(encoded), sharedSecret: secret };
    const bytes = new TextEncoder().encode(JSON.stringify(content));
    const { hkdfDerive, hmacSha256 } = await import("../src/utils/crypto");
    const macKey = await hkdfDerive(
      fromBase64Url(secret),
      "psilink-terms-update-v1:mac",
      32,
    );
    const forged = `${toBase64Url(bytes)}.${toBase64Url(
      await hmacSha256(macKey, bytes),
    )}`;
    const err = await refusal(forged, secret);
    expect(err.check).toBe("format");
  });
});
