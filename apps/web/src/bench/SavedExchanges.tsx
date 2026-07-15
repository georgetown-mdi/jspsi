import { useEffect, useState } from "react";

import { Alert, Anchor, Button, FileButton, Loader } from "@mantine/core";
import { Link, useNavigate } from "@tanstack/react-router";

import {
  listManagedExchanges,
  requestPersistentStorage,
} from "@psi/managedExchangeStore";
import { MAX_ARTIFACT_IMPORT_BYTES } from "@psi/managedExchangeArtifact";
import { importManagedExchange } from "@psi/managedExchangeImport";
import { listManagedLocalState } from "@psi/managedLocalState";

import { BenchPage } from "./BenchPage";
import { savedExchangeRows } from "./savedExchangesModel";
import styles from "./bench.module.css";

import type { SavedExchangeRow } from "./savedExchangesModel";

/**
 * The saved-exchanges affordance: a minimal list of stored managed-exchange
 * records -- label, side, a one-line last-run status, and the derived backup
 * state -- each with a run action that opens the attended re-run surface. It is
 * the entry point into a re-run from a stored record, reached from the lobby.
 *
 * The list joins each record to its local sibling state (the backup marker and any
 * spent state): a spent record (handed off by a migration export) shows no Run
 * action and names its handoff date. The empty state carries the import affordance
 * standing -- a wholesale eviction erases the evidence anything existed, so restore-
 * from-backup lives here rather than only behind a detected loss (see
 * docs/MANAGED_EXCHANGE.md, "Eviction recovery is the import flow").
 *
 * Deliberately NOT the management list: no add/remove, no per-exchange detail, no
 * edit. Those are separate items. The list reads the two stores once on mount and
 * derives its rows through the pure {@link savedExchangeRows}.
 */
export function SavedExchanges() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Array<SavedExchangeRow>>();
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([listManagedExchanges(), listManagedLocalState()])
      .then(([records, localState]) => {
        if (live) setRows(savedExchangeRows(records, localState, Date.now()));
      })
      .catch(() => {
        if (live) setLoadFailed(true);
      });
    return () => {
      live = false;
    };
  }, []);

  return (
    <BenchPage>
      <main className={styles.lobby}>
        <div className={styles.wordmark}>psilink</div>
        <h1>Saved exchanges</h1>
        <p className={styles.sub}>
          Exchanges you saved to run again with the same partner, stored in this
          browser. Choose one to run it again without a new invitation.
        </p>
        {loadFailed ? (
          <p className={styles.sub}>
            Your saved exchanges could not be read from this browser.
          </p>
        ) : rows === undefined ? (
          <Loader />
        ) : rows.length === 0 ? (
          <SavedExchangesEmpty />
        ) : (
          <ul className={styles.savedList}>
            {rows.map((row) => (
              <li key={row.id} className={styles.savedRow}>
                <div className={styles.savedRowMain}>
                  <span className={styles.savedRowLabel}>
                    {row.label === "" ? "(unnamed exchange)" : row.label}
                  </span>
                  <span className={`${styles.small} ${styles.sub}`}>
                    {row.sideLabel} - {row.status}
                  </span>
                  <BackupLine row={row} />
                </div>
                <Button
                  variant={row.spentAsOf === undefined ? "default" : "subtle"}
                  onClick={() =>
                    void navigate({
                      to: "/saved/$id",
                      params: { id: row.id },
                    })
                  }
                >
                  {row.spentAsOf === undefined ? "Run" : "Open"}
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className={`${styles.sub} ${styles.small}`}>
          <Anchor inherit component={Link} to="/">
            Back to home
          </Anchor>
        </p>
      </main>
    </BenchPage>
  );
}

/** The per-row backup line: a quiet "backed up as of <date>" when a current export
 * exists, or the actionable "Back up this exchange" when none does. A spent row
 * names its handoff and the recovery instead. */
function BackupLine({ row }: { row: SavedExchangeRow }) {
  if (row.spentAsOf !== undefined)
    return (
      <span className={`${styles.small} ${styles.sub}`}>
        Handed off {row.spentAsOf}. Import the backup to run it here again.
      </span>
    );
  if (row.backup.kind === "backed-up")
    return (
      <span className={`${styles.small} ${styles.statusLineOk}`}>
        Backed up as of {row.backup.asOf}
      </span>
    );
  return (
    <span className={`${styles.small} ${styles.sub}`}>
      Back up this exchange
    </span>
  );
}

/** The empty state: the standing import affordance for post-eviction recovery, plus
 * the plain first-visit guidance. A wholesale eviction cannot be told from a first
 * visit, so the import is offered here standing rather than behind a detected loss. */
function SavedExchangesEmpty() {
  const navigate = useNavigate();
  const [importFailed, setImportFailed] = useState(false);

  function onFile(file: File | null) {
    if (file === null) return;
    setImportFailed(false);
    // Cap the file size before reading it: the artifact is a small JSON document, so
    // an over-cap file is rejected with the same import-failure copy rather than read
    // into memory ahead of the bounded parse.
    if (file.size > MAX_ARTIFACT_IMPORT_BYTES) {
      setImportFailed(true);
      return;
    }
    void (async () => {
      try {
        const source = await file.text();
        // Best-effort persistence on the imported record's origin, the same request
        // a create makes; a denied grant does not fail the import.
        void requestPersistentStorage();
        const installed = await importManagedExchange(source);
        await navigate({ to: "/saved/$id", params: { id: installed.id } });
      } catch {
        setImportFailed(true);
      }
    })();
  }

  return (
    <>
      <p className={styles.sub}>
        You have no saved exchanges in this browser. When you set up or accept
        an exchange, choose &quot;Manage this exchange&quot; to save it here.
      </p>
      <div className={styles.callout}>
        <p className={styles.calloutLead}>Restore from a backup.</p>
        <p className={styles.small}>
          If this browser was cleared or you are moving to a new device, import
          the backup file you exported to bring the exchange back here.
        </p>
        {importFailed && (
          <Alert color="red" title="That file could not be imported" mb="sm">
            The backup file could not be read. Check that you chose the backup
            file you exported and that it was not modified.
          </Alert>
        )}
        <FileButton accept="application/json,.json" onChange={onFile}>
          {(props) => (
            <Button mt="sm" variant="default" {...props}>
              Import a backup file
            </Button>
          )}
        </FileButton>
      </div>
    </>
  );
}
