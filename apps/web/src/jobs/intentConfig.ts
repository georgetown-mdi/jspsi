import { stringify as stringifyYaml } from "yaml";

import {
  ExchangeSpecSchema,
  deriveOutboundPayloadConsent,
  mintExchangeFile,
  snakeizeKeys,
} from "@psilink/core";

import { composedSigning } from "./intentSchemas";

import type {
  ExchangeFileInput,
  ExchangeSpec,
  FileSyncOptions,
  OutboundPayloadConsent,
} from "@psilink/core";

import type { JobSftpServerEntry } from "./sftpServer";

import type {
  JobExchangeIntent,
  JobExchangeOptions,
  JobFiledropExchangeIntent,
  JobSftpExchangeIntent,
  JobSigningPaths,
} from "./intentSchemas";

/**
 * This party's consent to its OWN outbound payload set, for the composed
 * config's `outbound_payload_consent`. An acceptance is the only side that
 * records one, deriving core's {@link deriveOutboundPayloadConsent} from the
 * same `linkageTerms.output` and `metadata` the same call composes into the
 * config, so the recorded consent and the config it rides in cannot
 * disagree.
 *
 * The three states are core's: absent where nothing is transmitted,
 * `pending` where no metadata was resolvable, `confirmed` with the resolved
 * set otherwise. A `pending` or `confirmed` record is what a later
 * unattended run's consent gate reads; without one the gate finds no record
 * and no run is held to a set.
 */
function outboundPayloadConsentFor(
  intent: JobExchangeIntent,
): OutboundPayloadConsent | undefined {
  if (intent.side !== "acceptor") return undefined;
  return deriveOutboundPayloadConsent(
    intent.linkageTerms.output,
    intent.metadata,
  );
}

/**
 * Compose the CLI config document (snake_case YAML the CLI loads verbatim) from a
 * validated filedrop {@link JobExchangeIntent}, setting the connection directory to
 * the operator-configured rendezvous mount (`JOB_RENDEZVOUS_DIR`) both parties can
 * reach. The directory is server-side environment configuration, never a
 * browser-sent string.
 *
 * On a split-provisioned console (`JOB_RENDEZVOUS_OUTBOUND_DIR` set) the
 * caller passes both mounts and the connection holds the CLI's
 * `inbound_path`/`outbound_path` pair instead of the single `path`, never
 * both together, which `mintExchangeFile`'s own schema refuses. The pair's
 * own rules are core's.
 *
 * The connection is built as a credential-free filedrop locator, so by
 * core's {@link ExchangeFileInput} typing no credential is representable;
 * `mintExchangeFile` never assembles an `authentication` block (the shared
 * secret rides the key file). The client's `linkageTerms`, `metadata`, and
 * `standardization` reach the file only after core's schema validation; the
 * one path field (`path`) is set by the server, not the client.
 *
 * Forwarding `metadata`/`standardization` is what makes the operator's data-prep
 * edits authoritative on the console path: the CLI's `prepareForExchange` uses the
 * composed metadata rather than falling back to `inferMetadata`, so a column the
 * operator marked ignored (or non-payload) is not silently disclosed.
 *
 * `expectedPayloadColumns`, when present, is forwarded as the config's
 * `expected_payload_columns` (the CLI prefers it over the `payload.receive`
 * fallback); an empty array is forwarded verbatim -- it means "receive
 * nothing" -- and only an omitted field reconciles lazily.
 *
 * `expectedPartnerDeduplicate`, when present, is forwarded as the config's
 * `expected_partner_deduplicate`: the CLI holds the inviter's presented
 * `deduplicate` to the value its invitation declared and refuses a
 * contradiction before any key or payload moves. `false` is forwarded
 * verbatim, a real declaration; only an omitted field binds nothing.
 *
 * The send-side counterpart is `outbound_payload_consent`, derived here for
 * an acceptance alone (see {@link outboundPayloadConsentFor}), so the
 * config this composer hands the operator is one a later unattended run's
 * consent gate is held to.
 *
 * `signingPaths` supplies the two paths a `signing` block names, which the
 * intent cannot hold; it is read only under `certificate` mode, so a caller
 * composing an unsigned exchange may omit it. The `retention_disposition`
 * note is forwarded verbatim.
 *
 * `include_own_columns` is forwarded verbatim too: a local output-composition
 * setting the CLI reads when it writes this party's result file, adding nothing
 * to what the partner is sent. The schema refuses it beside a count-only
 * algorithm, so an intent pairing the two fails here rather than at the run.
 */
