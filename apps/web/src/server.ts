import handler from '@tanstack/react-start/server-entry';

export default {
  fetch(request: Request) {
    return handler.fetch(request);
  }
}

// see: https://github.com/vitest-dev/vitest/issues/2334
/* if (import.meta.hot) {
  import.meta.hot.on("vite:beforeFullReload", () => {
     peerServer.close();
  })

  import.meta.hot.dispose(() => {
    if (peerServerServer !== undefined) {
      peerServerServer.close()
      peerServerServer = undefined;
    }
  });
} */
