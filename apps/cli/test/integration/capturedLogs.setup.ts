import { installCapturedLogsInterceptor } from "@psilink/core/testing";

// A `setupFiles` entry, so this runs once in EACH file's worker (one process
// per file on the `forks` pool), before the test module -- and any named
// logger it constructs -- loads. loglevel binds a logger's methods from the
// methodFactory live at getLogger time, so installing eagerly here keeps a
// logger created before the suite's first withCapturedLogs call from binding
// to the bare factory and escaping capture.
installCapturedLogsInterceptor();
