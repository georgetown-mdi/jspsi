import { describe, expect, test, vi } from "vitest";

import { createBrowserExchangeDriver } from "../../../src/psi/exchangeDriver.js";
import { runExchangeLifecycle } from "../../../src/psi/exchangeLifecycle.js";

import type {
  Acquire,
  ExchangeOutputs,
} from "../../../src/psi/exchangeLifecycle.js";
import type { ExchangeDriverEvents } from "../../../src/psi/exchangeDriver.js";

// The driver is a pass-through onto the lifecycle, so the lifecycle is what a
// test of it must not run: mocking it leaves exactly the wiring behind.
vi.mock("../../../src/psi/exchangeLifecycle.js", () => ({
  runExchangeLifecycle: vi.fn(),
}));

const mockedRunLifecycle = vi.mocked(runExchangeLifecycle);

const ACQUIRE: Acquire = () => {
  throw new Error("the mocked lifecycle never acquires");
};

function driverConfig() {
  return {
    acquire: ACQUIRE,
    exchangeRole: "initiator" as const,
    sharedSecret: "test-shared-secret",
    expires: "2999-01-01T00:00:00.000Z",
    generateOutput: vi.fn(() => ({
      kind: "matched" as const,
      resultsUrl: "blob:results",
    })),
  };
}

function driverEvents(
  overrides?: Partial<ExchangeDriverEvents<ExchangeOutputs>>,
): ExchangeDriverEvents<ExchangeOutputs> {
  return {
    signal: new AbortController().signal,
    onStages: vi.fn(),
    onStage: vi.fn(),
    onResult: vi.fn(),
    onError: vi.fn(),
    onWarning: vi.fn(),
    ...overrides,
  };
}

describe("createBrowserExchangeDriver", () => {
  test("forwards the run's events, the warning slot among them", async () => {
    // The transport's unconfirmed-delivery notice reaches the operator through
    // the consumer's onWarning, so a driver that forwarded every other event
    // would swallow it with nothing failing.
    const config = driverConfig();
    const events = driverEvents();

    await createBrowserExchangeDriver(config).run(events);

    expect(mockedRunLifecycle).toHaveBeenCalledWith({
      acquire: config.acquire,
      exchangeRole: config.exchangeRole,
      sharedSecret: config.sharedSecret,
      expires: config.expires,
      generateOutput: config.generateOutput,
      signal: events.signal,
      onStages: events.onStages,
      onStage: events.onStage,
      onResult: events.onResult,
      onError: events.onError,
      onWarning: events.onWarning,
    });
  });

  test("runs for a consumer that offers no warning surface", async () => {
    // onWarning is optional on the contract; a consumer without one leaves the
    // lifecycle nothing to raise a notice through rather than a hole to trip on.
    const events = driverEvents({ onWarning: undefined });

    await createBrowserExchangeDriver(driverConfig()).run(events);

    expect(mockedRunLifecycle).toHaveBeenCalledWith(
      expect.objectContaining({ onWarning: undefined }),
    );
  });
});
