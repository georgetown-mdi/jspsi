import { useCallback, useEffect, useState } from "react";

import {
  Alert,
  Anchor,
  Button,
  FileButton,
  Loader,
  Modal,
} from "@mantine/core";
import { Link, useNavigate } from "@tanstack/react-router";

import {
  ManagedImportCustodyUnreadableError,
  ManagedImportHandedOffError,
  importManagedExchange,
} from "@psi/managed/managedExchangeImport";
import {
  deleteManagedExchange,
  listManagedExchanges,
  listManagedExchangesDiagnostic,
  openManagedExchangeDatabase,
  requestPersistentStorage,
} from "@psi/managed/managedExchangeStore";
import { MAX_ARTIFACT_IMPORT_BYTES } from "@psi/managed/managedExchangeArtifact";
import { listManagedLocalState } from "@psi/managed/managedLocalState";

import { Lobby } from "@exchange/Lobby";

import { AppPage } from "@components/AppPage";
import styles from "@styles/app.module.css";

import {
  CUSTODY_UNREADABLE_IMPORT_TITLE,
  HANDED_OFF_IMPORT_TITLE,
  custodyUnreadableImportReason,
  handedOffImportReason,
} from "./managedHandoffGate";
import {
  IMPORT_FAILURE_TITLE,
  UNREADABLE_IMPORT_REASON,
  importFailureReason,
} from "./managedImportFailure";
import { BetweenVisitNotifications } from "./BetweenVisitNotifications";
import { loadSavedExchanges } from "./savedExchangesLoad";
import { managedImportGrantNotice } from "./managedImportGrantNotice";
import { recoveryRows } from "./savedExchangesRecovery";

import type { ManagedImportGrantNotice } from "./managedImportGrantNotice";
import type { ManagedSpentHandoff } from "@psi/managed/managedLocalState";
import type { RecoveryRow } from "./savedExchangesRecovery";
import type { SavedExchangeRow } from "./savedExchangesModel";
import type { SavedExchangesLoad } from "./savedExchangesLoad";

/** Run the managed-exchange home load on mount and on demand, cancelling its state
 * write if the component unmounts before the reads settle. Returns the current
 * {@link SavedExchangesLoad} (or `undefined` while a read is in flight) and a
 * `reload` that re-runs the load -- the delete affordance calls it so a delete that
 * removes the offending record recovers a now-readable list to the normal surface. */
function useSavedExchangesLoad(): {
  load: SavedExchangesLoad | undefined;
  reload: () => void;
} {
  const [load, setLoad] = useState<SavedExchangesLoad>();
  const [nonce, setNonce] = useState(0);
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
  }, [nonce]);
  const reload = useCallback(() => {
    setLoad(undefined);
    setNonce((current) => current + 1);
  }, []);
  return { load, reload };
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
  const { load, reload } = useSavedExchangesLoad();

  if (load === undefined)
    return (
      <AppPage>
        <main className={styles.lobby}>
          <Loader />
        </main>
      </AppPage>
    );
  if (
    load.kind === "unavailable" ||
    (load.kind === "ready" && load.rows.length === 0)
  )
    return <Lobby />;
  return <SavedExchangesSurface load={load} reload={reload} />;
}

/**
 * The managed-exchange list, the canonical always-list route at `/saved`. It lists the
 * recurring exchanges stored in this browser -- label, side, a one-line last-run
 * status, the schedule's due-ness where one is agreed, and the derived backup state
 * -- each with a run action that opens the attended re-run surface, above a standing
 * entry into the quick (invite/accept) path.
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
 * NOT the management list: no add/remove, no per-exchange detail, no edit.
 * Those are separate items. Each row joins its record to the local sibling state (the
 * backup marker and any spent state): a spent record shows no Run action and names its
 * handoff date.
 */
export function SavedExchanges() {
  const { load, reload } = useSavedExchangesLoad();

  if (load?.kind === "unavailable") return <StorageUnavailable />;

  return <SavedExchangesSurface load={load} reload={reload} />;
}

/** The list surface itself: the loading loader, the exchanges, the designed empty
 * state, or the read-failed state, inside the shared page frame. Its prop type
 * excludes the `unavailable` case -- both routes intercept that ahead of it (the home
 * route to the quick path, the list route to its degrade message), so the surface never
 * receives it. */
function SavedExchangesSurface({
  load,
  reload,
}: {
  load: Exclude<SavedExchangesLoad, { kind: "unavailable" }> | undefined;
  reload: () => void;
}) {
  return (
    <AppPage>
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
          <SavedExchangesFailed reload={reload} />
        ) : load.rows.length === 0 ? (
          <SavedExchangesEmpty />
        ) : (
          <SavedExchangesList rows={load.rows} reload={reload} />
        )}
      </main>
    </AppPage>
  );
}

