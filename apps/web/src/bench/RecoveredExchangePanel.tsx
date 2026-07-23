import { useEffect, useMemo, useRef, useState } from "react";

import { Alert, Button, Group, Modal } from "@mantine/core";
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
  fetchSlotOccupancy,
} from "@psi/serverJobExchangeDriver";

import {
  initialRun,
  runWithCompletion,
  runWithFailure,
  runWithStage,
  runWithStages,
} from "./exchangeRun";
import { failureFor } from "./useInviterExchange";

import {
  DownloadRow,
  WithheldResultInset,
  recoveredExchangeHeading,
} from "./BenchRunSurface";
import { StatusPanel } from "./StatusPanel";
import styles from "./bench.module.css";

import type { ConsoleJobSeat } from "@psi/consoleJobAttachment";
import type { ExchangeRun } from "./exchangeRun";
import type { JobRunStatus } from "@psi/serverJobExchangeDriver";
import type { ReattachedRunState } from "./BenchRunSurface";
import type { RunFailure } from "./useInviterExchange";
import type { RunOutputs } from "./runOutputs";

/**
 * The exchange the panel recovers: the job id to re-attach to and the seat that
 * heads its initial run. Read from the persisted attachment, or -- when this
 * browser holds none -- adopted from the slot-occupancy probe.
 */
interface RecoveryTarget {
  jobId: string;
  seat: ConsoleJobSeat;
}

/**
 * Resolve the exchange to recover: the persisted attachment when this browser has
 * one, else an occupancy probe of the appliance's single slot so a browser that
 * never started the exchange still sees it. A probe-adopted target is held in
 * component state only -- never written to storage -- until the operator acts
 * (re-attach or discard). Returns null when there is nothing to recover; the probe
 * fails safe to unoccupied, so a probe fault reads as nothing to recover.
 */
async function resolveRecoveryTarget(
  signal: AbortSignal,
): Promise<{ target: RecoveryTarget; adoptedFromProbe: boolean } | null> {
  const stored = readAttachment();
  if (stored !== null)
    return {
      target: { jobId: stored.jobId, seat: stored.seat },
      adoptedFromProbe: false,
    };
  const occupancy = await fetchSlotOccupancy(signal);
  if (!occupancy.occupied) return null;
  return {
    target: { jobId: occupancy.id, seat: "inviter" },
    adoptedFromProbe: true,
  };
}

/**
 * The panel's lead paragraph. The default names the exchange as one the operator
 * started in this browser; the probe-adopted variant does not claim that -- the id
 * came from the slot probe, so another browser (or this one before its attachment
 * was lost) may have started it -- and says "started on it" instead.
 */
function recoveryLead(
  state: ReattachedRunState,
  adoptedFromProbe: boolean,
): string {
  const origin = adoptedFromProbe
    ? "an exchange started on it"
    : "an exchange you started here";
  return state === "running"
    ? `This appliance is still running ${origin}. Watch it finish, stop it, or discard it and its files.`
    : state === "finished"
      ? `This appliance finished ${origin}. Download its results below, or discard it to remove its files from this appliance.`
      : `This appliance stopped ${origin} before it finished, so there are no results to download. The reason is shown below; discard it to remove its files from this appliance.`;
}

/**
 * The console's strand-recovery surface: a self-contained way back to the one
 * exchange the appliance holds, mounted on an idle bench entry and the console
 * lobby. It is NOT a job list and NOT accept-later -- there is exactly one
 * exchange, named by this browser's stored attachment or, failing that, by the
 * appliance's single-slot occupancy.
 *
 * On mount it resolves the exchange to recover -- the persisted attachment when
 * this browser holds one, else an occupancy probe of the appliance's single slot
 * (`GET /api/jobs/slot`) so a browser that never started it still finds it -- then
 * probes `GET /api/jobs/:id`. Nothing to recover renders nothing. A probe-adopted
 * id is held in state only, never persisted, until the operator acts (re-attach or
 * discard). A CONFIRMED-gone id (an HTTP 404: deleted, or a restart forgot it)
 * renders nothing too -- and is best-effort DELETEd first, so a restart-orphaned
 * workdir's at-rest exposure is bounded, then any stored record cleared. A
 * transient/unreachable probe (a network error or non-404 fault) renders nothing
 * but LEAVES the record intact, so a blip never destroys the way back to a live
 * exchange. A live id renders the panel: one of three headings -- still running,
 * finished, or stopped (failed/cancelled) -- the re-attached run's timeline
 * (replayed through the same run-state fold the hooks use), the appliance download
 * hrefs on a finished run only, "Stop this exchange" while running, and "Discard"
 * (behind a confirm, since it is an irreversible removal of appliance-only data)
 * always.
 *
 * Unmounting the panel aborts only its own stream consumption -- it carries no
 * cancel intent, so the appliance's run keeps going and the panel is the way back
 * on the next visit. Only Discard (and the benches' deliberate-leave paths) cancel
 * or delete. The re-attached outputs are appliance ENDPOINT hrefs, so the panel
 * creates no object URLs and there is nothing to revoke.
 */
