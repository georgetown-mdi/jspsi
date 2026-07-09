import handler from "@tanstack/react-start/server-entry";

import { withSecurityHeaders } from "@utils/securityHeaders";

export default {
  async fetch(request: Request) {
    return withSecurityHeaders(await handler.fetch(request));
  },
};
