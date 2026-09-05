import { expect, test } from "vitest";

import { SftpAdapterLedger } from "../../src/connection/sftpAdapterLedger";

// The end-of-run summary reports the dialing retries and the sessions lost
// mid-exchange on separate lines, while the metrics event reports their merged
// total; a drift between the parts and the total would have the two disagree
// about the same run.

const ledger = () => new SftpAdapterLedger({ warn: () => {} });

test("the reconnect total is the dialing retries plus the sessions lost", () => {
  const counters = ledger();
  counters.countConnectRetry();
  counters.countConnectRetry();
  counters.recordLoss(counters.dialSucceeded(), "partner");

  expect(counters.connectRetryCount).toBe(2);
  expect(counters.midExchangeReconnectCount).toBe(1);
  expect(counters.reconnectCount).toBe(
    counters.connectRetryCount + counters.midExchangeReconnectCount,
  );
});

test("a dial retried until it gave up counts no session lost", () => {
  const counters = ledger();
  counters.countConnectRetry();
  counters.countConnectRetry();
  counters.countConnectRetry();

  expect(counters.connectRetryCount).toBe(3);
  expect(counters.midExchangeReconnectCount).toBe(0);
});

test("a session this side ended counts neither way", () => {
  const counters = ledger();
  counters.recordLoss(counters.dialSucceeded(), "teardown");

  expect(counters.connectRetryCount).toBe(0);
  expect(counters.midExchangeReconnectCount).toBe(0);
  expect(counters.reconnectCount).toBe(0);
});
