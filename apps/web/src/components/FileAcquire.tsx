import { useEffect, useRef, useState } from "react";

import { loadCSVFile, sanitizeErrorForDisplay } from "@psilink/core";

import { emptyColumnPositions, unnameableColumnsAlert } from "@psi/columnNames";

import FileSelect from "@components/FileSelect";

/** A titled alert. The acquire phase emits its read-failure message through this
 * shape; the review screen renders it in the same slot. */
export interface AlertContent {
  title: string;
  message: string;
}

/** The parsed CSV the acquire phase hands up: the raw rows and the column list --
 * the two inputs `prepareForExchange` (and the "Prepare your data" editor's
 * satisfiability verdict) consume. Nothing here is connection- or role-specific. */
export interface AcquiredBundle {
  rawRows: Array<Record<string, string>>;
  columns: Array<string>;
}

/** Props for {@link FileAcquire}. */
export interface FileAcquireProps {
  /** Label for the submit button (FileSelect no longer hardcodes "Start"). */
  submitLabel: string;
  /** Seed the dropzone selection, e.g. with the file the acceptor already chose on
   * the home page (carried via the accept hand-off) so they need not re-drop it.
   * Only seeds the SELECTION -- the parse still runs on the gated submit, so this
   * never short-circuits the consent gate. Omitted, the dropzone starts empty. */
  initialFiles?: Array<File>;
  /** Hold the submit button disabled until an external precondition is met,
   * forwarded to {@link FileSelect}. The accept review screen -- the sole caller
   * -- passes its consent gate here, so the file cannot be parsed before the user
   * has consented and named themselves. Omitted, the button is enabled once a file
   * is chosen. */
  submitDisabled?: boolean;
  /** Set the shared error alert, or clear it (undefined) at the start of an
   * attempt. The review screen owns the alert state; the acquire phase only writes
   * its read-failure case. */
  onError: (alert: AlertContent | undefined) => void;
  /** Hand the parsed CSV to the review screen, which moves on to the "Prepare your
   * data" editor. Called at most once per mount: a fresh acquire comes from a
   * fresh mount. The linkage-satisfiability verdict is NOT computed here -- it
   * lives in the editor, over the operator's edited metadata/standardization, so
   * the gate and the editor agree. */
  onAcquired: (bundle: AcquiredBundle) => void;
}

/**
 * The file-acquire phase of a web exchange. It owns the {@link FileSelect}
 * dropzone, the selected-file state, and the CSV parse, all with its OWN abort
 * handling so a teardown mid-read stops without calling back into a torn-down
 * tree. On a successful parse it hands the raw rows and columns to
 * {@link onAcquired}; the review screen takes it from there. It never opens a
 * connection, prepares, or runs the exchange, and -- since the metadata editor
 * now owns the linkage-satisfiability verdict -- it no longer pre-flights: an
 * unsatisfiable file is handled in the editor (where the operator can fix it),
 * not dead-ended here.
 */
export default function FileAcquire(props: FileAcquireProps) {
  const { submitLabel, submitDisabled, initialFiles, onError, onAcquired } =
    props;

  // Seed from the hand-off once: a fresh acquire is a fresh mount, and the file is
  // a lazy handle, so holding it costs only a reference. The user can still re-drop
  // to replace it.
  const [files, setFiles] = useState<Array<File>>(() => initialFiles ?? []);
  const [submitted, setSubmitted] = useState(false);

  // Drives this phase's AbortSignal. A useEffect cleanup aborts it on unmount, so
  // a teardown during the async read tears down the in-flight parse and every
  // owner-driven seam stops firing (no setState after unmount).
  const abortRef = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abortRef.current?.abort(), []);

  const handleSubmit = () => {
    // Guard against re-entry: the FileSelect button is disabled via `submitted`,
    // but this makes the one-acquire-per-attempt invariant explicit -- a second
    // parse would orphan this controller's signal and race two reads on the same
    // state.
    if (abortRef.current) return;
    setSubmitted(true);
    onError(undefined);

    const controller = new AbortController();
    abortRef.current = controller;
    const submitSignal = controller.signal;

    // Load the CSV, then hand off. `submitSignal` guards against a teardown during
    // the read.
    void (async () => {
      const csvResult = await loadCSVFile(files[0]).catch(
        (error: unknown): undefined => {
          if (!submitSignal.aborted) {
            onError({
              title: "Could not read your file",
              message: sanitizeErrorForDisplay(error),
            });
            // The read failed before any handoff: abort and release the controller
            // (keeping the unmount-cleanup invariant that the stored controller is
            // the live one) and re-enable submit.
            controller.abort();
            abortRef.current = undefined;
            setSubmitted(false);
          }
          return undefined;
        },
      );
      // Aborted mid-read, or the read failed (handled above): stop without
      // handing off.
      if (submitSignal.aborted || csvResult === undefined) return;

      const rawRows = csvResult.data as Array<Record<string, string>>;
      const columns = csvResult.meta.fields ?? [];

      // Refuse an unnamed-column header before handing off: the editor seeds its
      // metadata from these columns via inferMetadata, which rejects an empty name
      // by throwing -- during the editor's render, where it would crash rather than
      // surface. An empty header cannot be fixed downstream (the editor offers no
      // column rename), so reject it here with the shared clear error, mirroring
      // the read-failure cleanup above (abort, release the controller, re-enable
      // submit).
      const emptyPositions = emptyColumnPositions(columns);
      if (emptyPositions.length > 0) {
        onError(unnameableColumnsAlert(emptyPositions));
        controller.abort();
        abortRef.current = undefined;
        setSubmitted(false);
        return;
      }

      onAcquired({ rawRows, columns });
    })();
  };

  return (
    <FileSelect
      submitLabel={submitLabel}
      submitDisabled={submitDisabled}
      handleSubmit={handleSubmit}
      submitted={submitted}
      files={files}
      setFiles={setFiles}
    />
  );
}
