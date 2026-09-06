/** The deferred handle a stubbed run driver publishes when the surface reaches
 * it: a promise resolving WITH the function that ends the run. The surface
 * renders its running state before the driver is entered, so a test that ended
 * the run off that render alone would call nothing and wait out a run that never
 * ends. Each test starts a run of its own, so call `reset` in `beforeEach`. */
export interface LiveRunSignal {
  started: Promise<() => void>;
  announceStart: (end: () => void) => void;
  reset: () => void;
}

/** Build the state a stubbed run driver announces its start through. */
export function createLiveRunSignal(): LiveRunSignal {
  const signal: LiveRunSignal = {
    started: undefined as unknown as Promise<() => void>,
    announceStart: undefined as unknown as (end: () => void) => void,
    reset: () => {
      signal.started = new Promise<() => void>((resolve) => {
        signal.announceStart = resolve;
      });
    },
  };
  signal.reset();
  return signal;
}
