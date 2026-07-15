/**
 * The managed-exchange export/import artifact: the plaintext credential file that
 * is the durability backbone against silent browser-storage eviction and the
 * device-migration path (see docs/MANAGED_EXCHANGE.md, "Surviving storage
 * eviction", and docs/spec/MANAGED_EXCHANGE_RECORD.md, "Export artifact"). This
 * module is the pure, platform-free half: it encodes a stored
 * {@link ManagedExchangeRecord} to the artifact and parses an untrusted artifact
 * back to a runnable record, so the format and its trust boundary are unit-testable
 * without a database or a download.
 *
 * The artifact is the browser analog of handing over `psilink.yaml` plus
 * `.psilink.key` together, kept CLI-separable rather than becoming a third format:
 *
 * - `exchangeDocument` embeds the exchange-file document as a valid `psilink.yaml`
 *   (the same snake_case YAML the CLI loads, produced through the same discipline
 *   the mint layer uses on its validated spec);
 * - `key` is the `.psilink.key` pair -- `sharedSecret` and, when a bound is in
 *   force, `expires` -- so the secret half maps onto a valid key file;
 * - `local` carries the browser-only fields the two CLI artifacts do not
 *   (`label`, `side`, `schedule`, `lastRun`, `tokenMaxAgeDays`), cleanly separable
 *   and ignorable by the CLI toolchain.
 *
 * The input-file handle is deliberately absent (a device- and profile-local
 * platform object with no file serialization), so the first run after an import
 * re-acquires one by selection. No secret-derived value and no rotation epoch is
 * written: the artifact snapshots the secret current at export and carries no
 * history (see the spec's "No anti-rollback").
 *
 * Import is a trust boundary: the artifact is untrusted structured input, so the
 * whole document is parsed through the shared sensitive-JSON chokepoint (bounded,
 * path-only errors) and then a strict reader-rejects-unknown schema, and the
 * reconstructed record is re-validated through {@link parseManagedExchangeRecord}
 * before it is a record. A malformed or tampered artifact is rejected by throwing;
 * a caller installs nothing on a rejection, so a bad import cannot corrupt the
 * store.
 */

import {
  parseExchangeSpec,
  parseSensitiveJson,
  parseSensitiveYaml,
  snakeizeKeys,
} from "@psilink/core";

import { stringify as stringifyYaml } from "yaml";

import { z } from "zod";

import {
  MANAGED_EXCHANGE_ARTIFACT_VERSION,
  buildManagedExchangeRecord,
  keyFileFieldsSchema,
  parseManagedExchangeRecord,
} from "./managedExchangeRecord";

import type {
  ManagedExchangeLastRun,
  ManagedExchangeRecord,
  ManagedExchangeSchedule,
  ManagedExchangeSide,
} from "./managedExchangeRecord";
import type { ExchangeSpec } from "@psilink/core";
import type { ZodType } from "zod";

/** The MIME type the artifact downloads as; it is a JSON document. */
export const MANAGED_EXCHANGE_ARTIFACT_MIME = "application/json";

/** The `.psilink.key` pair the artifact carries: the current shared secret and,
 * when a bound is in force, the `expires` instant it lapses at. This is exactly the
 * key file's own shape, so the secret half of the artifact maps onto a valid
 * `.psilink.key`. */
export interface ManagedExchangeArtifactKey {
  /** The current rotated shared secret (base64url, 43 chars / 32 bytes). */
  sharedSecret: string;
  /** The instant after which the secret must not be used; absent means no bound. */
  expires?: string;
}

/** The browser-only fields the artifact carries alongside the two CLI halves --
 * the fields the CLI's config-plus-key pair does not have. Cleanly separable and
 * ignorable by the CLI toolchain. */
