import handler from "@tanstack/react-start/server-entry";

import { withSecurityHeaders } from "@utils/securityHeaders";

export default {
  async fetch(request: Request) {
    return withSecurityHeaders(await handler.fetch(request));
  },
};

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
