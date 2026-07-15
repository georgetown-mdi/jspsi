import { useEffect, useRef, useState } from "react";

import { Alert, Button, FileButton, Loader } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import { fileSystemAccessSupported } from "@psi/managedInputHandle";
import { getManagedExchange } from "@psi/managedExchangeStore";
import { managedRerunCompletion } from "@psi/managedCompletionSurface";
import { runManagedExchangeInBrowser } from "@psi/managedRunDriver";
import { whenDiagnostic } from "@utils/diagnostics";

import { DonePanel, DownloadRow, WithheldResultInset } from "./BenchRunSurface";
import {
  classifyManagedRunFailure,
  managedRunRetryable,
} from "./managedRunLaunchModel";
import { BenchPage } from "./BenchPage";
import styles from "./bench.module.css";

import type { ManagedExchangeRecord } from "@psi/managedExchangeRecord";
import type { ManagedInputSource } from "@psi/managedInputHandle";
import type { ManagedRunFailure } from "./managedRunLaunchModel";
import type { RunOutputs } from "./runOutputs";

/**
 * The attended re-run surface: open a stored managed exchange, confirm the input,
 * and run -- reconnecting to the partner without a new invitation and completing
 * through the durable rotate-and-persist path. The pure run orchestration is
 * {@link runManagedExchangeInBrowser}; this thin host owns the record load, the
 * per-run input (the persisted handle, or a re-selection where none is held), and
 * folds the outcome into the completion surface.
 *
 * Deliberately minimal: it is the run affordance, not the management surface.
 * Deleting, editing, and per-exchange detail are separate items.
 */
