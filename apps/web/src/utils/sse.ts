export function createSSEStream() {
  let controller: ReadableStreamDefaultController | null = null;
  let closed = false;
  const closedHandlers: Array<(() => void)> = [];

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(ctrl) {
      controller = ctrl;
    },
    cancel() {
      closed = true;
      closedHandlers.forEach((fn) => fn());
    },
  });

  return {
    send() {
      // Return a Response that uses the stream as its body
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        },
      });
    },
    push(data: string) {
      if (closed || !controller) return;
      const payload = `data: ${data}\n\n`;
      controller.enqueue(encoder.encode(payload));
    },
    close() {
      if (closed || !controller) return;
      // close will still send previously enqueued messages
      controller.close();
      closed = true;
      closedHandlers.forEach((fn) => fn());
    },
    onClosed(fn: () => void) {
      closedHandlers.push(fn);
    },
  };
}
