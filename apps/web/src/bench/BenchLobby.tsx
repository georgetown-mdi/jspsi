import { useState } from "react";

import { Anchor, Button, Textarea, VisuallyHidden } from "@mantine/core";
import { Link, useNavigate } from "@tanstack/react-router";

import { tokenFromInput } from "@psi/invitation";

import { BenchPage } from "./BenchPage";
import { FILE_ASSURANCE_LINE } from "./fileAssurance";
import styles from "./bench.module.css";

/**
 * The app's landing screen: two primary actions side by side -- set up an
 * exchange, or accept an invitation you were sent -- above the standing
 * how-it-works explanation. Verifying a receipt is a secondary action, given
 * as an inline text link below the two cards rather than equal billing.
 */
export function BenchLobby() {
  const navigate = useNavigate();
  const [invitation, setInvitation] = useState("");
  const [invitationError, setInvitationError] = useState<string>();

  // "Review invitation" peels the token out of whatever was pasted -- a bare
  // code or a deep-link URL -- via the shared AcceptForm rule, and routes to the
  // accept bench with the token in the URL fragment, never a search param (the
  // same confidential-value handling the inviter's deep-link and the legacy
  // accept form use). An empty extraction shows the inline field error and does
  // not navigate. The button itself is disabled until the field holds a usable
  // token (see below), so this guard only covers a submit that slips past that
  // disabled state.
  function reviewInvitation() {
    const token = tokenFromInput(invitation);
    if (token === "") {
      setInvitationError("An invitation is required");
      return;
    }
    void navigate({ to: "/accept", hash: token });
  }

  const invitationToken = tokenFromInput(invitation);

  return (
    <BenchPage>
      <main className={styles.lobby}>
        <div className={styles.wordmark}>psilink</div>
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
            <h3>Set up an exchange</h3>
            <p className={`${styles.small} ${styles.sub}`}>
              Choose a file, confirm what you disclose, and share an invitation.
              Default terms come from your file; most exchanges need nothing
              more.
            </p>
            <p>
              <Button component={Link} to="/exchange">
                Set up an exchange
              </Button>
            </p>
          </div>
          <div className={styles.actionCard}>
            <h3>Accept an invitation you were sent</h3>
            <Textarea
              label="Invitation link or code"
              description="Paste the link or code your partner sent you"
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
        </div>
        <p className={`${styles.sub} ${styles.small}`}>
          Running exchanges on a schedule? The same setup saves an SFTP exchange
          file for the command-line tool.
        </p>
        <p className={`${styles.sub} ${styles.small}`}>
          Already have an exchange record?{" "}
          <Anchor component={Link} to="/verify">
            Verify a receipt
          </Anchor>{" "}
          checks it&apos;s internally consistent, entirely in your browser.
        </p>
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
    </BenchPage>
  );
}
