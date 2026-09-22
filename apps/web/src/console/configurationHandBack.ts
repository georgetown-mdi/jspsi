import { ownColumnsField } from "@psi/ownColumnsModel";
import { standardizationForTerms } from "@psi/authoring/advancedInviteTerms";

import type { InviterEditor } from "@psi/inviterEditor";
import type { JobConfigurationHandBack } from "@jobs/intentSchemas";
import type { LinkageTerms } from "@psilink/core";
import type { ReceiptsDraft } from "@psi/receiptsModel";

/**
 * The settings the authoring steps edit, as the hand-back of an opened
 * configuration states them (`PUT /api/jobs/config`): the same values an
 * invitation minted from these steps would put in a run's configuration, read
 * off the same draft -- the reviewed terms, the column metadata, the cleaning
 * reconciled to those terms, the own-column choice narrowed to them, the
 * delimiter, and the receipt card's mode, pin, and retention note.
 *
 * The receipt mode is sent as the card holds it, `session-derived` included,
 * so a file stating a mode the card offers disabled keeps its block. Pure, so
 * the mapping is tested without the screen.
 */
export function configurationHandBack({
  editor,
  terms,
  csvDelimiter,
  receipts,
}: {
  editor: InviterEditor;
  /** The terms the review step validated, as a mint would embed them. */
  terms: LinkageTerms;
  csvDelimiter: string | undefined;
  receipts: ReceiptsDraft;
}): JobConfigurationHandBack {
  const { metadata, standardization, includeOwnColumns } = editor.draft;
  const pin = receipts.partnerFingerprint.trim();
  const note = receipts.retentionDisposition.trim();
  return {
    linkageTerms: terms,
    metadata,
    standardization: standardizationForTerms(standardization, terms),
    ...ownColumnsField(includeOwnColumns ?? "none", terms),
    ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
    signing: {
      mode: receipts.mode,
      ...(receipts.mode === "certificate" && pin !== ""
        ? { partnerFingerprint: pin }
        : {}),
    },
    ...(note !== "" ? { retentionDisposition: note } : {}),
  };
}