/** The populated run list: a row per stored exchange with a run/open action and the
 * always-available delete, above a primary create entry into the invite/configure
 * flow (where saving as recurring happens at share time) and the one-off quick-path
 * alternative. Deleting a row calls `reload`, so the list reflects the removal without
 * a page navigation. */
function SavedExchangesList({
  rows,
  reload,
}: {
  rows: Array<SavedExchangeRow>;
  reload: () => void;
}) {
  const navigate = useNavigate();

  return (
    <>
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
              <ScheduleLines row={row} />
              <BackupLine row={row} />
            </div>
            <div className={styles.savedRowActions}>
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
              <DeleteExchangeButton
                id={row.id}
                label={row.label}
                backedUp={row.backup.kind === "backed-up"}
                handoff={row.spentHandoff}
                onDeleted={reload}
              />
            </div>
          </li>
        ))}
      </ul>
      <BetweenVisitNotifications />
      <p>
        <Button component={Link} to="/exchange" variant="default">
          Set up a recurring exchange
        </Button>
      </p>
      <p className={`${styles.sub} ${styles.small}`}>
        Need a one-off instead?{" "}
        <Anchor inherit component={Link} to="/quick">
          Set up or accept an exchange
        </Anchor>{" "}
        without saving it here.
      </p>
    </>
  );
}

/** The store-unavailable degrade: when the managed store cannot be opened at all
 * (private mode with storage blocked, an engine without IndexedDB), the list route
 * cannot list anything, so it hands the operator the quick path -- they can still run
 * a one-off exchange -- rather than erroring. */
function StorageUnavailable() {
  return (
    <AppPage>
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
    </AppPage>
  );
}

/** The per-row schedule lines, for a row whose record holds an agreed
 * schedule: where the recurrence stands, quietly, and -- once the record's
 * consecutive-miss count reaches the escalation threshold -- the coordination
 * line, the one state here an operator acts on. A row with no schedule renders
 * nothing.
 *
 * The coordination line takes the caution treatment, matching the yellow Alert
 * the exchange's own surface uses for the same state, rather than the failure
 * red (docs/MANAGED_EXCHANGE.md, "Repeated misses surface, they do not
 * auto-pause"). */
function ScheduleLines({ row }: { row: SavedExchangeRow }) {
  if (row.schedule === undefined) return null;
  return (
    <>
      <span className={`${styles.small} ${styles.sub}`}>
        {row.schedule.dueLine}
      </span>
      {row.schedule.missLine !== undefined && (
        <span
          className={`${styles.small} ${styles.statusLine} ${styles.statusLineWarn}`}
        >
          {row.schedule.missLine}
        </span>
      )}
    </>
  );
}

/** The per-row backup line: a quiet "backed up as of <date>" when a current export
 * exists, or the actionable "Back up this exchange" when none does. A spent row
 * names its handoff instead, with the recovery that hand-off actually has: a
 * migration's artifact imports back, while the command-line files do not. */
