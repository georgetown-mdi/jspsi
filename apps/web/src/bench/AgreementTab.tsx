import { useEffect, useRef } from "react";

import { Alert, Checkbox, TextInput } from "@mantine/core";

import { MAX_NAME_LENGTH, MAX_TEXT_LENGTH } from "@psilink/core";

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
  // No-op when the block is detached (the fields unmount with it), so a
  // batched field patch can never silently re-attach an emptied agreement.
  const set = (patch: Partial<DraftLegalAgreement>) => {
    if (agreement === undefined) return;
    onAgreement({ ...agreement, ...patch });
  };

  // Checking "Attach" reveals the three fields below the checkbox; send a
  // keyboard user into the first one rather than leaving them on the checkbox
  // with no cue the block opened.
  const referenceRef = useRef<HTMLInputElement>(null);
  const wasAttached = useRef(agreement !== undefined);
  useEffect(() => {
    if (!wasAttached.current && agreement !== undefined)
      referenceRef.current?.focus();
    wasAttached.current = agreement !== undefined;
  }, [agreement]);
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
            ref={referenceRef}
            label="Agreement reference"
            placeholder="MOU-2025-0042"
            value={agreement.reference}
            maxLength={MAX_NAME_LENGTH}
            error={validation.errors.legalReference}
            errorProps={{ role: "alert" }}
            onChange={(event) => set({ reference: event.currentTarget.value })}
            mt="md"
          />
          <TextInput
            label="Purpose of the disclosure"
            placeholder="Program evaluation"
            value={agreement.purpose}
            maxLength={MAX_TEXT_LENGTH}
            error={validation.errors.legalPurpose}
            errorProps={{ role: "alert" }}
            onChange={(event) => set({ purpose: event.currentTarget.value })}
            mt="md"
          />
          <TextInput
            type="date"
            label="Expiration date"
            placeholder="YYYY-MM-DD"
            value={agreement.expirationDate}
            error={validation.errors.legalExpiration}
            errorProps={{ role: "alert" }}
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
