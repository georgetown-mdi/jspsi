import { useEffect, useRef, useState } from "react";

import { NonEmptyRateController } from "@psi/nonEmptyAggregateController";
import { defaultSpawnAggregateWorker } from "@psi/nonEmptyAggregateWorkerClient";

import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";
import type { SpawnAggregateWorker } from "@psi/nonEmptyAggregateController";

import type { Standardization } from "@psilink/core";

/** Debounce (ms) before a standardization edit triggers a recompute, so a burst of
 * keystrokes recomputes the full-CSV coverage once rather than per edit. Distinct
 * from the visible UI, which tracks each edit synchronously; only this background
 * sweep is debounced. */
export const AGGREGATE_DEBOUNCE_MS = 500;

/** The hook's view of the per-field value coverage. */
export interface NonEmptyRatesState {
  /** Per-field coverage keyed by linkage-field name (the transformation `output`),
   * or `null` before the first sweep settles. */
  rates: ReadonlyMap<string, FieldValueCoverage> | null;
  /** True while a recompute is in flight (debounce pending or worker running). */
  pending: boolean;
}

/**
 * Run the full-CSV per-field value coverage for the current standardization, off the
 * main thread above the row threshold. One {@link NonEmptyRateController} is created
 * per row set (the worker, if any, is seeded once); each debounced standardization
 * edit posts only the standardization for a recompute. The result is keyed by field
 * name for the host to read per card.
 *
 * `spawnWorker` is injectable for tests; production uses the real worker.
 */
export function useNonEmptyRates(
  rawRows: ReadonlyArray<Record<string, string>>,
  standardization: Standardization,
  spawnWorker: SpawnAggregateWorker = defaultSpawnAggregateWorker,
): NonEmptyRatesState {
  const [rates, setRates] = useState<ReadonlyMap<
    string,
    FieldValueCoverage
  > | null>(null);
  const [pending, setPending] = useState(true);

  // One controller per row set: a new file rebuilds it (and re-seeds the worker);
  // a standardization edit reuses it. Declared before the compute effect so it runs
  // first and the ref is set when the compute effect reads it.
  const controllerRef = useRef<NonEmptyRateController | null>(null);
  useEffect(() => {
    const controller = new NonEmptyRateController(rawRows, spawnWorker);
    controllerRef.current = controller;
    // Drop any prior file's coverage immediately and re-enter the pending state: until
    // the new sweep settles the host shows "Checking...", never nothing and never the
    // previous file's rate (or alarm) for a same-named field. Resetting pending here
    // (not only in the compute effect, which runs second) keeps the two in lockstep
    // for the new row set rather than relying on effect-ordering and update batching.
    setRates(null);
    setPending(true);
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, [rawRows, spawnWorker]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (controller === null) return;
    let cancelled = false;
    setPending(true);
    const handle = setTimeout(() => {
      controller
        .compute(standardization)
        .then((next) => {
          if (cancelled) return;
          setRates(new Map(next.map((rate) => [rate.output, rate])));
          setPending(false);
        })
        .catch(() => {
          // A worker error (dispose never settles -- see the controller) leaves the
          // coverage unknown: clear the prior rates rather than leave a stale rate or
          // alarm on screen, and clear pending so the UI never hangs mid-check.
          if (!cancelled) {
            setRates(null);
            setPending(false);
          }
        });
    }, AGGREGATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [rawRows, standardization]);

  return { rates, pending };
}
