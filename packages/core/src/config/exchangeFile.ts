import { stringify as stringifyYaml } from "yaml";

import { ExchangeSpecSchema } from "./exchangeSpec.js";
import type { ExchangeSpec } from "./exchangeSpec.js";
import type { ConnectionConfig, FileSyncOptions } from "./connection.js";
import type { LinkageTerms } from "./linkageTerms.js";
import type { Metadata } from "./metadata.js";
import type { Standardization } from "./standardization.js";
import { snakeizeKeys } from "../utils/camelizeKeys.js";
import { PLACEHOLDER_SSH_USERNAME } from "./endpointProducer.js";

// --- Locator-only connection description -------------------------------------

/**
 * The SFTP locator a web-composed exchange config carries: WHERE the rendezvous
 * is, never HOW to authenticate to it. Carries only the public locator fields --
 * host, optional port, a single shared `path` OR the split
 * `inboundPath`/`outboundPath` pair, and optional tuning {@link FileSyncOptions}.
 *
 * By construction there is NO credential field on this type: no `username`,
 * `password`, `privateKey`, `privateKeyPassphrase`, `hostKeyFingerprint`, or
 * `keyboardInteractive`. A credential is therefore unrepresentable in a
 * mint-layer input, so it cannot reach the minted file even by mistake -- the
 * type is the enforcement, not a runtime strip. The minted config seeds the one
 * SSH identity field (`username`) with an obvious `REPLACE_WITH_...` placeholder
 * for the operator to fill in (see {@link mintExchangeFile}).
 */
export interface SftpExchangeLocator {
  channel: "sftp";
  /** Non-empty hostname of the SFTP server. */
  host: string;
  /** Reachable port; the exchange-spec schema validates the range. */
  port?: number;
  /** Remote working directory (shared mode). Mutually exclusive with the split
   * `inboundPath`/`outboundPath` pair. */
  path?: string;
  /** Inbound (peer-written) remote directory for a split-directory exchange;
   * set together with {@link outboundPath}, mutually exclusive with {@link path}. */
  inboundPath?: string;
  /** Outbound (self-written) remote directory; the companion to
   * {@link inboundPath}. */
  outboundPath?: string;
  /** Optional tuning/toggle options (poll interval, retain mode, ...). */
  options?: FileSyncOptions;
}

/**
 * The file-drop locator a web-composed exchange config carries: the shared
 * directory (or the split inbound/outbound pair) both parties rendezvous in. A
 * file-drop exchange has no host or credentials at all, so this type carries only
 * the directory locator and optional {@link FileSyncOptions} -- a credential is
 * unrepresentable here too (see {@link SftpExchangeLocator}).
 */
export interface FiledropExchangeLocator {
  channel: "filedrop";
  /** Shared directory (shared mode). Mutually exclusive with the split
   * `inboundPath`/`outboundPath` pair. */
  path?: string;
  /** Inbound (peer-written) directory for a split-directory exchange; set
   * together with {@link outboundPath}, mutually exclusive with {@link path}. */
  inboundPath?: string;
  /** Outbound (self-written) directory; the companion to {@link inboundPath}. */
  outboundPath?: string;
  /** Optional tuning/toggle options. */
  options?: FileSyncOptions;
}

/**
 * A credential-free connection description for a web-composed exchange,
 * discriminated by `channel`. Carries ONLY locator fields -- by construction no
 * credential (username/password/private key/fingerprint) is representable, so the
 * minted file cannot leak one even if a caller tried. Deliberately covers only
 * the file-sync channels the browser mints a downloadable config for (`sftp`,
 * `filedrop`); a webrtc exchange is coordinated live, not from a minted file.
 */
export type ExchangeFileConnection =
  | SftpExchangeLocator
  | FiledropExchangeLocator;

// --- Mint --------------------------------------------------------------------

/**
 * Everything a web-composed exchange needs to become a CLI-ready config, minus
 * the secret (which rides only the invitation code, never the file). The
 * connection is a credential-free {@link ExchangeFileConnection}; the linkage
 * terms are mandatory; metadata, standardization, and the payload-column
 * commitments are optional.
 */
export interface ExchangeFileInput {
  connection: ExchangeFileConnection;
  linkageTerms: LinkageTerms;
  metadata?: Metadata;
  standardization?: Standardization;
  /**
   * This party's SEND-side disclosure commitment (its own column namespace) --
   * the top-level `disclosed_payload_columns` a later recurring `psilink
   * exchange` verifies its metadata still discloses. Optional; omit to reconcile
   * lazily.
   */
  disclosedPayloadColumns?: string[];
  /**
   * This party's RECEIVE-side lock-in (the partner's column namespace) -- the
   * top-level `expected_payload_columns` a later `psilink exchange` enforces it
   * receives. Optional; omit to reconcile lazily.
   */
  expectedPayloadColumns?: string[];
}