function BackupLine({ row }: { row: SavedExchangeRow }) {
  if (row.spentAsOf !== undefined)
    return (
      <span className={`${styles.small} ${styles.sub}`}>
        {row.spentHandoff === "command-line"
          ? `Handed off to the command line ${row.spentAsOf}. It runs from the files you saved.`
          : `Handed off ${row.spentAsOf}. Import the backup to run it here again.`}
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

/** The always-available per-row delete: a primary action with one simple confirm.
 * The confirm names the exchange, names what the delete takes with it that the
 * operator may still want -- the accounting of disclosures, and any results a
 * scheduled run left for them -- and states a custody note for each thing the
 * delete leaves behind: an exported backup file (the row's backed-up state), and
 * the files a hand-off saved elsewhere ({@link handoff}), which keep running the
 * exchange from the machine that holds them. Deletion removes everything the
 * browser holds for the exchange in one step ({@link deleteManagedExchange}),
 * local and unilateral, so the confirm says the partner is not notified.
 * Exported so the per-exchange detail surface reuses this one confirm component. */
export function DeleteExchangeButton({
  id,
  label,
  backedUp,
  handoff,
  onDeleted,
}: {
  id: string;
  label: string;
  /** Whether a backup was exported for this exchange (the custody note shows only
   * then; a never-exported exchange has nothing under the operator's custody). */
  backedUp: boolean;
  /** The hand-off that spent this copy, when the surface knows of one: its own
   * custody note then names what that hand-off left running elsewhere. Absent for a
   * live copy and for a migration spend, which records no hand-off. */
  handoff?: ManagedSpentHandoff;
  onDeleted: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);
  const named = label === "" ? "this exchange" : `"${label}"`;

  function confirmDelete() {
    setDeleting(true);
    setDeleteFailed(false);
    void (async () => {
      try {
        await deleteManagedExchange(id);
        onDeleted();
        setConfirming(false);
      } catch {
        // A rejected delete (transaction abort, quota, a blocked open) leaves the
        // row standing: keep the modal open and report the failure so the operator
        // can retry rather than the row silently vanishing from confirm.
        setDeleteFailed(true);
      } finally {
        setDeleting(false);
      }
    })();
  }

  return (
    <>
      <Button
        variant="subtle"
        color="red"
        disabled={deleting}
        onClick={() => {
          setDeleteFailed(false);
          setConfirming(true);
        }}
      >
        Delete
      </Button>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title="Remove from this browser"
        centered
        transitionProps={{ duration: 0 }}
      >
        <p>
          Delete {named}? This removes everything this browser holds for it --
          the terms, the stored secret, its run history, its accounting of
          disclosures, and any results a scheduled run left here for you to
          download -- in one step. It cannot be undone here. Download those
          results and export the accounting first if you need to keep them.
        </p>
        <p className={`${styles.small} ${styles.sub}`}>
          This only removes your copy: your partner is not notified, and their
          own copy stands until they remove it or you re-invite.
        </p>
        {backedUp && (
          <p className={`${styles.small} ${styles.sub}`}>
            A backup file you exported stays in your custody -- delete it
            yourself if you no longer want it. It remains a credential until the
            partnership rotates past it.
          </p>
        )}
        {handoff === "command-line" && (
          <p className={`${styles.small} ${styles.sub}`}>
            The psilink.yaml and .psilink.key you saved still run this exchange.
            Deleting it here neither retires them nor stops the runs you
            scheduled -- remove the scheduled command and delete those two files
            on that machine to end it.
          </p>
        )}
        {deleteFailed && (
          <Alert color="red" title="That exchange could not be removed" mb="sm">
            Removing it from this browser failed. Nothing was deleted; try
            again.
          </Alert>
        )}
        <div className={styles.savedRowActions} style={{ marginTop: "1rem" }}>
          <Button variant="default" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            color="red"
            variant="light"
            loading={deleting}
            onClick={confirmDelete}
          >
            Delete
          </Button>
        </div>
      </Modal>
    </>
  );
}

/** The first-run empty state: a designed surface, not a blank list. It explains what a
 * managed exchange is, offers creating one and accepting a recurring invitation into the
 * quick path, and includes the standing import affordance for post-eviction recovery. A
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
        and choose &quot;Save as a recurring exchange&quot; to save it here.
      </p>
      <RestoreFromBackup />
    </>
  );
}

/** The read-failed surface: the list opened but its records could not be read,
 * so the normal list ({@link listManagedExchanges}) rejects wholesale on the one
 * offending record. This surface adds a recovery listing built from a separate
 * diagnostic read ({@link listManagedExchangesDiagnostic}) that never rejects
 * wholesale: each stored entry appears with its label and side/date when
 * parseable, or "Unreadable record" when not, each with the same one-step
 * delete-by-key. A fresh import lands from this state, the store's reconciliation
 * skipping the entry it cannot parse, but it does not mend the list while that
 * record stands: the restore-from-backup affordance is a way straight to a run
 * surface, not the repair. */
function SavedExchangesFailed({ reload }: { reload: () => void }) {
  return (
    <>
      <p className={styles.sub}>
        Your recurring exchanges could not be read from this browser. One or
        more stored records is unreadable -- likely from an old app version.
        Remove the record below to recover the rest, or import a backup file.
      </p>
      <RecoveryListing reload={reload} />
      <RestoreFromBackup />
    </>
  );
}

/** The recovery listing on the read-failed surface: the diagnostic read's
 * per-entry result, each row with the one-step delete-by-key. It loads on mount
 * from the diagnostic read (which never rejects wholesale), so an unreadable
 * record is identifiable and discardable even when the normal list cannot load.
 * A delete calls `reload`, which re-runs the whole load. If the diagnostic read
 * itself fails (the store's own failure, not a single bad record), the listing
 * is simply omitted and the restore affordance below still stands. */
function RecoveryListing({ reload }: { reload: () => void }) {
  const [rows, setRows] = useState<Array<RecoveryRow>>();
  useEffect(() => {
    let live = true;
    void listManagedExchangesDiagnostic()
      .then((entries) => {
        if (live) setRows(recoveryRows(entries));
      })
      .catch(() => {
        if (live) setRows([]);
      });
    return () => {
      live = false;
    };
  }, []);

  if (rows === undefined) return <Loader />;
  if (rows.length === 0) return null;

  return (
    <ul className={styles.savedList}>
      {rows.map((row) => (
        <li key={row.id} className={styles.savedRow}>
          <div className={styles.savedRowMain}>
            <span className={styles.savedRowLabel}>{row.label}</span>
            {!row.unreadable && (
              <span className={`${styles.small} ${styles.sub}`}>
                {row.sideLabel}
                {row.lastRunAt !== undefined
                  ? ` - last run ${row.lastRunAt}`
                  : ""}
              </span>
            )}
          </div>
          <DeleteExchangeButton
            id={row.id}
            label={row.deleteLabel}
            backedUp={row.backedUp}
            handoff={row.spentHandoff}
            onDeleted={reload}
          />
        </li>
      ))}
    </ul>
  );
}

/** What the import affordance shows when nothing was imported: the alert's color,
 * its heading, and the reason under it. */
interface ImportFailureAlert {
  color: "red" | "yellow";
  title: string;
  reason: string;
}

/** Which alert an import failure is shown as. The two refusals the store raises are
 * about an exchange this browser holds rather than about the file, so each names the
 * exchange under its own heading; everything else is the file's own failure and is
 * shown as one. */
function importFailureAlert(error: unknown): ImportFailureAlert {
  if (error instanceof ManagedImportHandedOffError)
    return {
      color: "yellow",
      title: HANDED_OFF_IMPORT_TITLE,
      reason: handedOffImportReason(error.handoff, error.label),
    };
  if (error instanceof ManagedImportCustodyUnreadableError)
    return {
      color: "yellow",
      title: CUSTODY_UNREADABLE_IMPORT_TITLE,
      reason: custodyUnreadableImportReason(error.label),
    };
  return {
    color: "red",
    title: IMPORT_FAILURE_TITLE,
    reason: importFailureReason(error),
  };
}

/** The standing restore-from-backup import affordance, shared by the empty state and the
 * read-failed surface so both render one markup. A successful import puts the operator
 * on the imported exchange's run surface, so it is a way forward even when the list read
 * itself cannot be mended.
 *
 * A file the import will not take is refused with the reason its failure has
 * ({@link importFailureReason}): a document the artifact schema rejects can be a
 * newer build's export, which the operator cannot see from the file, while bytes
 * that do not parse at all leave only the file itself to check.
 *
 * An import the store refuses because its exchange was handed off from this browser is
 * not the unreadable-file failure and does not read as one: the file is fine and the
 * exchange is still here, running somewhere else, so that refusal names the exchange
 * and the recovery it actually has ({@link handedOffImportReason}). One refused
 * because this browser could not read what it saved beside the exchange reads the
 * same way and for the same reason, naming the store rather than the file
 * ({@link custodyUnreadableImportReason}).
 *
 * An import that could not bring the source's input file or output folder stops here
 * with that notice and a button onward, rather than taking the operator straight to
 * the exchange ({@link managedImportGrantNotice}): the grants are what they have to
 * choose again, and the notice is only read where it is shown. An import with nothing
 * to say goes straight through. */
function RestoreFromBackup() {
  const navigate = useNavigate();
  const [importFailure, setImportFailure] = useState<ImportFailureAlert>();
  const [grantNotice, setGrantNotice] = useState<{
    id: string;
    notice: ManagedImportGrantNotice;
  }>();

  function onFile(file: File | null) {
    if (file === null) return;
    setImportFailure(undefined);
    setGrantNotice(undefined);
    // Cap the file size before reading it: the artifact is a small JSON document, so
    // an over-cap file is refused with the unreadable-file copy rather than read into
    // memory ahead of the bounded parse.
    if (file.size > MAX_ARTIFACT_IMPORT_BYTES) {
      setImportFailure({
        color: "red",
        title: IMPORT_FAILURE_TITLE,
        reason: UNREADABLE_IMPORT_REASON,
      });
      return;
    }
    void (async () => {
      try {
        const source = await file.text();
        // Best-effort persistence on the imported record's origin, the same request
        // a create makes; a denied grant does not fail the import.
        void requestPersistentStorage();
        const { record, missingGrants } = await importManagedExchange(source);
        const notice = managedImportGrantNotice(missingGrants);
        if (notice !== undefined) {
          setGrantNotice({ id: record.id, notice });
          return;
        }
        await navigate({ to: "/saved/$id", params: { id: record.id } });
      } catch (error) {
        setImportFailure(importFailureAlert(error));
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
      {grantNotice !== undefined && (
        <Alert color="yellow" title={grantNotice.notice.title} mb="sm">
          <p className={styles.small}>{grantNotice.notice.lead}</p>
          <ul className={styles.small}>
            {grantNotice.notice.consequences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <Button
            mt="sm"
            onClick={() =>
              void navigate({
                to: "/saved/$id",
                params: { id: grantNotice.id },
              })
            }
          >
            Open this exchange
          </Button>
        </Alert>
      )}
      {importFailure !== undefined && (
        <Alert color={importFailure.color} title={importFailure.title} mb="sm">
          {importFailure.reason}
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
