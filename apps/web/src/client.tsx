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

// The app-shell worker registers only in the hosted deployment: a console build
// upgrades by pulling a new image, and a cached shell could outlive the
// container that served it. A dev server is excluded because a worker in front
// of `npm run dev` serves the last document it saw. Registration waits for
// `load` so the precache does not compete with the first render's requests.
if (!isConsoleBuild() && !import.meta.env.DEV && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void registerAppShell(navigator.serviceWorker);
  });
}
