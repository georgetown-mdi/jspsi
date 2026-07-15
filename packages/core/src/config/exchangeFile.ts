import { stringify as stringifyYaml } from "yaml";

import { ExchangeSpecSchema } from "./exchangeSpec.js";
import type { ExchangeSpec } from "./exchangeSpec.js";
import type { ConnectionConfig, FileSyncOptions } from "./connection.js";
import type { LinkageTerms } from "./linkageTerms.js";
import type { Metadata } from "./metadata.js";
import type { Standardization } from "./standardization.js";
import { snakeizeKeys } from "../utils/camelizeKeys.js";
import { PLACEHOLDER_SSH_USERNAME } from "./endpointProducer.js";
import { WebRTCEndpointSchema } from "./invitation.js";
import type { WebRTCEndpoint } from "./invitation.js";

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
 * The credential-free WebRTC locator a web-composed exchange config carries:
 * WHERE the PeerJS peer-coordination server is (`host`/optional `port`/optional
 * `path`), never HOW to reach it privately. It is the invitation's
 * {@link WebRTCEndpoint} -- one locator type, not a second parallel definition --
 * so the endpoint the code carries and the connection block a managed record
 * persists agree on the credential-free shape by construction.
 *
 * By composition NO credential is representable: the type carries no PeerJS
 * `server.key`, no `server.username`, and no `turn`, `ice_provision`, or
 * `provider_options` entry (a TURN entry carries relay credentials and the
 * provider map is opaque and `@`-file-pathed). The full webrtc connection block
 * CAN represent those fields, so the guarantee is the composition rule --
 * {@link connectionFromLocator} expands only these locator fields and
 * {@link WebRTCEndpointSchema} rejects any other -- not a runtime strip.
 */
export type WebRTCExchangeLocator = WebRTCEndpoint;

/**
 * A credential-free connection description the browser mints a DOWNLOADABLE
 * exchange config from, discriminated by `channel`. Carries ONLY locator fields
 * -- by construction no credential (username/password/private key/fingerprint)
 * is representable, so the minted file cannot leak one even if a caller tried.
 * Deliberately covers only the file-sync channels a downloadable config targets
 * (`sftp`, `filedrop`); a webrtc exchange is coordinated live, not from a minted
 * file, so {@link WebRTCExchangeLocator} is intentionally NOT a member here --
 * this narrowness is what keeps {@link mintExchangeFile}'s surface file-sync-only
 * (see the mint-surface guard test).
 */
export type ExchangeFileConnection =
  SftpExchangeLocator | FiledropExchangeLocator;

/**
 * The full credential-free locator union {@link connectionFromLocator} expands:
 * the file-sync {@link ExchangeFileConnection} channels plus
 * {@link WebRTCExchangeLocator}. Broader than {@link ExchangeFileConnection}
 * because the locator-to-connection expansion also serves the managed-record
 * composer, which composes a live webrtc connection block; the downloadable-file
 * mint path stays on the narrower file-sync-only {@link ExchangeFileConnection}.
 */
export type ExchangeLocator = ExchangeFileConnection | WebRTCExchangeLocator;

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
 * The inputs {@link assembleExchangeSpec} assembles into a validated
 * {@link ExchangeSpec}: an already-expanded connection block plus the shared
 * optional blocks. This is {@link ExchangeFileInput} with the connection past
 * its locator expansion -- the seam between the two composers' locator types
 * (file-sync for the downloadable mint, webrtc for the managed record) and the
 * one assembly rule they share.
 */
export interface ExchangeSpecAssembly {
  connection: ConnectionConfig;
  linkageTerms: LinkageTerms;
  metadata?: Metadata;
  standardization?: Standardization;
  /** See {@link ExchangeFileInput.disclosedPayloadColumns}. */
  disclosedPayloadColumns?: string[];
  /** See {@link ExchangeFileInput.expectedPayloadColumns}. */
  expectedPayloadColumns?: string[];
}

/**
 * Assemble an exchange spec on the camelCase side and validate it through
 * {@link ExchangeSpecSchema}, returning the PARSE RESULT (never the raw input)
 * so only the schema's own fields reach a consumer -- the same "use what the
 * schema returns" discipline encodeInvitation follows. The input is already
 * camelCase (built in TS), so no camelize pre-pass. Optional blocks are attached
 * only when present, so an absent field is an omitted key, not an explicit
 * `undefined` a snakeize/serialize step would render.
 *
 * The single assembly rule behind both composers: {@link mintExchangeFile}
 * serializes this result to the downloadable YAML, and the web app's
 * managed-record composer persists it directly, so the two artifacts cannot
 * drift apart in how a spec is assembled. No `authentication` block is ever
 * assembled -- the shared secret is not representable in the input.
 *
 * @throws {ZodError} if the assembled spec fails {@link ExchangeSpecSchema}
 *   validation (an invalid connection, an out-of-range port, a malformed split
 *   pair, ...).
 */
export function assembleExchangeSpec(
  input: ExchangeSpecAssembly,
): ExchangeSpec {
  const assembled: ExchangeSpec = {
    connection: input.connection,
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
  return ExchangeSpecSchema.parse(assembled);
}

/**
 * Assemble a browser-composed exchange into the CLI's exact config schema and
 * serialize it to the snake_case YAML the CLI loads verbatim.
 *
 * The artifact IS the CLI config: it validates through
 * {@link assembleExchangeSpec} (the camelCase side) before serializing and fails
 * loudly on any mismatch -- a ZodError surfaces here, on the minting side, rather
 * than when the CLI later loads a malformed file -- then is written with the same
 * {@link snakeizeKeys} + yaml `stringify` discipline the CLI's `saveConfig` uses,
 * so a downloaded file parses through the CLI's config load path without edits.
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
  const validated = assembleExchangeSpec({
    ...input,
    connection: connectionFromLocator(input.connection),
  });
  return stringifyYaml(snakeizeKeys(validated));
}

/**
 * Expand a credential-free {@link ExchangeLocator} into the CLI's
 * {@link ConnectionConfig} shape. The single-vs-split directory form is carried
 * through verbatim; the schema (applied by {@link mintExchangeFile}, or by the
 * managed-record composer for the webrtc arm) enforces the both-or-neither and
 * mutual-exclusion rules. For SFTP the placeholder username is seeded -- the one
 * identity field a locator cannot carry.
 *
 * For WebRTC the guarantee extends into the nested `server` object, which the
 * flat file-sync locators never had to exclude: the expansion copies only the
 * {@link WebRTCEndpointSchema}-validated `host`/`port`/`path` into `server`, so
 * neither the PeerJS `server.key` nor `server.username`, and no sibling `turn`,
 * `ice_provision`, or `provider_options` entry, is representable in the result.
 * The locator is validated through {@link WebRTCEndpointSchema} first, so a
 * type-bypassed caller's unexpected key is rejected (the strict object) rather
 * than silently stripped by the webrtc connection schema's non-strict object.
 */
export function connectionFromLocator(
  locator: ExchangeLocator,
): ConnectionConfig {
  if (locator.channel === "webrtc") {
    const endpoint = WebRTCEndpointSchema.parse(locator);
    return {
      channel: "webrtc",
      server: {
        host: endpoint.host,
        ...(endpoint.port !== undefined ? { port: endpoint.port } : {}),
        ...(endpoint.path !== undefined ? { path: endpoint.path } : {}),
      },
    };
  }
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
