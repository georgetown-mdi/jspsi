import { useEffect, useRef, useState } from "react";

import { NonEmptyRateController } from "@psi/nonEmptyAggregateController";
import { defaultSpawnAggregateWorker } from "@psi/nonEmptyAggregateWorkerClient";
import { postJobInputCoverage } from "@psi/workInputClient";

import type { FieldValueCoverage } from "@psi/nonEmptyAggregate";
import type { WorkInputReference } from "@psi/workInputClient";

import type { CSVRow, Standardization } from "@psilink/core";

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
 * A source of full-file per-field coverage: seeded once for a coverage input,
 * recomputed for each standardization edit, and torn down on dispose. The hosted
 * default ({@link rowsCoverageProvider}) wraps {@link NonEmptyRateController} over the
 * browser's parsed rows; the console provider (a fetch to the server-side coverage
 * sweep) is a later work package that plugs in through this same seam.
 */
export interface CoverageProvider {
  /** Resolve the per-field rates for `standardization`. A compute the hook
   * supersedes may never settle -- the hook guards with its own cancellation flag. */
  compute: (
    standardization: Standardization,
  ) => Promise<Array<FieldValueCoverage>>;
  /** Release the underlying resource (the worker, a request, a connection). */
  dispose: () => void;
}

/** Build a {@link CoverageProvider} for a coverage input -- injected so the hook is
 * agnostic to whether the input is the browser's rows or a server-side file
 * reference. */
export type CoverageProviderFactory<TInput> = (
  input: TInput,
) => CoverageProvider;

/** The hosted coverage provider: {@link NonEmptyRateController} over the parsed rows,
 * preserving its inline-below-threshold / worker-above-threshold behavior exactly. */
export const rowsCoverageProvider: CoverageProviderFactory<
  ReadonlyArray<CSVRow>
> = (rawRows) =>
  new NonEmptyRateController(rawRows, defaultSpawnAggregateWorker);

/**
 * The console coverage provider: each `compute` POSTs the standardization plus the
 * file's profiled freshness pair to the appliance's streaming coverage sweep
 * ({@link postJobInputCoverage}). A non-2xx (429 busy, a drifted/schema 400, or a
 * transient error) is treated like a superseded response -- the returned promise
 * never settles, so the hook holds its honest "Checking..." pending state until the
 * next debounced edit supersedes it, rather than dropping to a false "coverage
 * unknown". `dispose` aborts any in-flight sweep.
 */
export const consoleCoverageProvider: CoverageProviderFactory<
  WorkInputReference
> = (reference) => {
  const controller = new AbortController();
  return {
    compute: (standardization) =>
      new Promise<Array<FieldValueCoverage>>((resolve) => {
        void postJobInputCoverage(reference, standardization, controller.signal)
          .then((rates) => {
            if (rates !== null) resolve(rates);
          })
          .catch(() => undefined);
      }),
    dispose: () => controller.abort(),
  };
};

/** The bench's coverage input, unifying the hosted browser rows and the console's
 * mounted-file reference so one {@link useNonEmptyRates} call serves both builds. */
export type BenchCoverageInput =
  | { kind: "rows"; rows: ReadonlyArray<CSVRow> }
  | { kind: "workFile"; reference: WorkInputReference };

/** The unified bench coverage provider: dispatches a `rows` input to the hosted
 * worker-backed provider and a `workFile` input to the console fetch-backed sweep.
 * A stable module-level factory so the hook rebuilds the provider only when the
 * coverage input identity changes. */
export const benchCoverageProvider: CoverageProviderFactory<
  BenchCoverageInput
> = (input) =>
  input.kind === "rows"
    ? rowsCoverageProvider(input.rows)
    : consoleCoverageProvider(input.reference);

/**
 * Run the full-CSV per-field value coverage for the current standardization behind
 * a {@link CoverageProvider}. One provider is created per coverage `input` (the
 * worker, if any, is seeded once); each debounced standardization edit posts only the
 * standardization for a recompute. The result is keyed by field name for the host to
 * read per card.
 *
 * `makeProvider` is the injectable seam: the hosted host passes
 * {@link rowsCoverageProvider}, and the console host passes a fetch-backed provider.
 */
export function useNonEmptyRates<TInput>(
  input: TInput,
  standardization: Standardization,
  makeProvider: CoverageProviderFactory<TInput>,
): NonEmptyRatesState {
  const [rates, setRates] = useState<ReadonlyMap<
    string,
    FieldValueCoverage
  > | null>(null);
  const [pending, setPending] = useState(true);

  // One provider per coverage input: a new file rebuilds it (and re-seeds the
  // worker); a standardization edit reuses it. Declared before the compute effect so
  // it runs first and the ref is set when the compute effect reads it.
  const providerRef = useRef<CoverageProvider | null>(null);
  useEffect(() => {
    const provider = makeProvider(input);
    providerRef.current = provider;
    // Drop any prior file's coverage immediately and re-enter the pending state: until
    // the new sweep settles the host shows "Checking...", never nothing and never the
    // previous file's rate (or alarm) for a same-named field. Resetting pending here
    // (not only in the compute effect, which runs second) keeps the two in lockstep
    // for the new input rather than relying on effect-ordering and update batching.
    setRates(null);
    setPending(true);
    return () => {
      provider.dispose();
      providerRef.current = null;
    };
  }, [input, makeProvider]);

  useEffect(() => {
    const provider = providerRef.current;
    if (provider === null) return;
    let cancelled = false;
    setPending(true);
    const handle = setTimeout(() => {
      provider
        .compute(standardization)
        .then((next) => {
          if (cancelled) return;
          setRates(new Map(next.map((rate) => [rate.output, rate])));
          setPending(false);
        })
        .catch(() => {
          // A provider error (dispose never settles -- see the controller) leaves the
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
    // `makeProvider` is a dep even though it is not read here: when it changes the
    // provider effect rebuilds the provider, and this effect must re-run to dispatch a
    // compute against the new one -- otherwise the readout wedges in the pending state
    // with no compute in flight. Production passes a stable module-level factory, so
    // this only matters for a caller that varies makeProvider (e.g. a test).
  }, [input, standardization, makeProvider]);

  return { rates, pending };
}