export interface ManagedExchangeArtifactLocal {
  /** The operator's display label. */
  label: string;
  /** This party's side of the partnership, dispatching a re-run. */
  side: ManagedExchangeSide;
  /** The agreed run schedule, when saved as recurring. */
  schedule?: ManagedExchangeSchedule;
  /** The run bookkeeping the imported record carries forward. */
  lastRun?: ManagedExchangeLastRun;
  /** The max-token-age policy, when the operator opted in. */
  tokenMaxAgeDays?: number;
}

/**
 * The export artifact: a version tag, the embedded `psilink.yaml` document as
 * text, the `.psilink.key` pair, and the separable local fields. The input-file
 * handle is not a member (no file serialization; see the module header).
 */
export interface ManagedExchangeArtifact {
  /** The single recognized artifact-format literal; a reader rejects any other
   * value rather than migrating it. */
  artifactVersion: typeof MANAGED_EXCHANGE_ARTIFACT_VERSION;
  /** The exchange-file document embedded as a valid `psilink.yaml` (snake_case
   * YAML). The CLI half of the record. */
  exchangeDocument: string;
  /** The `.psilink.key` pair (see {@link ManagedExchangeArtifactKey}). */
  key: ManagedExchangeArtifactKey;
  /** The browser-only fields (see {@link ManagedExchangeArtifactLocal}). */
  local: ManagedExchangeArtifactLocal;
}

/**
 * Encode a stored record as the export artifact. The exchange-file document is
 * serialized to the snake_case YAML the CLI loads (the same
 * {@link snakeizeKeys} + yaml `stringify` discipline the mint layer applies to its
 * validated spec), so the embedded half is a valid `psilink.yaml`; the secret and
 * any `expires` become the key pair; and the browser-only fields become the local
 * block. The input-file handle is dropped -- it does not serialize and the first
 * run after an import re-acquires one. The record's `id` is not carried: an import
 * is a take-over that mints a fresh local record, not a copy of this one.
 */
export function encodeManagedExchangeArtifact(
  record: ManagedExchangeRecord,
): ManagedExchangeArtifact {
  return {
    artifactVersion: MANAGED_EXCHANGE_ARTIFACT_VERSION,
    exchangeDocument: stringifyYaml(snakeizeKeys(record.exchangeFile)),
    key: {
      sharedSecret: record.sharedSecret,
      ...(record.expires !== undefined ? { expires: record.expires } : {}),
    },
    local: {
      label: record.label,
      side: record.side,
      ...(record.schedule !== undefined ? { schedule: record.schedule } : {}),
      ...(record.lastRun !== undefined ? { lastRun: record.lastRun } : {}),
      ...(record.tokenMaxAgeDays !== undefined
        ? { tokenMaxAgeDays: record.tokenMaxAgeDays }
        : {}),
    },
  };
}

/**
 * Serialize the artifact to the plaintext file bytes the operator holds outside the
 * browser. Pretty-printed JSON with a trailing newline, matching the CLI key file's
 * on-disk formatting.
 */
export function serializeManagedExchangeArtifact(
  artifact: ManagedExchangeArtifact,
): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

/** The local block's validator: reader-rejects-unknown (strict), the label cap and
 * schedule/lastRun shapes reused from the record schema through the reconstructed
 * record's own re-validation, so this schema bounds only what it must to
 * reconstruct. */
const artifactLocalSchema: ZodType<ManagedExchangeArtifactLocal> = z
  .object({
    label: z.string(),
    side: z.enum(["inviter", "acceptor"]),
    schedule: z
      .object({
        anchor: z.iso.datetime(),
        intervalDays: z.int(),
        windowSeconds: z.int(),
        nextWindow: z.iso.datetime(),
        consecutiveMisses: z.int(),
      })
      .strict()
      .optional(),
    lastRun: z
      .object({
        at: z.iso.datetime(),
        outcome: z.enum(["succeeded", "failed", "desynced", "missed"]),
        failureKind: z
          .enum(["auth", "transport", "storage", "input", "cancelled"])
          .optional(),
      })
      .strict()
      .optional(),
    tokenMaxAgeDays: z.int().optional(),
  })
  .strict();