export function composeConfigDocument(
  intent: JobFiledropExchangeIntent,
  rendezvousPath: string,
  outboundRendezvousPath?: string,
  signingPaths?: JobSigningPaths,
): string {
  const options = intentOptionsToFileSyncOptions(intent.options);
  const {
    metadata,
    standardization,
    expectedPayloadColumns,
    expectedPartnerDeduplicate,
    retentionDisposition,
    includeOwnColumns,
  } = intent;
  const outboundPayloadConsent = outboundPayloadConsentFor(intent);
  const signing = composedSigning(intent, signingPaths);
  const fileInput: ExchangeFileInput = {
    connection: {
      channel: "filedrop",
      ...(outboundRendezvousPath === undefined
        ? { path: rendezvousPath }
        : {
            inboundPath: rendezvousPath,
            outboundPath: outboundRendezvousPath,
          }),
      ...(options !== undefined ? { options } : {}),
    },
    linkageTerms: intent.linkageTerms,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(standardization !== undefined ? { standardization } : {}),
    ...(expectedPayloadColumns !== undefined ? { expectedPayloadColumns } : {}),
    ...(outboundPayloadConsent !== undefined ? { outboundPayloadConsent } : {}),
    ...(expectedPartnerDeduplicate !== undefined
      ? { expectedPartnerDeduplicate }
      : {}),
    ...(signing !== undefined ? { signing } : {}),
    ...(retentionDisposition !== undefined ? { retentionDisposition } : {}),
    ...(includeOwnColumns !== undefined ? { includeOwnColumns } : {}),
  };
  return mintExchangeFile(fileInput);
}

/**
 * Compose the CLI config document for an sftp job from a validated sftp intent
 * and the operator-authored server entry.
 *
 * The connection's `server` block is exactly the authored entry: every
 * host, port, identity, and credential-reference field is server-side data
 * validated when authored; the intent contributes nothing to it. The
 * entry's `@path` credential strings land in the YAML verbatim -- references
 * the CLI child resolves at exchange time, so no secret byte transits this
 * process. The client's `linkageTerms`, `metadata`, `standardization`,
 * `expectedPayloadColumns`, `expectedPartnerDeduplicate`,
 * `outbound_payload_consent`, `signing`, `retention_disposition`, and
 * `include_own_columns` are
 * composed as they are on the filedrop path; `options` is the same
 * numeric/boolean/enum subset, plus the `connectionPerPoll` dialing mode
 * this channel alone admits.
 *
 * This path does not use `mintExchangeFile`: its {@link ExchangeFileInput}
 * typing makes credentials unrepresentable, an invariant shared with the
 * browser minting flow that must not admit the console's credential-reference
 * entries. Instead the exchange spec is assembled directly, validated
 * through core's {@link ExchangeSpecSchema}, and serialized with the same
 * snakeize + yaml discipline `mintExchangeFile` uses. No `authentication`
 * block is ever assembled; the shared secret rides the key file.
 */
export function composeSftpConfigDocument(
  intent: JobSftpExchangeIntent,
  serverEntry: JobSftpServerEntry,
  signingPaths?: JobSigningPaths,
): string {
  const options = intentOptionsToFileSyncOptions(intent.options);
  const {
    metadata,
    standardization,
    expectedPayloadColumns,
    expectedPartnerDeduplicate,
    retentionDisposition,
    includeOwnColumns,
  } = intent;
  const outboundPayloadConsent = outboundPayloadConsentFor(intent);
  const signing = composedSigning(intent, signingPaths);
  const assembled: ExchangeSpec = {
    connection: {
      channel: "sftp",
      server: serverEntry,
      ...(options !== undefined ? { options } : {}),
    },
    linkageTerms: intent.linkageTerms,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(standardization !== undefined ? { standardization } : {}),
    ...(expectedPayloadColumns !== undefined ? { expectedPayloadColumns } : {}),
    ...(outboundPayloadConsent !== undefined ? { outboundPayloadConsent } : {}),
    ...(expectedPartnerDeduplicate !== undefined
      ? { expectedPartnerDeduplicate }
      : {}),
    ...(signing !== undefined ? { signing } : {}),
    ...(retentionDisposition !== undefined ? { retentionDisposition } : {}),
    ...(includeOwnColumns !== undefined ? { includeOwnColumns } : {}),
  };
  const validated = ExchangeSpecSchema.parse(assembled);
  return stringifyYaml(snakeizeKeys(validated));
}

/**
 * Serialize the CLI key file body. Only the shared secret is written; no
 * `expires` is stamped, so a server-driven job holds no invitation-token
 * lifetime of its own. Channel-independent: both arms have `sharedSecret`.
 */
export function composeKeyFileDocument(intent: JobExchangeIntent): string {
  return JSON.stringify({ sharedSecret: intent.sharedSecret });
}

/**
 * Narrow the intent's tuning subset into a {@link FileSyncOptions}. Returns
 * undefined when no option was set, so the composed connection omits the
 * block entirely rather than holding an empty object.
 */
function intentOptionsToFileSyncOptions(
  options: JobExchangeOptions | undefined,
): FileSyncOptions | undefined {
  if (options === undefined) return undefined;
  const entries = Object.entries(options).filter(
    ([, value]) => value !== undefined,
  );
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}
