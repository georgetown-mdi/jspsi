import { useEffect, useState } from "react";

import { Alert, Anchor, Button, FileButton, Loader } from "@mantine/core";
import { Link, useNavigate } from "@tanstack/react-router";

import {
  listManagedExchanges,
  openManagedExchangeDatabase,
  requestPersistentStorage,
} from "@psi/managedExchangeStore";
import { MAX_ARTIFACT_IMPORT_BYTES } from "@psi/managedExchangeArtifact";
import { importManagedExchange } from "@psi/managedExchangeImport";
import { listManagedLocalState } from "@psi/managedLocalState";

import { BenchLobby } from "./BenchLobby";
import { BenchPage } from "./BenchPage";
import { loadSavedExchanges } from "./savedExchangesLoad";
import styles from "./bench.module.css";

import type { SavedExchangeRow } from "./savedExchangesModel";
import type { SavedExchangesLoad } from "./savedExchangesLoad";

/** Run the managed-exchange home load once on mount, cancelling its state write if
 * the component unmounts before the reads settle. Returns `undefined` while the read
 * is in flight, then one of the {@link SavedExchangesLoad} outcomes. */
function useSavedExchangesLoad(): SavedExchangesLoad | undefined {
  const [load, setLoad] = useState<SavedExchangesLoad>();
  useEffect(() => {
    let live = true;
    void loadSavedExchanges({
      openStore: openManagedExchangeDatabase,
      listExchanges: listManagedExchanges,
      listLocalState: listManagedLocalState,
      now: Date.now,
    }).then((result) => {
      if (live) setLoad(result);
    });
    return () => {
      live = false;
    };
  }, []);
  return load;
}

/**
 * The app's home route at `/`: the management interface is the home only once a
 * recurring exchange exists here, so this reads the store and routes on the outcome,
 * inline with no URL redirect. It holds an explicit loading state while the read
 * settles, then: a `ready` store with one or more rows renders the list surface; an
 * empty `ready` store renders the quick (invite/accept) path, so a first-run visitor
 * lands on the one-off flow rather than an empty list; an `unavailable` store (this
 * browser cannot store recurring exchanges) likewise renders the quick path, with no
 * scary banner on landing; a `failed` store (it opened but its records cannot be read)
 * renders the read-failed surface, never the quick path -- records likely exist, and
 * silently showing the lobby would hide that.
 *
 * The canonical always-list route is `/saved` ({@link SavedExchanges}); a visitor
 * whose browser was evicted lands here on the quick path, and the quick path links to
 * `/saved` so the empty state's restore-from-backup affordance stays discoverable.
 */
export function SavedExchangesHome() {
  const load = useSavedExchangesLoad();

  if (load === undefined)
    return (
      <BenchPage>
        <main className={styles.lobby}>
          <Loader />
        </main>
      </BenchPage>
    );
  if (
    load.kind === "unavailable" ||
    (load.kind === "ready" && load.rows.length === 0)
  )
    return <BenchLobby />;
  return <SavedExchangesSurface load={load} />;
}

/**
 * The managed-exchange list, the canonical always-list route at `/saved`. It lists the
 * recurring exchanges stored in this browser -- label, side, a one-line last-run
 * status, and the derived backup state -- each with a run action that opens the
 * attended re-run surface, above a standing entry into the quick (invite/accept) path.
 *
 * Unlike the home route, it renders the full surface unconditionally: the loading
 * state, then the exchanges, the designed empty state, the read-failed state, or --
 * when the store cannot be opened at all (private mode with storage blocked, an engine
 * without IndexedDB) -- the degrade message. This keeps eviction recovery discoverable:
 * a first-run visitor is routed to the quick path at `/`, and the quick path links here
 * so the restore-from-backup affordance in the empty state stays reachable.
 *
 * The empty state is a designed first-run surface, not a blank list: it explains what a
 * managed exchange is and offers creating one, accepting a recurring invitation, and a
 * standing import affordance -- a wholesale eviction erases the evidence anything
 * existed, so restore-from-backup lives here rather than only behind a detected loss
 * (see docs/MANAGED_EXCHANGE.md, "Eviction recovery is the import flow").
 *
 * Deliberately NOT the management list: no add/remove, no per-exchange detail, no edit.
 * Those are separate items. Each row joins its record to the local sibling state (the
 * backup marker and any spent state): a spent record shows no Run action and names its
 * handoff date.
 */
