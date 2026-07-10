import { Alert, Checkbox, TextInput } from "@mantine/core";

import styles from "./bench.module.css";

import type {
  AdvancedValidation,
  DraftLegalAgreement,
} from "@psi/advancedInvite";
import type { InviterEditor } from "./inviterModel";

const EMPTY_AGREEMENT: DraftLegalAgreement = {
  reference: "",
  purpose: "",
  expirationDate: "",
};

/**
 * The Legal agreement tab: attach or detach the optional agreement block and
 * author the three values the partner must enter identically at accept time.
 * Validation errors surface inline on the owning field.
 */
export function AgreementTab({
  editor,
  validation,
  onAgreement,
  onBack,
}: {
  editor: InviterEditor;
  validation: AdvancedValidation;
  onAgreement: (agreement: DraftLegalAgreement | undefined) => void;
  onBack: () => void;
}) {
  const agreement = editor.draft.legalAgreement;
  const set = (patch: Partial<DraftLegalAgreement>) =>
    onAgreement({ ...(agreement ?? EMPTY_AGREEMENT), ...patch });
  return (
    <>
      <button type="button" className={styles.backlink} onClick={onBack}>
        {"\u2190"} Back to Review &amp; create
      </button>
      <p className={styles.eyebrow}>Customize</p>
      <h1 tabIndex={-1}>Legal agreement</h1>
      <Checkbox
        label="Attach a legal agreement"
        description="Reference, purpose, and expiry your partner must enter identically."
        checked={agreement !== undefined}
        onChange={(event) =>
          onAgreement(event.currentTarget.checked ? EMPTY_AGREEMENT : undefined)
        }
        mt="sm"
      />
      {agreement !== undefined && (
        <>
          <Alert variant="light" mt="md">
            Your partner must enter these three values exactly as written here
            before they can accept. A mismatch stops the exchange - use the
            wording from your signed agreement.
          </Alert>
          <TextInput
            label="Agreement reference"
            placeholder="MOU-2025-0042"
            value={agreement.reference}
            error={validation.errors.legalReference}
            onChange={(event) => set({ reference: event.currentTarget.value })}
            mt="md"
          />
          <TextInput
            label="Purpose of the disclosure"
            placeholder="Program evaluation"
            value={agreement.purpose}
            error={validation.errors.legalPurpose}
            onChange={(event) => set({ purpose: event.currentTarget.value })}
            mt="md"
          />
          <TextInput
            label="Expiration date"
            placeholder="YYYY-MM-DD"
            value={agreement.expirationDate}
            error={validation.errors.legalExpiration}
            onChange={(event) =>
              set({ expirationDate: event.currentTarget.value })
            }
            mt="md"
            maw={220}
          />
        </>
      )}
    </>
  );
}
