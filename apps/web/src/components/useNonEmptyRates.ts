import { useEffect, useRef, useState } from "react";

import { NonEmptyRateController } from "@psi/nonEmptyAggregateController";
import { defaultSpawnAggregateWorker } from "@psi/nonEmptyAggregateWorkerClient";

import type { FieldNonEmptyRate } from "@psi/nonEmptyAggregate";
import type { SpawnAggregateWorker } from "@psi/nonEmptyAggregateController";

import type { Standardization } from "@psilink/core";

/** Debounce (ms) before a standardization edit triggers a recompute, so a burst of
 * keystrokes recomputes the full-CSV aggregate once rather than per edit. Distinct
 * from the visible UI, which tracks each edit synchronously; only this background
 * sweep is debounced. */
export const AGGREGATE_DEBOUNCE_MS = 500;

/** The hook's view of the silent-empty aggregate. */
export interface NonEmptyRatesState {
  /** Per-field rate keyed by linkage-field name (the transformation `output`), or
   * `null` before the first sweep settles. */
  rates: ReadonlyMap<string, FieldNonEmptyRate> | null;
  /** True while a recompute is in flight (debounce pending or worker running). */
  pending: boolean;
}

/**
 * Run the full-CSV non-empty-rate aggregate for the current standardization, off the
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
    FieldNonEmptyRate
  > | null>(null);
  const [pending, setPending] = useState(true);

  // One controller per row set: a new file rebuilds it (and re-seeds the worker);
  // a standardization edit reuses it. Declared before the compute effect so it runs
  // first and the ref is set when the compute effect reads it.
  const controllerRef = useRef<NonEmptyRateController | null>(null);
  useEffect(() => {
    const controller = new NonEmptyRateController(rawRows, spawnWorker);
    controllerRef.current = controller;
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
          // Superseded by dispose, or a worker error: keep the prior rates but
          // clear pending so the UI never hangs mid-check.
          if (!cancelled) setPending(false);
        });
    }, AGGREGATE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [rawRows, standardization]);

  return { rates, pending };
}
