import type { MessageConnection } from "../../src/connection/messageConnection";

/**
 * Wrap a connection so every frame it sends is also pushed onto `sent`, letting a
 * test assert what went on the wire while the underlying transport still runs.
 */
export function recordingConnection(conn: MessageConnection): {
  conn: MessageConnection;
  sent: Array<Record<string, unknown>>;
} {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    conn: {
      send: (data: unknown) => {
        sent.push(data as Record<string, unknown>);
        return conn.send(data);
      },
      receive: (timeoutMs?: number) => conn.receive(timeoutMs),
      close: () => conn.close(),
    },
  };
}
