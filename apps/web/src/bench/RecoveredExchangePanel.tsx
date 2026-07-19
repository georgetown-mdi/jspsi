import { useEffect, useMemo, useRef, useState } from "react";

import { Alert, Button, Group } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import { whenDiagnostic } from "@utils/diagnostics";

import {
  clearAttachment,
  discardServerJob,
  readAttachment,
} from "@psi/consoleJobAttachment";
import {
  createFetchJobApiClient,
  createServerJobReattachDriver,
} from "@psi/serverJobExchangeDriver";

import {
  initialRun,
  runWithCompletion,
  runWithFailure,
  runWithStage,
  runWithStages,
} from "./exchangeRun";
import { failureFor } from "./useInviterExchange";

import { DownloadRow, WithheldResultInset } from "./BenchRunSurface";
import { StatusPanel } from "./StatusPanel";
import styles from "./bench.module.css";

import type { ConsoleJobAttachment } from "@psi/consoleJobAttachment";
import type { ExchangeRun } from "./exchangeRun";
import type { RunFailure } from "./useInviterExchange";
import type { RunOutputs } from "./runOutputs";

/**
 * The console's strand-recovery surface: a self-contained way back to the one
 * exchange this browser last started on the appliance, mounted on an idle bench
 * entry and the console lobby. It is NOT a job list and NOT accept-later -- there
 * is exactly one exchange, named by the persisted attachment record.
 *
 * On mount it reads the attachment and probes `GET /api/jobs/:id`. Nothing
 * persisted, or a probe that finds the id gone (deleted, or a restart forgot it),
 * renders nothing -- and a gone id is best-effort DELETEd first, so a
 * restart-orphaned workdir's at-rest exposure is bounded, then the record cleared.
 * A live id renders the panel: a heading, the re-attached run's timeline (replayed
 * through the same run-state fold the hooks use), the appliance download hrefs on
 * a finished run, "Stop this exchange" while running, and "Discard" always.
 *
 * Unmounting the panel aborts only its own stream consumption -- it carries no
 * cancel intent, so the appliance's run keeps going and the panel is the way back
 * on the next visit. Only Discard (and the benches' deliberate-leave paths) cancel
 * or delete. The re-attached outputs are appliance ENDPOINT hrefs, so the panel
 * creates no object URLs and there is nothing to revoke.
 */
export function RecoveredExchangePanel() {
  // undefined = probing (render nothing); null = nothing to recover (render
  // nothing); a record = a live re-attachment to render.
  const [attachment, setAttachment] = useState<ConsoleJobAttachment | null>();
  const [run, setRun] = useState<ExchangeRun>();
  const [outputs, setOutputs] = useState<RunOutputs>();
  const [failure, setFailure] = useState<RunFailure>();
  // The probe's read of whether the exchange was still running, so a re-attached
  // finished run heads as finished immediately rather than flashing "still
  // running" until the replay lands.
  const [initiallyRunning, setInitiallyRunning] = useState(true);
  const [discarding, setDiscarding] = useState(false);

  const client = useMemo(() => createFetchJobApiClient(), []);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const stored = readAttachment();
    if (stored === null) {
      setAttachment(null);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    const aborted = () => controller.signal.aborted;
    void (async () => {
      const status = await client.fetchJobStatus(
        stored.jobId,
        controller.signal,
      );
      if (aborted()) return;
      if (status === null) {
        // The exchange is gone from the appliance (deleted, or a restart forgot
        // it). The persisted id's last duty is to bound a restart-orphaned
        // workdir's at-rest exposure through the disk-only DELETE arm; then clear
        // the record and render nothing.
        try {
          await client.deleteJob(stored.jobId);
        } catch (error) {
          whenDiagnostic(() => console.error(error));
        }
        clearAttachment();
        if (!aborted()) setAttachment(null);
        return;
      }
      setInitiallyRunning(status.status === "running");
      setRun(initialRun(stored.seat));
      setAttachment(stored);
      const driver = createServerJobReattachDriver(stored.jobId, client);
      await driver.run({
        signal: controller.signal,
        onStages: (stages) =>
          setRun((current) =>
            current ? runWithStages(current, stages) : current,
          ),
        onStage: (stageId) =>
          setRun((current) =>
            current ? runWithStage(current, stageId, new Date()) : current,
          ),
        onResult: (generated) => {
          setOutputs(generated);
          setRun((current) =>
            current ? runWithCompletion(current, new Date()) : current,
          );
        },
        onError: ({ category, error }) => {
          whenDiagnostic(() => console.error(error));
          setFailure(failureFor(category, error));
          setRun((current) => (current ? runWithFailure(current) : current));
        },
      });
    })();
    return () => {
      controller.abort();
    };
  }, [client]);

  // Stop halts the appliance's run without removing its files (a graceful cancel);
  // the re-attached stream then delivers the cancelled terminal and the panel
  // settles. Discard is the explicit disk-remover.
  function stop() {
    if (attachment == null) return;
    void client.cancelJob(attachment.jobId).catch((error) => {
      whenDiagnostic(() => console.error(error));
    });
  }

  function discard() {
    if (attachment == null || discarding) return;
    setDiscarding(true);
    // Stop watching the stream (no cancel intent) while the discard's own
    // cancel/poll/DELETE runs; then the panel renders nothing.
    abortRef.current?.abort();
    void discardServerJob(client, attachment.jobId).then(() =>
      setAttachment(null),
    );
  }

  if (attachment == null || run === undefined) return null;

  const settled = outputs !== undefined || failure !== undefined;
  const running = !settled && initiallyRunning;

  return (
    <section className={styles.callout} aria-label="Recovered exchange">
      <h2 style={{ marginTop: 0 }}>
        {running
          ? "An exchange started from this console is still running"
          : "An exchange started from this console has finished"}
      </h2>
      <p className={styles.small}>
        {running
          ? "This appliance is still running an exchange you started here. Watch it finish, stop it, or discard it and its files."
          : "This appliance finished an exchange you started here. Download its results below, or discard it to remove its files from this appliance."}
      </p>
      {failure !== undefined && (
        <Alert
          color="red"
          icon={<IconAlertCircle aria-hidden />}
          title={failure.title}
          mb="md"
        >
          <span style={{ whiteSpace: "pre-line" }}>{failure.message}</span>
        </Alert>
      )}
      <StatusPanel
        run={run}
        done={outputs !== undefined}
        halted={failure !== undefined}
      />
      {outputs !== undefined && (
        <>
          <h3>Downloads</h3>
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
        </>
      )}
      <Group mt="md">
        {running && (
          <Button variant="default" onClick={stop}>
            Stop this exchange
          </Button>
        )}
        <Button
          color="red"
          variant="light"
          loading={discarding}
          onClick={discard}
        >
          Discard
        </Button>
      </Group>
    </section>
  );
}
