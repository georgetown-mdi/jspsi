import { useEffect, useState } from "react";

import {
  Alert,
  Anchor,
  Button,
  Checkbox,
  NumberInput,
  TextInput,
} from "@mantine/core";
import { IconCircleCheck } from "@tabler/icons-react";
import { Link } from "@tanstack/react-router";

import { probeManagedStoreOpen } from "@psi/managedExchangeStore";

import {
  LABEL_GUIDANCE,
  MAX_LABEL_LENGTH,
  MAX_TOKEN_MAX_AGE_DAYS,
  labelWithinCap,
  maxAgeCadenceNote,
  maxAgeDaysError,
} from "./manageOfferModel";
import styles from "./bench.module.css";

import type { ManageOfferChoices } from "./manageOfferModel";

/** The deposit's progress, driven by the host that owns the store write: `idle`
 * before the operator commits, `depositing` while the write is in flight,
 * `deposited` once the record lands, and `error` when the write failed. */
export type ManageOfferStatus = "idle" | "depositing" | "deposited" | "error";

/** Whether this browser can open the managed store, probed once on mount:
 * `undefined` while the probe is in flight, then the settled answer. The offer
 * holds until it settles so a storage-blocked browser never renders the form and
 * then swaps it for the degrade. */
function useManagedStoreAvailability(): boolean | undefined {
  const [available, setAvailable] = useState<boolean>();
  useEffect(() => {
    let live = true;
    void probeManagedStoreOpen().then((ok) => {
      if (live) setAvailable(ok);
    });
    return () => {
      live = false;
    };
  }, []);
  return available;
}

/**
 * The offer to save this exchange as a recurring one, rendered as its own panel on
 * the inviter's share surface and the acceptor's completion surface. Declining is
 * simply not acting: the offer never blocks the one-shot flow, and leaving it
 * untouched leaves no managed record (the one-shot discard stands). Committing
 * deposits a managed-exchange record for this party -- the standing terms plus the
 * deposited secret -- so the same partnership can run again later.
 *
 * The panel collects the operator's label and optional max-age policy and hands
 * them to {@link onManage}; the host owns the async store write and reports back
 * through {@link status}. The label cap and the max-age cadence line come from the
 * pure {@link ./manageOfferModel}, so the copy and the enforcement match the record
 * schema.
 *
 * Before the form, the panel probes whether this browser can open the managed store
 * at all: a storage-blocked browser (private mode, or an engine without IndexedDB)
 * cannot honor a deposit, so collecting a label and a max-age policy there would
 * invest the operator in a form that only fails at the write. When the probe settles
 * unavailable, a short honest state stands in for the form; the panel holds until the
 * probe settles rather than flashing the form first (the offer sits on a completion
 * surface, so a brief settle is invisible). A write can still fail after a successful
 * probe, so the deposit-failure alert stays.
 */
