import { Button, Textarea, VisuallyHidden } from "@mantine/core";
import { Link } from "@tanstack/react-router";

import { BenchPage } from "./BenchPage";
import styles from "./bench.module.css";

/**
 * The bench's landing screen: the two ways into an exchange, side by side --
 * set one up, or accept an invitation you were sent -- above the standing
 * how-it-works explanation. Mirrors the mockup's landing screen; both actions
 * currently lead to under-construction bench screens while the flows are
 * built out, and the current app at `/` remains the way to run an exchange.
 */
export function BenchLobby() {
  return (
    <BenchPage>
      <main className={styles.lobby}>
        <div className={styles.wordmark}>psilink</div>
        <h1>psilink - private record linkage</h1>
        <p className={styles.tagline}>
          Find the records you both hold - without either of you seeing the
          other&apos;s data.
        </p>
        <p className={`${styles.sub} ${styles.small}`}>
          Your file is processed entirely in your browser and it is never
          uploaded to our server.
        </p>
        <VisuallyHidden component="h2">
          Start a private data exchange
        </VisuallyHidden>
        <div className={styles.lobbyActions}>
          <div className={styles.actionCard}>
            <h3>Set up an exchange</h3>
            <p className={`${styles.small} ${styles.sub}`}>
              Choose a file, confirm what you disclose, and share an invitation.
              Recommended terms come from your file; most exchanges need nothing
              more.
            </p>
            <p>
              <Button component={Link} to="/bench/exchange">
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
            />
            <p>
              <Button
                variant="outline"
                component={Link}
                to="/bench/accept"
                mt="sm"
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
