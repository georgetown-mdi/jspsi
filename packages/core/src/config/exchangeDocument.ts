import YAML from "yaml";

import { snakeizeKeys } from "../utils/camelizeKeys.js";
import { annotateConnectionGuidance } from "./connectionGuidance.js";
import type { ExchangeSpec } from "./exchangeSpec.js";

/**
 * Serialize an {@link ExchangeSpec} into the snake_case YAML document psilink
 * writes as an operator's `psilink.yaml`, guidance comments included. The
 * caller's spec is not mutated.
 *
 * The shared secret and its expiration live only in the key file: they are
 * stripped from the top-level `authentication` block here even if the caller
 * left them populated, so the secret cannot be duplicated onto disk. The strip
 * is part of the serialization rather than of any one writer, so a second
 * application rendering this document does not have to repeat it.
 *
 * The `connection` block is annotated with the operator guidance
 * {@link annotateConnectionGuidance} attaches -- the channel alternatives, where
 * each channel's block is documented, and the connection tuning as a commented
 * example -- since a config written by `invite`, `accept`, or a saved zero-setup
 * exchange is one the operator edits by hand from here on.
 */
export function serializeExchangeDocument(spec: ExchangeSpec): string {
  const sanitized = structuredClone(spec);
  const auth = sanitized.authentication;
  if (auth) {
    delete auth.sharedSecret;
    delete auth.expires;
    // Drop the container if those were its only keys, so the config holds no
    // noisy empty `authentication: {}` block. Operator-policy fields (e.g.
    // token_max_age_days) keep it non-empty when present.
    if (Object.keys(auth).length === 0) delete sanitized.authentication;
  }
  const doc = new YAML.Document(snakeizeKeys(sanitized));
  annotateConnectionGuidance(doc);
  return doc.toString();
}
