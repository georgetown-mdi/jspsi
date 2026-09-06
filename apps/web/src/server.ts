import handler from "@tanstack/react-start/server-entry";

import { withApiGuard } from "@utils/apiNamespace";
import { withSecurityHeaders } from "@utils/securityHeaders";

const route = withApiGuard((request: Request) => handler.fetch(request));

export default {
  async fetch(request: Request) {
    return withSecurityHeaders(await route(request));
  },
};