export function ManagedRunSurface({ id }: { id: string }) {
  const [record, setRecord] = useState<ManagedExchangeRecord>();
  // The two load failures are distinct states with distinct recoveries: a MISSING
  // record (the store resolves undefined -- deleted or cleared) versus an
  // UNLOADABLE one (the read rejects: a stored record this app version can no
  // longer load, the documented app-upgrade case, whose recovery is re-invite --
  // see docs/spec/MANAGED_EXCHANGE_RECORD.md, "Versioning").
  const [loadFailure, setLoadFailure] = useState<"missing" | "unloadable">();
  const [reselected, setReselected] = useState<File>();
  const [running, setRunning] = useState(false);
  const [outputs, setOutputs] = useState<RunOutputs>();
  const [finishedAt, setFinishedAt] = useState<Date>();
  const [failure, setFailure] = useState<ManagedRunFailure>();

  // A single AbortController per in-flight run, aborted on unmount so a torn-down
  // surface stops the rendezvous, the connection, and the exchange.
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    let live = true;
    getManagedExchange(id)
      .then((loaded) => {
        if (!live) return;
        if (loaded === undefined) setLoadFailure("missing");
        else setRecord(loaded);
      })
      .catch(() => {
        if (live) setLoadFailure("unloadable");
      });
    return () => {
      live = false;
      abortRef.current?.abort();
      abortRef.current = undefined;
    };
  }, [id]);

  // Revoke the run's object URLs when they are replaced or the surface unmounts:
  // the results blob is matched-record PII and the keys blob is private material.
  useEffect(() => {
    if (outputs === undefined) return;
    return () => {
      if (outputs.resultsUrl !== undefined)
        window.URL.revokeObjectURL(outputs.resultsUrl);
      if (outputs.record !== undefined) {
        window.URL.revokeObjectURL(outputs.record.recordUrl);
        window.URL.revokeObjectURL(outputs.record.keysUrl);
      }
    };
  }, [outputs]);

  // Where the File System Access API exists and the record holds a handle, the run
  // reads through it (attended, so a gone permission may be re-prompted once);
  // otherwise the operator re-selects the file each run.
  const hasHandle =
    record?.inputFileHandle !== undefined && fileSystemAccessSupported();

  function inputSource(): ManagedInputSource | undefined {
    if (record === undefined) return undefined;
    if (hasHandle)
      return {
        kind: "handle",
        handle: record.inputFileHandle as FileSystemFileHandle,
        attendance: "attended",
      };
    if (reselected !== undefined) return { kind: "file", file: reselected };
    return undefined;
  }

  function run() {
    const source = inputSource();
    if (record === undefined || source === undefined || running) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setRunning(true);
    setFailure(undefined);
    void (async () => {
      try {
        const result = await runManagedExchangeInBrowser({
          record,
          source,
          signal: controller.signal,
          urls: {
            create: (blob) => window.URL.createObjectURL(blob),
            revoke: (url) => window.URL.revokeObjectURL(url),
          },
          // Attended: fail fast when a run is already in progress elsewhere,
          // surfacing the benign "already running" state rather than waiting.
          options: { lock: { ifAvailable: true } },
        });
        if (controller.signal.aborted) return;
        setOutputs(result.exchange);
        setFinishedAt(new Date());
      } catch (error) {
        if (controller.signal.aborted) return;
        // The raw error can embed partner-/server-controlled bytes and reads as an
        // internal message, so it stays in the dev-gated console; the surface shows
        // the classified, sanitized copy.
        whenDiagnostic(() => console.error(error));
        setFailure(classifyManagedRunFailure(error));
      } finally {
        if (!controller.signal.aborted) setRunning(false);
        abortRef.current = undefined;
      }
    })();
  }

  // The backup export is a later item's scope: no exporter is wired yet, so the
  // completion surface's refresh affordance is deferred (named, not silently
  // absent). When an exporter lands it is injected here.
  const completion = managedRerunCompletion();

  return (
    <BenchPage>
      <main className={styles.lobby}>
        {loadFailure === "missing" ? (
          <>
            <h1>Exchange not found</h1>
            <p className={styles.sub}>
              This exchange&apos;s browser copy was not found. It may have been
              deleted or cleared.
            </p>
            <SavedExchangesFoot />
          </>
        ) : loadFailure === "unloadable" ? (
          <>
            <h1>This exchange cannot be loaded</h1>
            <p className={styles.sub}>
              This exchange&apos;s stored copy can no longer be loaded by this
              version of the app. Re-invite your partner to set up the exchange
              again.
            </p>
            <SavedExchangesFoot />
          </>
        ) : record === undefined ? (
          <>
            <h1>Loading exchange</h1>
            <Loader />
          </>
        ) : outputs !== undefined ? (
          <>
            <h1>Run complete</h1>
            <DonePanel
              matchedRecordCount={outputs.matchedRecordCount}
              finishedAt={finishedAt}
            />
            {outputs.resultWithheld === true ? (
              <WithheldResultInset />
            ) : (
              <DownloadRow
                label="Download result"
                href={outputs.resultsUrl}
                fileName="results.csv"
              />
            )}
            {outputs.record !== undefined && (
              <>
                <DownloadRow
                  label="Download record (safe to share)"
                  href={outputs.record.recordUrl}
                  fileName={outputs.record.recordFileName}
                />
                <DownloadRow
                  label="Download verification keys"
                  caveat="keep private"
                  href={outputs.record.keysUrl}
                  fileName={outputs.record.keysFileName}
                />
              </>
            )}
            <div className={styles.callout}>
              <p className={styles.calloutLead}>Back up this exchange.</p>
              <p className={styles.small}>
                {completion.backupAffordance === "offer-refresh"
                  ? "This run rotated the stored secret, so your previous backup is now out of date. Download an updated backup to keep it current."
                  : "This run rotated the stored secret, so your previous backup is now out of date. Updating your backup will be available in a later version."}
              </p>
              {completion.backupAffordance === "offer-refresh" &&
                completion.backupHook !== undefined && (
                  <Button
                    mt="sm"
                    onClick={() =>
                      void completion.backupHook?.downloadUpdatedBackup()
                    }
                  >
                    Download updated backup
                  </Button>
                )}
            </div>
            <SavedExchangesFoot />
          </>
        ) : (
          <>
            <h1>{record.label === "" ? "Run this exchange" : record.label}</h1>
            <p className={styles.sub}>
              Run this exchange again with the same partner, without a new
              invitation. Your partner must run their side at the same time.
            </p>
            {failure !== undefined && (
              <Alert color="red" title={failure.title} mb="md">
                <span style={{ whiteSpace: "pre-line" }}>
                  {failure.message}
                </span>
              </Alert>
            )}
            {!hasHandle && (
              <div className={styles.callout}>
                <p className={styles.calloutLead}>Choose your input file.</p>
                <p className={styles.small}>
                  This browser did not keep a pointer to your file, so choose it
                  for this run. Its contents are read in your browser and never
                  stored.
                </p>
                <FileButton
                  accept="text/csv,.csv"
                  onChange={(file) => file !== null && setReselected(file)}
                >
                  {(props) => (
                    <Button mt="sm" variant="default" {...props}>
                      {reselected === undefined
                        ? "Choose file"
                        : `Chosen: ${reselected.name}`}
                    </Button>
                  )}
                </FileButton>
              </div>
            )}
            <p>
              <Button
                onClick={run}
                loading={running}
                disabled={inputSource() === undefined}
              >
                Run exchange
              </Button>
            </p>
            {running && (
              <p className={styles.sub}>
                Connecting to your partner and running the exchange. Keep this
                tab open.
              </p>
            )}
            {failure !== undefined && !managedRunRetryable(failure) && (
              <SavedExchangesFoot />
            )}
          </>
        )}
      </main>
    </BenchPage>
  );
}

/** The link back to the saved-exchanges list, shown at completion and on a
 * terminal (non-retryable) failure. */
function SavedExchangesFoot() {
  return (
    <div className={styles.workFoot}>
      <Button component={Link} to="/saved" variant="default">
        Back to saved exchanges
      </Button>
    </div>
  );
}
