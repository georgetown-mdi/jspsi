import { runExchangeLifecycle } from "./exchangeLifecycle";

import type {
  Acquire,
  ExchangeErrorCategory,
  ExchangeOutputs,
  GenerateOutput,
  StageDefinition,
} from "./exchangeLifecycle";

/** The typed lifecycle events a driver emits over a single run, plus the run's
 * {@link AbortSignal}. This is the whole surface a consumer sees: a driver runs
 * an exchange and reports progress, the result, or a categorized failure, and
 * the consumer cancels through the existing signal. Deliberately transport-blind
 * -- it names no peer connection, PSI library, or exchange result, only the
 * event vocabulary the lifecycle already speaks -- so a driver that POSTs a
 * server intent and maps a server event stream satisfies it exactly as the
 * in-browser WebRTC driver does.
 *
 * `TOutputs` is the owner-widened {@link ExchangeOutputs} the consumer receives
 * back in `onResult` (the bench passes its `RunOutputs`), matching how the
 * lifecycle already threads the type through. */
export interface ExchangeDriverEvents<
  TOutputs extends ExchangeOutputs = ExchangeOutputs,
> {
  /** Cancellation stays on the existing per-run signal the consumer owns; a
   * driver observes it and tears down in any phase. There is no second cancel
   * path. */
  signal: AbortSignal;
  /** The full per-run stage tree, emitted once. */
  onStages: (stages: Array<StageDefinition>) => void;
  /** Activate a stage by id as the run advances through it. */
  onStage: (stageId: string) => void;
  /** The run succeeded: the owner-widened outputs. */
  onResult: (outputs: TOutputs) => void;
  /** The run failed, tagged with the category that decides the consumer's
   * recovery affordance. */
  onError: (failure: {
    category: ExchangeErrorCategory;
    error: unknown;
  }) => void;
}

/** A per-channel exchange driver: a `run` that carries out one exchange and
 * emits the typed lifecycle events, cancellable through the run's signal. The
 * consumer constructs a driver from its channel-specific inputs, then calls
 * `run` once per attempt (a retry constructs a fresh signal and calls `run`
 * again). Construction-time inputs are the driver's own concern and never appear
 * here, so a second driver -- one with no peer connection, built against this
 * same interface in a sibling module -- is a drop-in for the consumer. */
export interface ExchangeDriver<
  TOutputs extends ExchangeOutputs = ExchangeOutputs,
> {
  run: (events: ExchangeDriverEvents<TOutputs>) => Promise<void>;
}

/** The in-browser WebRTC pieces a {@link createBrowserExchangeDriver} binds at
 * construction: everything the underlying {@link runExchangeLifecycle} needs
 * that is NOT a run-time event or the run's signal. These are browser-driver
 * internals -- `acquire` draws in the peer and loads the PSI library,
 * `generateOutput` builds the local result files -- and are deliberately absent
 * from {@link ExchangeDriver} so the contract holds for a driver that has
 * neither. */
export interface BrowserExchangeDriverConfig<
  TOutputs extends ExchangeOutputs = ExchangeOutputs,
> {
  acquire: Acquire;
  exchangeRole: "initiator" | "responder";
  sharedSecret: string;
  expires?: string;
  generateOutput: GenerateOutput<TOutputs>;
}

/** Build the in-browser WebRTC {@link ExchangeDriver} by wrapping
 * {@link runExchangeLifecycle}: `run` forwards the run's signal and the four
 * lifecycle events straight through alongside the construction-time WebRTC
 * pieces, so its behavior is identical to calling `runExchangeLifecycle`
 * directly. */
export function createBrowserExchangeDriver<
  TOutputs extends ExchangeOutputs = ExchangeOutputs,
>(config: BrowserExchangeDriverConfig<TOutputs>): ExchangeDriver<TOutputs> {
  const { acquire, exchangeRole, sharedSecret, expires, generateOutput } =
    config;
  return {
    run: ({ signal, onStages, onStage, onResult, onError }) =>
      runExchangeLifecycle<TOutputs>({
        acquire,
        exchangeRole,
        sharedSecret,
        expires,
        generateOutput,
        signal,
        onStages,
        onStage,
        onResult,
        onError,
      }),
  };
}