export function SavedExchanges() {
  const load = useSavedExchangesLoad();

  if (load?.kind === "unavailable") return <StorageUnavailable />;

  return <SavedExchangesSurface load={load} />;
}

/** The list surface itself: the loading loader, the exchanges, the designed empty
 * state, or the read-failed state, inside the shared page frame. Its prop type
 * excludes the `unavailable` case -- both routes intercept that ahead of it (the home
 * route to the quick path, the list route to its degrade message), so the surface never
 * receives it. */
function SavedExchangesSurface({
  load,
}: {
  load: Exclude<SavedExchangesLoad, { kind: "unavailable" }> | undefined;
}) {
  const navigate = useNavigate();

  return (
    <BenchPage>
      <main className={styles.lobby}>
        <div className={styles.wordmark}>psilink</div>
        <h1>Recurring exchanges</h1>
        <p className={styles.sub}>
          Exchanges you saved to run again with the same partner, stored in this
          browser. Choose one to run it again without a new invitation.
        </p>
        {load === undefined ? (
          <Loader />
        ) : load.kind === "failed" ? (
          <SavedExchangesFailed />
        ) : load.rows.length === 0 ? (
          <SavedExchangesEmpty />
        ) : (
          <>
            <ul className={styles.savedList}>
              {load.rows.map((row) => (
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
            <p className={`${styles.sub} ${styles.small}`}>
              Need a one-off instead?{" "}
              <Anchor inherit component={Link} to="/quick">
                Set up or accept an exchange
              </Anchor>{" "}
              without saving it here.
            </p>
          </>
        )}
      </main>
    </BenchPage>
  );
}

/** The store-unavailable degrade: when the managed store cannot be opened at all
 * (private mode with storage blocked, an engine without IndexedDB), the list route
 * cannot list anything, so it hands the operator the quick path -- they can still run
 * a one-off exchange -- rather than erroring. */
function StorageUnavailable() {
  return (
    <BenchPage>
      <main className={styles.lobby}>
        <div className={styles.wordmark}>psilink</div>
        <h1>Recurring exchanges</h1>
        <p className={styles.sub}>
          This browser cannot store recurring exchanges -- private browsing may
          be blocking storage, or this browser does not support it. You can
          still run a one-off exchange.
        </p>
        <p>
          <Button component={Link} to="/quick">
            Set up or accept a one-off exchange
          </Button>
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

/** The first-run empty state: a designed surface, not a blank list. It explains what a
 * managed exchange is, offers creating one and accepting a recurring invitation into the
 * quick path, and carries the standing import affordance for post-eviction recovery. A
 * wholesale eviction cannot be told from a first visit, so the import is offered here
 * standing rather than behind a detected loss. */
function SavedExchangesEmpty() {
  return (
    <>
      <p className={styles.sub}>
        A recurring exchange is a saved partnership with someone you exchange
        with again and again: its terms and a rotating shared secret are stored
        in this browser, so you can run it without a new invitation each time.
        You have none saved yet.
      </p>
      <p>
        <Button component={Link} to="/quick">
          Set up a recurring exchange
        </Button>
      </p>
      <p className={`${styles.sub} ${styles.small}`}>
        Were you sent a recurring invitation?{" "}
        <Anchor inherit component={Link} to="/accept">
          Accept it
        </Anchor>{" "}
        and choose &quot;Manage this exchange&quot; to save it here.
      </p>
      <RestoreFromBackup />
    </>
  );
}

/** The read-failed surface: the list opened but its records could not be read, so it
 * cannot show them. The read rejects wholesale on any single invalid record
 * ({@link listManagedExchanges}), so a fresh import cannot mend the list here -- the bad
 * record still fails the read. What the import can still do is store the exchange it
 * carries and take the operator straight to its run surface, sidestepping the unreadable
 * list. The copy is honest about that: the same restore affordance the empty state
 * carries, under a lead that does not promise the list will then display. */
function SavedExchangesFailed() {
  return (
    <>
      <p className={styles.sub}>
        Your recurring exchanges could not be read from this browser. If you
        have a backup file, you can still restore an exchange and go straight to
        running it.
      </p>
      <RestoreFromBackup />
    </>
  );
}

/** The standing restore-from-backup import affordance, shared by the empty state and the
 * read-failed surface so both render one markup. A successful import takes the operator
 * to the imported exchange's run surface, so it is a way forward even when the list read
 * itself cannot be mended. */
function RestoreFromBackup() {
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
  );
}
