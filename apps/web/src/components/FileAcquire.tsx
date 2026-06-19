import { useEffect, useRef, useState } from "react";

import {
  assessLinkageSatisfiability,
  loadCSVFile,
  sanitizeErrorForDisplay,
  sanitizeForDisplay,
} from "@psilink/core";

import FileSelect from "@components/FileSelect";

import type { LinkageTerms } from "@psilink/core";

/** A titled alert. The acquire phase emits its read-failure and unsatisfiable-CSV
 * messages through this shape; the run owner ({@link ExchangeView}) renders them
 * in the same slot it uses for run failures, so an acquire error and a run error
 * never stack and the alert position is unchanged from the pre-split component. */
export interface AlertContent {
  title: string;
  message: string;
}

/** The parsed, pre-flight-passing CSV the acquire phase hands the run owner: the
 * raw rows and the column list -- the two inputs `prepareForExchange` consumes.
 * Nothing here is connection- or role-specific; the run owner adds those. */
export interface AcquiredBundle {
  rawRows: Array<Record<string, string>>;
  columns: Array<string>;
}

/** Props for {@link FileAcquire}. */
export interface FileAcquireProps {
  /** Label for the submit button (FileSelect no longer hardcodes "Start"). */
  submitLabel: string;
  /** Hold the submit button disabled until an external precondition is met,
   * forwarded to {@link FileSelect}. The accept review screen -- the sole caller
   * -- passes its consent gate here, so the file cannot be parsed (let alone
   * handed off and dialed) before the user has consented and named themselves.
   * Omitted, the button is enabled once a file is chosen. */
  submitDisabled?: boolean;
  /** The adopted linkage terms the acceptor's CSV must satisfy before any
   * connection; supplying them triggers the satisfiability pre-flight (block on
   * zero satisfiable keys, warn on partial). The accept review screen always
   * passes the inviter's decoded terms; the prop stays optional so a terms-less
   * file-acquire simply skips the pre-flight. */
  linkageTerms?: LinkageTerms;
  /** Set the shared error alert, or clear it (undefined) at the start of an
   * attempt. The run owner owns the alert state; the acquire phase only writes
   * its read-failure and unsatisfiable-CSV cases. */
  onError: (alert: AlertContent | undefined) => void;
  /** Set the partial-coverage warning, or clear it. Set during the acceptor
   * pre-flight; the run owner keeps it visible on success (it explains why the
   * match count may be lower) and clears it only on a run failure. */
  onWarning: (alert: AlertContent | undefined) => void;
  /** Hand the parsed, satisfiable CSV to the run owner, which starts the
   * exchange. Called at most once per mount: a fresh acquire comes from a fresh
   * mount (the run subtree is keyed by the secret), mirroring the
   * one-exchange-per-mount run invariant. */
  onAcquired: (bundle: AcquiredBundle) => void;
}

/**
 * The file-acquire phase of a web exchange. It owns the {@link FileSelect}
 * dropzone, the selected-file state, the CSV parse, and -- for the acceptor --
 * the linkage-satisfiability pre-flight, all with its OWN abort handling so a
 * teardown mid-read stops without calling back into a torn-down tree. On a
 * successful parse (and, for the acceptor, a satisfiable CSV) it hands the raw
 * rows and columns to {@link onAcquired}; the run owner takes it from there. It
 * never opens a connection, prepares, or runs the exchange.
 *
 * The pre-flight runs on this phase's own AbortController, NOT the run's single
 * one: pre-flight aborts on a read failure or an unsatisfiable file, and keeping
 * that off the run controller is the seam the split turns on -- the naive "move
 * parse + pre-flight up but share the controller" cut would sever the run's
 * single controller across the boundary. By the time the run starts, acquisition
 * has already settled, so the two controllers never need to be one.
 */
