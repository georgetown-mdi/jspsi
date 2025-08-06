import { createStartHandler, defaultStreamHandler } from '@tanstack/react-start/server'
import { createRouter } from '@router'

export default createStartHandler({
    createRouter,
  })(defaultStreamHandler)

/* if (import.meta.env.SSR && import.meta.env.PROD) {
  try {
    const { useNitroApp } = await import('nitropack/runtime')
    const nitroApp = useNitroApp();
    // console.log(nitroApp)
    if (nitroApp?.hooks) {
      nitroApp.hooks.hook('nitro:listen', (server, info) => {
        console.log('Nitro production server', server, 'with info', info)
      })
    }
  } catch (err) {
    console.warn('Nitro not available in this context:', err)
  }
} */

// see: https://github.com/vitest-dev/vitest/issues/2334
if (import.meta.hot) {
  import.meta.hot.on("vite:beforeFullReload", () => {
    // peerServer.close();
  })

  import.meta.hot.dispose(() => {
    /* if (peerServerServer !== undefined) {
      peerServerServer.close()
      peerServerServer = undefined;
    } */
  });
}

