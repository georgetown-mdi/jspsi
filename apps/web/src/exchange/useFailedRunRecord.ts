import { useEffect, useState } from "react";

import { getLogger } from "@alcove/core";

import { failedRunRecordOffer } from "@psi/runOutputs";

import type { AvailableRecordOffer } from "@psi/runOutputs";
import type { BuiltExchangeRecord } from "@alcove/core";

const log = getLogger("useFailedRunRecord");

/**
 * The exchange record an in-browser run that failed after sending this party's
 * payload holds, offered for download beside the failure.
 *
 * `offerRunRecord` builds the pair's object URLs; they are revoked when the
 * offer is replaced or cleared and when the seat unmounts, since the keys are
 * private material. A failure building them is logged and offers nothing: the
 * run's own failure is already on screen and must not be replaced.
 */
export function useFailedRunRecord(): {
  runRecord: AvailableRecordOffer | undefined;
  offerRunRecord: (record: BuiltExchangeRecord) => void;
  clearRunRecord: () => void;
} {
  const [runRecord, setRunRecord] = useState<AvailableRecordOffer>();

  useEffect(() => {
    if (runRecord === undefined) return;
    return () => {
      window.URL.revokeObjectURL(runRecord.downloads.recordUrl);
      window.URL.revokeObjectURL(runRecord.downloads.keysUrl);
    };
  }, [runRecord]);

  const offerRunRecord = (record: BuiltExchangeRecord): void => {
    try {
      setRunRecord(
        failedRunRecordOffer(record, {
          create: (blob) => window.URL.createObjectURL(blob),
          revoke: (url) => window.URL.revokeObjectURL(url),
        }),
      );
    } catch (error) {
      log.error(
        "building a failed run's exchange record downloads failed:",
        error,
      );
    }
  };

  const clearRunRecord = (): void => setRunRecord(undefined);

  return { runRecord, offerRunRecord, clearRunRecord };
}