/**
 * Assemble a browser-composed exchange into the CLI's exact config schema and
 * serialize it to the snake_case YAML the CLI loads verbatim.
 *
 * The artifact IS the CLI config: it validates through {@link ExchangeSpecSchema}
 * (the camelCase side) before serializing and fails loudly on any mismatch, then
 * is written with the same {@link snakeizeKeys} + yaml `stringify` discipline the
 * CLI's `saveConfig` uses, so a downloaded file parses through the CLI's config
 * load path without edits.
 *
 * The secret never enters the file. There is NO `authentication` block: the CLI
 * injects the shared secret from `.psilink.key` at runtime and its `saveConfig`
 * strips any secret material regardless -- this mint mirrors that invariant by
 * never assembling the block at all. The shared secret rides ONLY the invitation
 * code. For an SFTP locator, the one SSH identity field the operator must supply
 * (`username`) is seeded with the {@link PLACEHOLDER_SSH_USERNAME} placeholder,
 * so a downloaded config fails loudly (rather than connecting anonymously) if run
 * before the operator fills it in.
 *
 * Browser-safe: no Node imports (fs/path), so the module is consumable from
 * `apps/web`.
 *
 * @throws {ZodError} if the assembled spec fails {@link ExchangeSpecSchema}
 *   validation (an invalid locator, an out-of-range port, a malformed split
 *   pair, ...).
 */
export function mintExchangeFile(input: ExchangeFileInput): string {
  const connection = connectionFromLocator(input.connection);

  // Assemble the spec on the camelCase side, then validate it as the schema's
  // own parse would -- the input is already camelCase (built in TS), so the spec
  // is fed straight to ExchangeSpecSchema without a camelize pre-pass. Optional
  // blocks are attached only when present so an absent field is an omitted key,
  // not an explicit `undefined` the snakeize/serialize step would render.
  const assembled: ExchangeSpec = {
    connection,
    linkageTerms: input.linkageTerms,
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.standardization !== undefined
      ? { standardization: input.standardization }
      : {}),
    ...(input.disclosedPayloadColumns !== undefined
      ? { disclosedPayloadColumns: input.disclosedPayloadColumns }
      : {}),
    ...(input.expectedPayloadColumns !== undefined
      ? { expectedPayloadColumns: input.expectedPayloadColumns }
      : {}),
  };

  // Validate through the schema, and serialize the PARSE RESULT (not `assembled`)
  // so only the schema's own fields reach the YAML -- the same "serialize what the
  // schema returns" discipline encodeInvitation uses. A validation failure throws
  // a ZodError here, on the minting side, rather than surfacing when the CLI later
  // loads a malformed file.
  const validated = ExchangeSpecSchema.parse(assembled);
  return stringifyYaml(snakeizeKeys(validated));
}

/**
 * Expand a credential-free {@link ExchangeFileConnection} into the CLI's
 * {@link ConnectionConfig} shape. The single-vs-split directory form is carried
 * through verbatim; the schema (applied by {@link mintExchangeFile}) enforces the
 * both-or-neither and mutual-exclusion rules. For SFTP the placeholder username
 * is seeded -- the one identity field a locator cannot carry.
 */
function connectionFromLocator(
  locator: ExchangeFileConnection,
): ConnectionConfig {
  if (locator.channel === "sftp") {
    return {
      channel: "sftp",
      server: {
        host: locator.host,
        // The locator carries no credential; seed the one SSH identity field the
        // operator must fill in with an obvious placeholder (see mintExchangeFile).
        username: PLACEHOLDER_SSH_USERNAME,
        ...(locator.port !== undefined ? { port: locator.port } : {}),
        ...(locator.path !== undefined ? { path: locator.path } : {}),
        ...(locator.inboundPath !== undefined
          ? { inboundPath: locator.inboundPath }
          : {}),
        ...(locator.outboundPath !== undefined
          ? { outboundPath: locator.outboundPath }
          : {}),
      },
      ...(locator.options !== undefined ? { options: locator.options } : {}),
    };
  }
  return {
    channel: "filedrop",
    ...(locator.path !== undefined ? { path: locator.path } : {}),
    ...(locator.inboundPath !== undefined
      ? { inboundPath: locator.inboundPath }
      : {}),
    ...(locator.outboundPath !== undefined
      ? { outboundPath: locator.outboundPath }
      : {}),
    ...(locator.options !== undefined ? { options: locator.options } : {}),
  };
}