/** The whole-artifact validator: reader-rejects-unknown at the top level and on
 * the key and local blocks, with the embedded document parsed separately (it is
 * YAML text, validated through {@link parseExchangeSpec} in
 * {@link parseManagedExchangeArtifact}). */
const artifactSchema: ZodType<ManagedExchangeArtifact> = z
  .object({
    artifactVersion: z.literal(MANAGED_EXCHANGE_ARTIFACT_VERSION),
    exchangeDocument: z.string(),
    key: keyFileFieldsSchema,
    local: artifactLocalSchema,
  })
  .strict();

/**
 * Parse untrusted artifact bytes into a validated {@link ManagedExchangeArtifact}.
 * The whole document is parsed through the shared sensitive-JSON chokepoint
 * ({@link parseSensitiveJson}: structurally bounded before the parse, path-only
 * errors so no artifact bytes leak) and then the strict reader-rejects-unknown
 * {@link artifactSchema}. The embedded exchange document's YAML is not validated
 * here; {@link reconstructRecordFromArtifact} validates it through the exchange-file
 * parser.
 *
 * @throws {UsageError} if the bytes are not parseable JSON.
 * @throws {ZodError} if the parsed value is not a valid artifact.
 */
export function parseManagedExchangeArtifact(
  source: string,
): ManagedExchangeArtifact {
  const raw = parseSensitiveJson(source, "managed exchange backup");
  return artifactSchema.parse(raw);
}

/**
 * Reconstruct a runnable record from a validated artifact: a take-over that installs
 * the one owner. The embedded document is parsed back through
 * {@link parseSensitiveYaml} and {@link parseExchangeSpec} (rejecting a tampered or
 * non-conforming document, and confirming the CLI-separable half is a valid
 * exchange file), the secret and `expires` come from the key pair, and the local
 * fields are carried forward. The record is built through
 * {@link buildManagedExchangeRecord} -- a fresh `id` and the v1 `schemaVersion`,
 * re-validated through the record schema -- so a document carrying an
 * `authentication` block, an over-long label, or a malformed secret is rejected
 * here and nothing is installed. The imported record carries NO input-file handle:
 * the first run re-acquires one by selection.
 *
 * @throws {UsageError} if the embedded document is not parseable YAML.
 * @throws {ZodError} if the embedded document or the reconstructed record is invalid.
 */
export function reconstructRecordFromArtifact(
  artifact: ManagedExchangeArtifact,
): ManagedExchangeRecord {
  const document = parseSensitiveYaml(
    artifact.exchangeDocument,
    "managed exchange backup document",
  );
  const exchangeFile: ExchangeSpec = parseExchangeSpec(document);
  return buildManagedExchangeRecord({
    label: artifact.local.label,
    exchangeFile,
    side: artifact.local.side,
    sharedSecret: artifact.key.sharedSecret,
    ...(artifact.key.expires !== undefined
      ? { expires: artifact.key.expires }
      : {}),
    ...(artifact.local.tokenMaxAgeDays !== undefined
      ? { tokenMaxAgeDays: artifact.local.tokenMaxAgeDays }
      : {}),
    ...(artifact.local.schedule !== undefined
      ? { schedule: artifact.local.schedule }
      : {}),
    ...(artifact.local.lastRun !== undefined
      ? { lastRun: artifact.local.lastRun }
      : {}),
  });
}

/**
 * Parse and reconstruct in one step: the untrusted-input entry point a caller uses
 * to turn artifact bytes into a runnable record. Rejects a malformed or tampered
 * artifact by throwing, so a caller installs nothing on a rejection and the store is
 * left untouched.
 *
 * @throws {UsageError} if the bytes are not parseable JSON or the embedded document
 *   is not parseable YAML.
 * @throws {ZodError} if the artifact or the reconstructed record is invalid.
 */
export function importManagedExchangeArtifact(
  source: string,
): ManagedExchangeRecord {
  return reconstructRecordFromArtifact(parseManagedExchangeArtifact(source));
}
