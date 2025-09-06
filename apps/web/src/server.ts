import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { createRouter } from '@router'

export default createStartHandler({
    createRouter,
  })(defaultStreamHandler)

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
