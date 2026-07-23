import { useEffect, useState } from "react";

import { Anchor, Button, CopyButton } from "@mantine/core";

import {
  fetchRecurringHandoff,
  shellJoinCommand,
  windowsJoinCommand,
} from "@psi/recurringHandoff";

import { DisclosureSection } from "../components/DisclosureSection";
import styles from "./bench.module.css";

import type { JobHandoff } from "@jobs/handoff";

/** The full CLI reference the panel points at for the recurring-run details. */
const RECURRING_EXCHANGE_DOC_URL =
  "https://github.com/georgetown-mdi/jspsi/blob/main/docs/CLI.md#recurring-exchange";

/**
 * The recurring-run hand-off panel, shown in the completed-run block of every
 * console server-job seat (invite, accept, and Direct) and, collapsed, on the
 * strand-recovery panel's finished render. It fetches the job's portable,
 * secret-free hand-off from `GET /api/jobs/:jobId/handoff` and lays out exactly
 * what the operator carries from this prototyped run to a scheduled `psilink`
 * command line: the config or command template (the portable values from this run
 * filled in, machine-specific paths shown as placeholders), the key-file copy step
 * for an invitation run, cron and Windows Task Scheduler examples, and the caveats.
 *
 * It is purely informational and never blocks anything: while the fetch is in
 * flight, or if the hand-off is unavailable (a browser run, a forgotten job, any
 * fetch failure), it renders nothing. `collapsible` renders the same body behind an
 * initially-collapsed disclosure whose toggle is the summary -- the null gate still
 * fires first, so an unavailable hand-off leaves no dangling toggle.
 */
