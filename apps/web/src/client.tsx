import { StartClient } from "@tanstack/react-start/client";
import { StrictMode } from "react";
import { hydrateRoot } from "react-dom/client";

import { ConfigManager, isConsoleBuild } from "@utils/clientConfig";
import { registerAppShell } from "@utils/appShellUpdate";
import { setDefaultLevel } from "loglevel";

const configManager = new ConfigManager();
const config = await configManager.load({
  data: Object.fromEntries(
    Object.entries(import.meta.env)
      .filter(([key]) => key.startsWith("VITE_"))
      .map(([key, value]) => [key.substring(5), value]),
  ),
});

setDefaultLevel(config.LOG_LEVEL);

hydrateRoot(
  document,
  <StrictMode>
    <StartClient />
  </StrictMode>,
);

// The app-shell worker belongs to the hosted deployment alone. The console
// appliance is a local prototyping GUI for one exchange whose code is upgraded
// by pulling a new image -- an offline shell buys it nothing and a cached one
// could outlive the container it was served from. A dev server is excluded for
// the same reason in the small: a worker in front of `npm run dev` serves the
// last document it saw. Registration waits for `load` so the precache does not
// compete with the first render's own requests.
if (!isConsoleBuild() && !import.meta.env.DEV && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void registerAppShell(navigator.serviceWorker);
  });
}
