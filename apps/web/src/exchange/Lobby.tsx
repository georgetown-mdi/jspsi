import { useEffect, useState } from "react";

import { Anchor, Button, Textarea, VisuallyHidden } from "@mantine/core";
import { Link, useNavigate } from "@tanstack/react-router";

import {
  listManagedExchanges,
  openManagedExchangeDatabase,
} from "@psi/managedExchangeStore";
import { listManagedLocalState } from "@psi/managedLocalState";
import { tokenFromInput } from "@psi/invitation";

import { isConsoleBuild } from "@utils/clientConfig";
import { useOnlineStatus } from "@components/useOnlineStatus";

import { OFFLINE_EXCHANGE_REASON } from "@psi/offlineExchangeGate";

import { AppPage } from "@components/AppPage";
import { loadSavedExchanges } from "@recurring/savedExchangesLoad";
import styles from "@styles/app.module.css";

import { FILE_ASSURANCE_LINE } from "./fileAssurance";
import { downloadSampleCsvs } from "./sampleData";

/**
 * The quick path's screen: two primary actions side by side -- invite someone to a
 * one-off exchange, or accept an invitation you were sent -- above the standing how-it-works
 * explanation. It has its own route at `/quick` and is also the home route's
 * first-run landing (an empty or unavailable managed store at `/` renders it
 * directly, with no redirect); the recurring-exchange list lives at `/saved`,
 * which this screen links to on a hosted build. A console build has no recurring
 * surface, so it omits that pointer.
 */
