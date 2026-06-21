import {
  computeFieldCoverage,
  shouldComputeOffThread,
} from "./nonEmptyAggregate";

import type { FieldValueCoverage } from "./nonEmptyAggregate";

import type { Standardization } from "@psilink/core";

/**
 * Orchestrates the silent-empty aggregate ({@link computeFieldCoverage}) on or off
 * the main thread, the single path both the React hook and the unit test drive.
 *
 * Below {@link shouldComputeOffThread} it computes inline (a worker's setup buys
 * nothing for a small file). At or above it, it spawns a worker ONCE, seeds it with
 * the full row set ONCE (the structured-clone cost is paid a single time at file
 * load, not re-paid on every edit), and thereafter posts only the tiny
 * standardization per recompute -- so re-cloning the rows, which would itself block
 * the main thread it is trying to spare, never happens. The worker is injected
 * ({@link SpawnAggregateWorker}) so a test exercises the off-thread dispatch with a
 * fake, since `Worker` does not exist under Node.
 */

/** The slice of the `Worker` API the controller drives. The real `Worker` is
 * adapted to it in {@link ./nonEmptyAggregateWorkerClient}; a test supplies a fake. */
export interface AggregateWorker {
  postMessage: (message: AggregateRequest) => void;
  onmessage: ((event: { data: AggregateResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  terminate: () => void;
}

/** Spawns a fresh aggregate worker. Injected so the controller never references the
 * real `Worker` constructor directly (keeping this module Node-loadable and the
 * dispatch testable). */
export type SpawnAggregateWorker = () => AggregateWorker;

/** Worker request: seed the rows once, then compute per standardization edit. */
export type AggregateRequest =
  | { kind: "rows"; rawRows: ReadonlyArray<Record<string, string>> }
  | { kind: "compute"; token: number; standardization: Standardization };

/** Worker response: the rates for the compute identified by `token`. */
export interface AggregateResponse {
  token: number;
  rates: Array<FieldValueCoverage>;
}

export class NonEmptyRateController {
  private readonly rawRows: ReadonlyArray<Record<string, string>>;
  private readonly worker: AggregateWorker | undefined;
  private nextToken = 0;
  private readonly pending = new Map<
    number,
    (rates: Array<FieldValueCoverage>) => void
  >();
  private readonly failers = new Map<number, (error: unknown) => void>();
  private disposed = false;

  constructor(
    rawRows: ReadonlyArray<Record<string, string>>,
    spawnWorker: SpawnAggregateWorker,
  ) {
    this.rawRows = rawRows;
    if (!shouldComputeOffThread(rawRows.length)) {
      this.worker = undefined;
      return;
    }
    const worker = spawnWorker();
    worker.onmessage = (event) => this.onMessage(event.data);
    worker.onerror = (error) => this.onError(error);
    // Seed the rows once; every later compute posts only the standardization.
    worker.postMessage({ kind: "rows", rawRows });
    this.worker = worker;
  }

  /** Whether this controller computes off the main thread (true only above the
   * row threshold). */
  get offThread(): boolean {
    return this.worker !== undefined;
  }

  /**
   * Compute the per-field rates for `standardization`. Resolves inline (already
   * settled) below the threshold, or when the worker posts back the matching token
   * above it. A compute superseded by {@link dispose} never settles -- the caller
   * (the hook) guards with its own cancellation flag and ignores a stale result.
   */
  compute(
    standardization: Standardization,
  ): Promise<Array<FieldValueCoverage>> {
    if (this.worker === undefined)
      return Promise.resolve(
        computeFieldCoverage(this.rawRows, standardization),
      );
    const token = this.nextToken++;
    return new Promise((resolve, reject) => {
      this.pending.set(token, resolve);
      this.failers.set(token, reject);
      this.worker?.postMessage({ kind: "compute", token, standardization });
    });
  }

  /** Tear down the worker and drop any in-flight computes (left unsettled, not
   * rejected, so a disposed-mid-compute hook produces no unhandled rejection). */
  dispose(): void {
    this.disposed = true;
    this.worker?.terminate();
    this.pending.clear();
    this.failers.clear();
  }

  private onMessage(response: AggregateResponse): void {
    if (this.disposed) return;
    const resolve = this.pending.get(response.token);
    if (resolve === undefined) return;
    this.pending.delete(response.token);
    this.failers.delete(response.token);
    resolve(response.rates);
  }

  private onError(error: unknown): void {
    // A worker-level failure fails every in-flight compute so the hook can settle
    // to an unavailable state rather than hang.
    for (const fail of this.failers.values()) fail(error);
    this.pending.clear();
    this.failers.clear();
  }
}
