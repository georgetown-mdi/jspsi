import { useEffect, useState } from "react";

import { Anchor, Button, Loader } from "@mantine/core";
import { Link, useNavigate } from "@tanstack/react-router";

import { listManagedExchanges } from "@psi/managedExchangeStore";

import { BenchPage } from "./BenchPage";
import { savedExchangeRows } from "./savedExchangesModel";
import styles from "./bench.module.css";

import type { SavedExchangeRow } from "./savedExchangesModel";

/**
 * The saved-exchanges affordance: a minimal list of stored managed-exchange
 * records -- label, side, and a one-line last-run status -- each with a run
 * action that opens the attended re-run surface. It is the entry point into a
 * re-run from a stored record, reached from the lobby.
 *
 * Deliberately NOT the management list: no add/remove, no per-exchange detail,
 * no edit. Those are separate items. The list reads the store once on mount and
 * derives its rows through the pure {@link savedExchangeRows}.
 */
export function SavedExchanges() {
  const navigate = useNavigate();
  const [rows, setRows] = useState<Array<SavedExchangeRow>>();
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let live = true;
    listManagedExchanges()
      .then((records) => {
        if (live) setRows(savedExchangeRows(records, Date.now()));
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
          <p className={styles.sub}>
            You have no saved exchanges yet. When you set up or accept an
            exchange, choose &quot;Manage this exchange&quot; to save it here.
          </p>
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
                </div>
                <Button
                  variant="default"
                  onClick={() =>
                    void navigate({ to: "/saved/$id", params: { id: row.id } })
                  }
                >
                  Run
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