export function Lobby() {
  const navigate = useNavigate();
  const [invitation, setInvitation] = useState("");
  const [invitationError, setInvitationError] = useState<string>();

  // Advisory only. Every entry below navigates or reads -- authoring an exchange
  // file for the command-line tool reaches no partner, and neither does reading
  // an invitation -- so the block belongs to the create or run each flow ends in,
  // which holds it. Saying so here spares an operator the walk to a gate they
  // will meet after choosing a file. Only the offline direction is read: being
  // online is no promise the partner is there (see @utils/networkStatus).
  const online = useOnlineStatus();

  // Whether this browser already holds a saved recurring exchange, read once
  // on mount. Gates the "run it again" pointer below; the restore-from-backup
  // pointer stands regardless (see savedExchangesLoad / /saved). Stays undefined
  // until the async store read settles, so the pointer slot renders nothing
  // rather than flashing the wrong empty-state copy (the /quick path reaches
  // this screen with a populated store).
  const [hasSavedExchanges, setHasSavedExchanges] = useState<boolean>();
  useEffect(() => {
    // The managed store is not a console concept, and a console build renders no
    // pointer to it, so it reads nothing.
    if (isConsoleBuild()) return;
    let live = true;
    void loadSavedExchanges({
      openStore: openManagedExchangeDatabase,
      listExchanges: listManagedExchanges,
      listLocalState: listManagedLocalState,
      now: Date.now,
    }).then((result) => {
      if (live)
        setHasSavedExchanges(result.kind === "ready" && result.rows.length > 0);
    });
    return () => {
      live = false;
    };
  }, []);

  // "Review invitation" peels the token out of whatever was pasted -- a bare code
  // or a deep-link URL -- via the shared tokenFromInput helper, and routes to the
  // accept console with the token in the URL fragment, never a search param. An
  // empty extraction shows the inline field error and does not navigate. The
  // button itself is disabled until the field holds a usable token (see below),
  // so this guard only covers a submit that slips past that disabled state.
  function reviewInvitation() {
    const token = tokenFromInput(invitation);
    if (token === "") {
      setInvitationError("An invitation is required");
      return;
    }
    void navigate({ to: "/accept", hash: token });
  }

  const invitationToken = tokenFromInput(invitation);

  // A full navigation, not the SPA Link: the console reads `?demo=1` from the
  // real URL on mount, and the route has no typed search schema to hold it.
  function loadSample() {
    downloadSampleCsvs();
    window.location.assign("/exchange?demo=1");
  }

  return (
    <AppPage>
      <main className={styles.lobby}>
        <h1>psilink - private record linkage</h1>
        <p className={styles.tagline}>
          Find the records you both hold - without either of you seeing the
          other&apos;s data.
        </p>
        {FILE_ASSURANCE_LINE !== undefined && (
          <p className={`${styles.sub} ${styles.small}`}>
            {FILE_ASSURANCE_LINE}
          </p>
        )}
        <VisuallyHidden component="h2">
          Start a private data exchange
        </VisuallyHidden>
        <div className={styles.lobbyActions}>
          <div className={styles.actionCard}>
            <h3>Invite someone to exchange data</h3>
            <p className={`${styles.small} ${styles.sub}`}>
              Choose a file, confirm what you disclose, and share an invitation.
              Default configuration comes from your file and can be customized
              if needed.
            </p>
            <p>
              <Button component={Link} to="/exchange">
                Create an invitation
              </Button>
            </p>
          </div>
          <div className={styles.actionCard}>
            <h3>Accept an invitation you were sent</h3>
            <Textarea
              aria-label="Invitation"
              description="Paste the invitation your partner sent to you"
              placeholder="https://...#... or the bare code"
              autosize
              minRows={2}
              value={invitation}
              error={invitationError}
              errorProps={{ role: "alert" }}
              onChange={(event) => {
                setInvitation(event.currentTarget.value);
                if (invitationError !== undefined)
                  setInvitationError(undefined);
              }}
            />
            <p>
              <Button
                variant="outline"
                mt="sm"
                disabled={invitationToken === ""}
                onClick={reviewInvitation}
              >
                Review invitation
              </Button>
            </p>
          </div>
          {/* The console's third path: a direct exchange the two parties arranged
              out of band (a shared server, no invitation). Console-only -- it drives
              the console's job API, which a hosted deployment does not run. */}
          {isConsoleBuild() && (
            <div className={styles.actionCard}>
              <h3>Run an exchange you have already arranged</h3>
              <p className={`${styles.small} ${styles.sub}`}>
                You and your partner agreed on a server out of band. Choose a
                file, confirm the terms your file produces, and run - no
                invitation needed.
              </p>
              <p>
                <Button component={Link} to="/direct" variant="outline">
                  Run a direct exchange
                </Button>
              </p>
            </div>
          )}
        </div>
        {!online && (
          <p className={`${styles.sub} ${styles.small}`}>
            {OFFLINE_EXCHANGE_REASON} Reading an invitation and authoring an
            exchange file for the command-line tool reach no partner, so those
            stay open; each flow states this again at the create or run that
            would start the exchange.
          </p>
        )}
        <p className={`${styles.sub} ${styles.small}`}>
          First time here?{" "}
          <Anchor
            inherit
            href="https://github.com/georgetown-mdi/jspsi#readme"
            target="_blank"
            rel="noreferrer"
          >
            Instructions and documentation
          </Anchor>{" "}
          cover what psilink does, how to run an exchange, and the sample data
          for practicing.
        </p>
        <p className={`${styles.sub} ${styles.small}`}>
          No data to link yet?{" "}
          <Anchor inherit component="button" type="button" onClick={loadSample}>
            Start with sample data
          </Anchor>{" "}
          seeds an exchange with synthetic records and downloads the two CSVs so
          you can run both sides.
        </p>
        {!isConsoleBuild() &&
          (hasSavedExchanges === undefined ? null : hasSavedExchanges ? (
            <p className={`${styles.sub} ${styles.small}`}>
              Saved an exchange to run again?{" "}
              <Anchor inherit component={Link} to="/saved">
                Recurring exchanges
              </Anchor>{" "}
              lists the ones stored in this browser so you can run one without a
              new invitation, and is where you restore one from a backup file if
              this browser was cleared.
            </p>
          ) : (
            <p className={`${styles.sub} ${styles.small}`}>
              Cleared this browser, or moving to a new device?{" "}
              <Anchor inherit component={Link} to="/saved">
                Recurring exchanges
              </Anchor>{" "}
              is where you restore a saved exchange from a backup file.
            </p>
          ))}
        <div className={styles.howItWorks}>
          <p>
            <strong>How it works.</strong> Each of you keeps your file on your
            own machine. psilink compares cryptographic fingerprints of the
            fields you match on - a private set intersection - so only the
            records you both hold are revealed, and only to the people the terms
            name. Your browser connects directly to your partner&apos;s.
          </p>
        </div>
      </main>
    </AppPage>
  );
}
