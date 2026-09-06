import { whenDiagnostic } from "@utils/diagnostics";

import { appendSanitizedRunWarning } from "@psi/runWarnings";

import { isExchangeBusyError, reattachOnBusy } from "./reattachOnBusy";
import { runWithCompletion, runWithStage, runWithStages } from "./exchangeRun";

import type { Dispatch, SetStateAction } from "react";
import type {
  JobApiClient,
  JobRunStatus,
} from "@psi/jobClient/serverJobExchangeDriver";
import type { ConsoleJobSeat } from "@psi/jobClient/consoleJobAttachment";
import type { ExchangeDriverEvents } from "@psi/exchangeDriver";
import type { ExchangeErrorCategory } from "@psi/exchangeLifecycle";
import type { ExchangeRun } from "./exchangeRun";
import type { RunOutputs } from "@psi/runOutputs";

/** What one run's callbacks are built over: the run state each console hook
 * holds as `useState` setters, plus the few values that differ between the
 * seats. */
interface RunEventsConfig {
  /** The run's cancellation signal, owned by the calling hook. */
  signal: AbortSignal;
  /** The seat this console holds, recorded in the persisted attachment a
   * re-attach writes. */
  seat: ConsoleJobSeat;
  /** The agreed transport, threaded to that same attachment. */
  channel: string;
  /** The console job API a busy (409) re-attach probes and streams through. */
  client: JobApiClient;
  /** Show this seat's alert for a failed run and freeze the run. The failure is
   * composed at the seat, which alone knows the input source its copy names and
   * the recovery it offers, and handed straight to that seat's own `setFailure`
   * -- the pass-through `scripts/run-failure-passthrough.test.mjs` reads. */
  raiseFailure: (category: ExchangeErrorCategory, error: unknown) => void;
  setRun: Dispatch<SetStateAction<ExchangeRun>>;
  setOutputs: Dispatch<SetStateAction<RunOutputs | undefined>>;
  setWarnings: Dispatch<SetStateAction<Array<string>>>;
  setReattached: Dispatch<SetStateAction<JobRunStatus | undefined>>;
  setReattaching: Dispatch<SetStateAction<boolean>>;
  /** Record the job id a re-attach resolved, in both the state the surface
   * renders from and the ref the deliberate-leave paths discard through. */
  setJobId: (jobId: string) => void;
}

/**
 * Build one run's lifecycle callbacks over a console seat's run state, shared by
 * the inviter, acceptor, and direct hooks.
 *
 * The callbacks are built once and referenced from inside their own `onError`,
 * so a busy (409) create folds the already-running exchange's stream onto the
 * SAME surface: it re-attaches to the exchange holding the console's single slot
 * under recovery-style copy (`reattached`) rather than dead-ending on the
 * "already running" alert. Every other failure goes to
 * {@link RunEventsConfig.raiseFailure}, the terminal path.
 */
export function buildRunEvents({
  signal,
  seat,
  channel,
  client,
  raiseFailure,
  setRun,
  setOutputs,
  setWarnings,
  setReattached,
  setReattaching,
  setJobId,
}: RunEventsConfig): ExchangeDriverEvents<RunOutputs> {
  const events: ExchangeDriverEvents<RunOutputs> = {
    signal,
    onStages: (stages) => setRun((current) => runWithStages(current, stages)),
    onStage: (stageId) =>
      setRun((current) => runWithStage(current, stageId, new Date())),
    onResult: (generated) => {
      setOutputs(generated);
      setRun((current) => runWithCompletion(current, new Date()));
    },
    onWarning: (message) =>
      setWarnings((current) => appendSanitizedRunWarning(current, message)),
    onError: ({ category, error }) => {
      // Dev-gated: the raw Error object's message/cause can embed partner-/
      // server-controlled bytes, so a production console holds none of it,
      // while a developer (or a deployed client with the diagnostics toggle
      // on) keeps the full object. The user-facing alert is separately
      // sanitized where the seat composes it.
      whenDiagnostic(() => console.error(error));
      if (isExchangeBusyError(error)) {
        // Enter the reconnecting interim the instant the 409 is known, before
        // the liveness probe round trip -- this suppresses the fresh-run framing
        // (which would otherwise flash) and announces the reconnect.
        setReattaching(true);
        void reattachOnBusy({
          error,
          client,
          seat,
          channel,
          events,
          onReattaching: (id, status) => {
            setJobId(id);
            setReattaching(false);
            setReattached(status);
          },
        }).then((didReattach) => {
          if (!didReattach) {
            setReattaching(false);
            raiseFailure(category, error);
          }
        });
        return;
      }
      raiseFailure(category, error);
    },
  };
  return events;
}