export function ManageExchangeOffer({
  status,
  handleCaptured,
  onManage,
}: {
  status: ManageOfferStatus;
  /** Whether a File System Access input-file handle was captured from the
   * operator's selection, so a scheduled re-run can re-read the file without
   * re-selection. Absent capture is normal (a click-selected file, or a browser
   * without the API); the panel names which case holds so the operator is not
   * surprised by a re-selection prompt later. */
  handleCaptured: boolean;
  onManage: (choices: ManageOfferChoices) => void;
}) {
  const [label, setLabel] = useState("");
  const [maxAgeEnabled, setMaxAgeEnabled] = useState(false);
  // Held as the NumberInput reports it (a string when cleared or mid-edit), so
  // an invalid state is representable and can block the deposit rather than
  // being coerced to a sentinel that silently drops the opted-in bound.
  const [maxAgeDays, setMaxAgeDays] = useState<number | string>(90);
  const storeAvailable = useManagedStoreAvailability();

  // A successful deposit proves the store was openable, so the confirmation stands
  // regardless of the probe (it never runs against a store this browser cannot open).
  if (status === "deposited")
    return (
      <div className={styles.callout}>
        <p className={styles.calloutLead}>
          <IconCircleCheck
            size={18}
            aria-hidden
            style={{ verticalAlign: "text-bottom", marginRight: 6 }}
          />
          Saved as a recurring exchange.
        </p>
        <p className={styles.small}>
          Its terms and secret are stored in this browser so you can run it
          again with the same partner. Find it in your{" "}
          <Anchor inherit component={Link} to="/saved">
            recurring exchanges
          </Anchor>
          .
        </p>
      </div>
    );

  // Hold the panel until the probe settles: rendering the form and then swapping it
  // for the degrade would flash a form a storage-blocked browser cannot honor. The
  // surface is a completion screen, so the settle is invisible.
  if (storeAvailable === undefined) return null;

  // The store cannot be opened at all in this browser, so no deposit can land: offer
  // the honest state instead of a form that only fails at the write. No alarm
  // styling -- the one-off exchange the operator just completed is unaffected.
  if (!storeAvailable)
    return (
      <div className={styles.callout}>
        <p className={styles.calloutLead}>Save as a recurring exchange</p>
        <p className={styles.small}>
          This browser cannot store recurring exchanges -- private browsing may
          be blocking storage, or this browser does not support it. Your one-off
          exchange is unaffected.
        </p>
      </div>
    );

  // An enabled policy with an invalid day count blocks the deposit (the field
  // error below names why): resolving it to "no bound" would silently drop the
  // opted-in exposure bound the operator asked for.
  const maxAgeError = maxAgeEnabled ? maxAgeDaysError(maxAgeDays) : undefined;
  const tokenMaxAgeDays =
    maxAgeEnabled && maxAgeError === undefined && typeof maxAgeDays === "number"
      ? maxAgeDays
      : undefined;
  const cadenceNote = maxAgeCadenceNote(tokenMaxAgeDays);
  const labelValid = labelWithinCap(label);
  const depositing = status === "depositing";
  const canManage =
    labelValid && !depositing && (!maxAgeEnabled || maxAgeError === undefined);

  return (
    <div className={styles.callout}>
      <p className={styles.calloutLead}>Save as a recurring exchange</p>
      <p className={styles.small}>
        Store this exchange&apos;s terms and secret in this browser so you can
        run it again with the same partner, without re-inviting. Skip this to
        keep the exchange one-off: nothing is stored.
      </p>
      <TextInput
        label="Label"
        description={LABEL_GUIDANCE}
        value={label}
        maxLength={MAX_LABEL_LENGTH}
        error={
          labelValid
            ? undefined
            : `Keep the label to ${MAX_LABEL_LENGTH} characters or fewer.`
        }
        onChange={(event) => setLabel(event.currentTarget.value)}
        mt="sm"
      />
      <Checkbox
        label="Set a maximum age for the stored secret"
        description="Off by default. When set, the stored secret lapses if the exchange is not run or renewed within the age you choose."
        checked={maxAgeEnabled}
        onChange={(event) => setMaxAgeEnabled(event.currentTarget.checked)}
        mt="sm"
      />
      {maxAgeEnabled && (
        <NumberInput
          label="Maximum age in days"
          value={maxAgeDays}
          min={1}
          max={MAX_TOKEN_MAX_AGE_DAYS}
          step={1}
          allowDecimal={false}
          error={maxAgeError}
          onChange={setMaxAgeDays}
          mt="xs"
        />
      )}
      {cadenceNote !== undefined && (
        <p className={`${styles.small} ${styles.sub}`}>{cadenceNote}</p>
      )}
      <p className={`${styles.small} ${styles.sub}`}>
        {handleCaptured
          ? "A scheduled run can re-read your input file from this browser without re-selecting it."
          : "You will re-select your input file for each run; this browser did not capture a reusable pointer to it."}
      </p>
      {status === "error" && (
        <Alert
          color="red"
          title="Could not save this recurring exchange"
          mt="sm"
        >
          The exchange was not stored. Your one-off exchange is unaffected - try
          again.
        </Alert>
      )}
      <Button
        mt="sm"
        loading={depositing}
        disabled={!canManage}
        onClick={() =>
          onManage({
            label,
            ...(tokenMaxAgeDays !== undefined ? { tokenMaxAgeDays } : {}),
          })
        }
      >
        Save as a recurring exchange
      </Button>
    </div>
  );
}
