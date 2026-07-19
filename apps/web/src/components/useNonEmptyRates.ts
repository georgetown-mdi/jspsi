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
  /** True when the last sweep failed for good (a deterministic coverage failure, or a
   * worker error) rather than being superseded or still running -- so the host shows
   * an explicit "coverage unavailable" readout instead of hanging on "Checking...". */
  unavailable: boolean;
}

/**
 * A source of full-file per-field coverage: seeded once for a coverage input,
 * recomputed for each standardization edit, and torn down on dispose. The hosted
 * default ({@link rowsCoverageProvider}) wraps {@link NonEmptyRateController} over the
 * browser's parsed rows; the console provider ({@link consoleCoverageProvider}) fetches
 * the server-side coverage sweep through this same seam.
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
 * The console coverage provider: each `compute` POSTs the file's name and the
 * standardization to the appliance's streaming coverage sweep
 * ({@link postJobInputCoverage}).
 *
 * The outcome decides the readout. A deterministic failure (a `4xx` other than `429`,
 * or a malformed body) REJECTS, so the hook settles to an explicit "coverage
 * unavailable" state rather than hanging -- the same input will not succeed on retry.
 * A transient failure (`429`, a `5xx`, or a network error) never settles, so the hook
 * holds its honest "Checking..." until the next debounced edit supersedes it. An abort
 * (a superseded sweep) never settles either.
 *
 * Each `compute` gets its own {@link AbortController}, and starting one aborts the
 * previous still-in-flight sweep, so a superseded sweep's fetch is cancelled -- which
 * threads through to the server, stopping the whole-file pass rather than scanning to
 * the end. `dispose` aborts the current sweep.
 */
export const consoleCoverageProvider: CoverageProviderFactory<
  WorkInputReference
> = (reference) => {
  let active: AbortController | null = null;
  return {
    compute: (standardization) => {
      active?.abort();
      const controller = new AbortController();
      active = controller;
      return new Promise<Array<FieldValueCoverage>>((resolve, reject) => {
        void postJobInputCoverage(
          reference,
          standardization,
          controller.signal,
        ).then((outcome) => {
          if (controller.signal.aborted) return;
          if (outcome.kind === "rates") resolve(outcome.rates);
          else if (outcome.kind === "unavailable")
            reject(new Error("coverage unavailable"));
          // transient / aborted: never settle -- the hook holds pending until the
          // next debounced edit supersedes this compute.
        });
      });
    },
    dispose: () => active?.abort(),
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
  const [unavailable, setUnavailable] = useState(false);

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
    setUnavailable(false);
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
    setUnavailable(false);
    const handle = setTimeout(() => {
      provider
        .compute(standardization)
        .then((next) => {
          if (cancelled) return;
          setRates(new Map(next.map((rate) => [rate.output, rate])));
          setPending(false);
          setUnavailable(false);
        })
        .catch(() => {
          // A settled provider failure (a deterministic coverage failure, or a worker
          // error) leaves the coverage unavailable: clear the prior rates rather than
          // leave a stale rate or alarm on screen, clear pending so the UI never hangs
          // mid-check, and flag it so the host shows an explicit unavailable readout.
          // A superseded compute never settles (never rejects), so it does not reach
          // this branch.
          if (!cancelled) {
            setRates(null);
            setPending(false);
            setUnavailable(true);
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

  return { rates, pending, unavailable };
}
