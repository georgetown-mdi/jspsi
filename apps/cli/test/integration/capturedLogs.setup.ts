import { installCapturedLogsInterceptor } from "@psilink/core/testing";

// A `setupFiles` entry, so this runs once in EACH integration file's worker (the
// integration project uses the `forks` pool: one process per file), before the
// test module -- and thus any named logger it constructs at import time -- is
// loaded. loglevel binds a logger's methods from the methodFactory live at
// getLogger time, so installing the withCapturedLogs interceptor here, ahead of
// every logger, makes capture independent of creation order: a logger
// materialized before the suite's first withCapturedLogs call is still routed
// through capture rather than silently leaking past it. Without this eager
// install, withCapturedLogs would install the interceptor lazily on its first
// call, by which point an earlier-created logger has already bound to the bare
// factory and can never be captured.
installCapturedLogsInterceptor();