export function RecoveredExchangePanel() {
  // undefined = probing (render nothing); null = nothing to recover (render
  // nothing); a target = a live re-attachment to render.
  const [attachment, setAttachment] = useState<RecoveryTarget | null>();
  // True when the target's id came from the slot-occupancy probe rather than this
  // browser's own stored attachment, which selects the neutral lead copy.
  const [adoptedFromProbe, setAdoptedFromProbe] = useState(false);
  const [run, setRun] = useState<ExchangeRun>();
  const [outputs, setOutputs] = useState<RunOutputs>();
  const [failure, setFailure] = useState<RunFailure>();
  // The probe's initial read of the run status, so a re-attached terminal run
  // heads correctly -- finished-successful or stopped -- immediately rather than
  // flashing "still running" until the replay lands.
  const [initialStatus, setInitialStatus] = useState<JobRunStatus>("running");
  const [confirming, setConfirming] = useState(false);
  const [discarding, setDiscarding] = useState(false);

  const client = useMemo(() => createFetchJobApiClient(), []);
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    const aborted = () => controller.signal.aborted;
    void (async () => {
      const resolved = await resolveRecoveryTarget(controller.signal);
      if (aborted()) return;
      if (resolved === null) {
        setAttachment(null);
        return;
      }
      const { target, adoptedFromProbe: fromProbe } = resolved;
      const status = await client.fetchJobStatus(
        target.jobId,
        controller.signal,
      );
      if (aborted()) return;
      if (status.kind === "gone") {
        // A CONFIRMED 404: the exchange is not on the appliance (deleted, or a
        // restart forgot it). The id's last duty is to bound a restart-orphaned
        // workdir's at-rest exposure through the disk-only DELETE arm; then clear
        // any stored record and render nothing.
        try {
          await client.deleteJob(target.jobId);
        } catch (error) {
          whenDiagnostic(() => console.error(error));
        }
        clearAttachment();
        if (!aborted()) setAttachment(null);
        return;
      }
      if (status.kind === "unreachable") {
        // A transient unreachability, NOT a confirmed removal: render nothing but
        // LEAVE any record intact so the next mount can recover a still-live
        // exchange rather than the blip destroying the way back to it.
        setAttachment(null);
        return;
      }
      setInitialStatus(status.status);
      setRun(initialRun(target.seat));
      setAdoptedFromProbe(fromProbe);
      setAttachment(target);
      const driver = createServerJobReattachDriver(target.jobId, client);
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

  // Three distinct renders. A delivered terminal wins over the probe's initial
  // reading; before the replay lands, that reading drives the heading so a
  // re-attached terminal run never flashes the wrong copy. `stopped` (failed or
  // cancelled -- including this panel's own Stop) must NOT promise downloads:
  // there is no result, so the copy points at the failure alert and Discard.
  const stopped =
    failure !== undefined ||
    (outputs === undefined &&
      (initialStatus === "failed" || initialStatus === "cancelled"));
  const finished =
    !stopped && (outputs !== undefined || initialStatus === "succeeded");
  const running = !stopped && !finished;
  const runState: ReattachedRunState = running
    ? "running"
    : finished
      ? "finished"
      : "stopped";

  return (
    <section className={styles.callout} aria-label="Recovered exchange">
      <h2 style={{ marginTop: 0 }}>{recoveredExchangeHeading(runState)}</h2>
      <p className={styles.small}>{recoveryLead(runState, adoptedFromProbe)}</p>
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
          onClick={() => setConfirming(true)}
        >
          Discard
        </Button>
      </Group>
      <Modal
        opened={confirming}
        onClose={() => setConfirming(false)}
        title="Discard this exchange?"
        centered
        transitionProps={{ duration: 0 }}
      >
        <p>
          Discarding removes this exchange and any results from this appliance,
          and stops it if it is still running. This cannot be undone -- download
          anything you need first.
        </p>
        <Group mt="md">
          <Button variant="default" onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button
            color="red"
            variant="light"
            loading={discarding}
            onClick={discard}
          >
            Discard
          </Button>
        </Group>
      </Modal>
    </section>
  );
}