export default function FileAcquire(props: FileAcquireProps) {
  const {
    submitLabel,
    submitDisabled,
    linkageTerms,
    onError,
    onWarning,
    onAcquired,
  } = props;

  const [files, setFiles] = useState<Array<File>>([]);
  const [submitted, setSubmitted] = useState(false);

  // Drives this phase's AbortSignal. A useEffect cleanup aborts it on unmount, so
  // a teardown during the async read tears down the in-flight parse and every
  // owner-driven seam stops firing (no setState after unmount). Separate from the
  // run's controller: this one guards only acquisition.
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
    onWarning(undefined);

    const controller = new AbortController();
    abortRef.current = controller;
    const submitSignal = controller.signal;

    // Load the CSV and run the acceptor pre-flight BEFORE handing off: an
    // unsatisfiable file must block here so the run owner is never handed a
    // bundle, nothing is dialed, and the lifecycle never starts. `submitSignal`
    // guards against a teardown during the read.
    void (async () => {
      const csvResult = await loadCSVFile(files[0]).catch(
        (error: unknown): undefined => {
          if (!submitSignal.aborted) {
            onError({
              title: "Could not read your file",
              message: sanitizeErrorForDisplay(error),
            });
            // The read failed before any handoff: this is not an in-flight
            // exchange, so abort and release the controller (keeping the
            // unmount-cleanup invariant that the stored controller is the live
            // one) and re-enable submit.
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

      // Pre-flight for the acceptor: the CSV must satisfy the adopted linkage
      // terms the user consented to on the consent screen. A field whose column
      // the CSV lacks resolves to empty at exchange time and its keys produce no
      // strings -- a silent empty result indistinguishable from a legitimately
      // empty intersection. Detect it here, before any connection: block when no
      // key can match, warn when only some can. The inviter passes no
      // linkageTerms (it is the source of the terms and infers its own), so it
      // runs no pre-flight.
      if (linkageTerms !== undefined) {
        // No standardization is passed: the acceptor adopts only the inviter's
        // linkage terms and infers its standardization from its own CSV, so a
        // type-based check matches the run's actual satisfiability (the
        // standardization argument is for the config-driven invite path).
        const { unsatisfied, satisfiableKeyCount } =
          assessLinkageSatisfiability(columns, linkageTerms);
        // Gate on the key count, not unsatisfied.length: a key can be
        // unsatisfiable by referencing a field the terms never declare
        // (unsatisfied empty yet the key collapses), which satisfiableKeyCount
        // accounts for.
        if (satisfiableKeyCount < linkageTerms.linkageKeys.length) {
          // Partner-controlled field name and type: sanitize both for the alert,
          // which is rendered directly in JSX (not routed through
          // sanitizeErrorForDisplay). The detail is omitted when no declared
          // field is unproducible (keys are unsatisfiable only via undeclared
          // references).
          const detail =
            unsatisfied.length > 0
              ? " (missing: " +
                unsatisfied
                  .map(
                    (f) =>
                      `${sanitizeForDisplay(f.name)} (${sanitizeForDisplay(f.type)})`,
                  )
                  .join(", ") +
                ")"
              : "";
          if (satisfiableKeyCount === 0) {
            // Block: no linkage key can match, so the exchange would produce a
            // silent empty result. Do NOT hand off -- nothing is dialed. Abort
            // and release the controller (keeping the unmount-cleanup invariant
            // that the stored controller is the live one) and re-enable submit so
            // the user can choose a file that carries the required columns.
            onError({
              title: "This file cannot be linked",
              message:
                "Your CSV cannot satisfy any of this invitation's linkage " +
                `keys${detail}. No matches are possible. Upload a file that ` +
                "includes columns for the required field types.",
            });
            controller.abort();
            abortRef.current = undefined;
            setSubmitted(false);
            return;
          }
          onWarning({
            title: "Partial CSV coverage",
            message:
              `Your CSV cannot satisfy all of this invitation's linkage keys${detail}. ` +
              "Keys that depend on the missing fields will be inactive for this " +
              "exchange; other keys will proceed normally.",
          });
        }
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