export function RecurringHandoff({
  jobId,
  collapsible = false,
}: {
  jobId: string;
  collapsible?: boolean;
}) {
  // undefined = still loading; null = unavailable (render nothing).
  const [handoff, setHandoff] = useState<JobHandoff | null | undefined>(
    undefined,
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetchRecurringHandoff(jobId).then((data) => {
      if (!cancelled) setHandoff(data);
    });
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (handoff === undefined || handoff === null) return null;

  if (collapsible)
    return (
      <DisclosureSection
        label="Run this on a schedule"
        open={open}
        onToggle={setOpen}
      >
        <HandoffBody handoff={handoff} />
      </DisclosureSection>
    );

  return (
    <section
      className={styles.callout}
      aria-labelledby="recurring-handoff-title"
    >
      <h2 id="recurring-handoff-title">Run this exchange on a schedule</h2>
      <HandoffBody handoff={handoff} />
    </section>
  );
}

/** The hand-off's content -- template, schedule snippets, and caveats -- shared by
 * the default expanded panel (under its own heading) and the collapsible
 * disclosure (under the toggle summary). */
function HandoffBody({ handoff }: { handoff: JobHandoff }) {
  const runCommand =
    handoff.template.kind === "command"
      ? shellJoinCommand(handoff.template.argv)
      : "psilink exchange input.csv results.csv";
  // Inside /TR "...", schtasks needs the command's own double quotes escaped as
  // \" so its argv parse preserves them for the scheduled cmd to re-read.
  const windowsScheduledCommand =
    handoff.template.kind === "command"
      ? windowsJoinCommand(handoff.template.argv).replace(/"/g, '\\"')
      : runCommand;

  return (
    <>
      <p className={styles.small}>
        This exchange ran here as a prototype. To run the recurring production
        version, run it from the command line with cron (Linux/macOS) or Task
        Scheduler (Windows). What carried over from this run is filled in below;
        set the file paths for the machine that will run the schedule.
      </p>

      {handoff.template.kind === "config" ? (
        <ConfigSteps
          yaml={handoff.template.yaml}
          usedKeyFile={handoff.usedKeyFile}
        />
      ) : (
        <CommandSteps command={runCommand} />
      )}

      <h3 className={styles.handoffHeading}>
        Schedule it (adjust the times and paths)
      </h3>
      <p className={styles.small}>cron (Linux/macOS), daily at 2am:</p>
      <HandoffCode
        code={`0 2 * * * cd /path/to/your/exchange-folder && ${runCommand}`}
        ariaLabel="cron schedule line"
      />
      <p className={styles.small}>Windows Task Scheduler, daily at 2am:</p>
      <HandoffCode
        code={`schtasks /Create /TN "psilink exchange" /SC DAILY /ST 02:00 /TR "cmd /c cd /d C:\\path\\to\\your\\exchange-folder && ${windowsScheduledCommand}"`}
        ariaLabel="Windows Task Scheduler command"
      />
      <p className={styles.small}>
        Both lines call psilink by name. Under cron&apos;s minimal PATH or a
        Task Scheduler service account it may not resolve, and fails quietly --
        use the full path to the psilink binary, or put it on the scheduling
        account&apos;s PATH.
      </p>

      <Caveats handoff={handoff} />

      <p className={styles.small}>
        See the{" "}
        <Anchor
          inherit
          href={RECURRING_EXCHANGE_DOC_URL}
          target="_blank"
          rel="noreferrer"
        >
          recurring exchange reference
        </Anchor>{" "}
        for the full command-line details.
      </p>
    </>
  );
}

/** The exchange-mode (invitation) steps: save the config, copy the key file, run
 * the exchange command. */
function ConfigSteps({
  yaml,
  usedKeyFile,
}: {
  yaml: string;
  usedKeyFile: boolean;
}) {
  return (
    <ol className={styles.handoffSteps}>
      <li>
        <p className={styles.handoffStepLabel}>
          Save this as psilink.yaml in a folder on the scheduling machine
        </p>
        <HandoffCode code={yaml} ariaLabel="psilink.yaml configuration" />
      </li>
      {usedKeyFile && (
        <li>
          <p className={styles.handoffStepLabel}>
            Copy the shared secret into that folder
          </p>
          <p className={styles.small}>
            This run wrote its shared secret to .psilink.key in the exchange
            folder. Copy that file into the same folder as psilink.yaml,
            readable only by you (chmod 600 on Linux/macOS). The secret rotates
            after each successful run, so copy the current file.
          </p>
        </li>
      )}
      <li>
        <p className={styles.handoffStepLabel}>Run the exchange</p>
        <HandoffCode
          code="psilink exchange input.csv results.csv"
          ariaLabel="recurring exchange command"
        />
      </li>
    </ol>
  );
}

/** The zero-setup (Direct) steps: run the single command; no key file. */
function CommandSteps({ command }: { command: string }) {
  return (
    <>
      <h3 className={styles.handoffHeading}>
        Run this command on the scheduling machine
      </h3>
      <HandoffCode
        code={command}
        ariaLabel="recurring Direct exchange command"
      />
      <p className={styles.small}>
        A Direct exchange carries no shared secret -- trust rests on the
        transport -- and re-infers the linkage terms from your file each run, so
        there is no key file to copy. To persist a configuration and host-key
        pin for later plain psilink exchange runs, add --save the first time you
        run it.
      </p>
    </>
  );
}

/** The all-modes caveats, tailored to the channel and to a pasted credential. */
function Caveats({ handoff }: { handoff: JobHandoff }) {
  return (
    <>
      <h3 className={styles.handoffHeading}>Before you schedule it</h3>
      <ul className={styles.small}>
        {handoff.channel === "sftp" ? (
          <li>
            The connection details and host-key fingerprint are filled in, but
            the credential path is a placeholder -- set it to the credential
            file on the machine that runs the schedule.
          </li>
        ) : (
          <li>
            The shared-directory path is a placeholder -- set it to the synced
            shared directory on the machine that runs the schedule.
          </li>
        )}
        {handoff.credentialPasted && (
          <li>
            The SFTP credential you pasted into the console is not saved as a
            file. Save it to a file on the scheduling machine and point the
            credential path at that file.
          </li>
        )}
        {handoff.channel === "sftp" && (
          <li>
            The host key is already pinned, so scheduled runs connect without a
            prompt.
          </li>
        )}
      </ul>
    </>
  );
}

/** A preformatted, copyable code block: the config/command shown whole (with
 * horizontal scroll for long lines) beside a copy button. The clipboard check is
 * defence-in-depth for a non-secure origin, where the block is still selectable by
 * hand. */
function HandoffCode({ code, ariaLabel }: { code: string; ariaLabel: string }) {
  return (
    <div className={styles.handoffCodeRow}>
      <pre className={`${styles.handoffCode} ${styles.mono}`}>{code}</pre>
      {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        typeof navigator !== "undefined" && navigator.clipboard ? (
          <CopyButton value={code} timeout={1500}>
            {({ copied, copy }) => (
              <Button
                variant="default"
                size="compact-sm"
                onClick={copy}
                aria-label={
                  copied ? `${ariaLabel} copied` : `Copy ${ariaLabel}`
                }
              >
                {copied ? "Copied" : "Copy"}
              </Button>
            )}
          </CopyButton>
        ) : null
      }
    </div>
  );
}
