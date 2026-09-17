import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { getLogger } from "@psilink/core";

import {
  betweenVisitNotificationState,
  betweenVisitNotificationsArmed,
  disableBetweenVisitNotifications,
  enableBetweenVisitNotifications,
  showBetweenVisitNotice,
} from "@psi/managed/betweenVisitNotifier";

import type { BetweenVisitNotice } from "@psi/managed/betweenVisitNotice";

// The opt-in and the platform call behind the between-visit notification. The
// permission is asked for HERE and nowhere else, and every refusal -- a denied
// permission, a dismissed prompt, an engine with no notification API at all --
// leaves the app showing nothing between visits.

const OPT_IN_KEY = "psilink-between-visit-notifications";

const NOTICE: BetweenVisitNotice = {
  kind: "backup",
  title: "A scheduled run finished; back up this exchange",
  body: "Riverbend quarterly just ran.",
  tag: "riverbend|backup:2026-07-14T09:00:00.000Z",
};

/** Install an in-memory localStorage over the node env (which has none) and hand
 * back its backing map so a test can assert what the opt-in wrote. */
function installStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  });
  return store;
}

/** Install a notification API holding `permission`, whose request answers
 * `answer`, and collect what a page-constructed notification was given. */
function installNotification(
  permission: NotificationPermission,
  answer: NotificationPermission = permission,
): {
  shown: Array<{ title: string; options?: NotificationOptions }>;
  requested: () => number;
} {
  const shown: Array<{ title: string; options?: NotificationOptions }> = [];
  const requestPermission = vi.fn(() => {
    FakeNotification.permission = answer;
    return Promise.resolve(answer);
  });
  class FakeNotification {
    static permission: NotificationPermission = permission;
    static requestPermission = requestPermission;
    constructor(title: string, options?: NotificationOptions) {
      shown.push({ title, ...(options === undefined ? {} : { options }) });
    }
  }
  vi.stubGlobal("Notification", FakeNotification);
  return { shown, requested: () => requestPermission.mock.calls.length };
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("betweenVisitNotificationState: where the opt-in stands", () => {
  test("an engine with no notification API has nothing to offer", () => {
    vi.stubGlobal("Notification", undefined);

    expect(betweenVisitNotificationState()).toBe("unsupported");
    expect(betweenVisitNotificationsArmed()).toBe(false);
  });

  test("a browser refusing notifications reports the block", () => {
    installNotification("denied");

    expect(betweenVisitNotificationState()).toBe("blocked");
    expect(betweenVisitNotificationsArmed()).toBe(false);
  });

  test("an operator who has not opted in is off, permission or not", () => {
    installNotification("granted");

    expect(betweenVisitNotificationState()).toBe("off");
    expect(betweenVisitNotificationsArmed()).toBe(false);
  });
});

describe("enableBetweenVisitNotifications: the operator's own step", () => {
  test("asks for permission and remembers the opt-in once granted", async () => {
    const notification = installNotification("default", "granted");

    await expect(enableBetweenVisitNotifications()).resolves.toBe("on");
    expect(notification.requested()).toBe(1);
    expect(betweenVisitNotificationsArmed()).toBe(true);
  });

  test("a refusal stores no opt-in and reports the block", async () => {
    const storage = installStorage();
    const notification = installNotification("default", "denied");

    await expect(enableBetweenVisitNotifications()).resolves.toBe("blocked");
    expect(notification.requested()).toBe(1);
    expect(storage.has(OPT_IN_KEY)).toBe(false);
    expect(betweenVisitNotificationsArmed()).toBe(false);
  });

  test("a dismissed prompt leaves the control to ask again", async () => {
    const storage = installStorage();
    installNotification("default", "default");

    await expect(enableBetweenVisitNotifications()).resolves.toBe("off");
    expect(storage.has(OPT_IN_KEY)).toBe(false);
  });

  test("a browser already refusing is not asked again", async () => {
    const notification = installNotification("denied");

    await expect(enableBetweenVisitNotifications()).resolves.toBe("blocked");
    expect(notification.requested()).toBe(0);
  });

  test("an engine with no notification API asks nothing", async () => {
    vi.stubGlobal("Notification", undefined);

    await expect(enableBetweenVisitNotifications()).resolves.toBe(
      "unsupported",
    );
  });

  test("turning it off drops the opt-in and leaves the permission alone", async () => {
    const storage = installStorage();
    installNotification("default", "granted");
    await enableBetweenVisitNotifications();

    disableBetweenVisitNotifications();

    expect(storage.has(OPT_IN_KEY)).toBe(false);
    expect(betweenVisitNotificationState()).toBe("off");
  });
});

describe("showBetweenVisitNotice: the platform call", () => {
  test("shows the notice with its body and its own tag", async () => {
    const notification = installNotification("granted");

    await showBetweenVisitNotice(NOTICE);

    expect(notification.shown).toEqual([
      { title: NOTICE.title, options: { body: NOTICE.body, tag: NOTICE.tag } },
    ]);
  });

  test("shows it through the app-shell worker where there is one", async () => {
    const notification = installNotification("granted");
    const showNotification = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", {
      serviceWorker: {
        getRegistration: () => Promise.resolve({ showNotification }),
      },
    });

    await showBetweenVisitNotice(NOTICE);

    expect(showNotification).toHaveBeenCalledWith(NOTICE.title, {
      body: NOTICE.body,
      tag: NOTICE.tag,
    });
    expect(notification.shown).toEqual([]);
  });

  test("an engine with no notification API shows nothing and does not throw", async () => {
    vi.stubGlobal("Notification", undefined);

    await expect(showBetweenVisitNotice(NOTICE)).resolves.toBeUndefined();
  });

  test("a platform that refuses the notice leaves it to the next visit", async () => {
    vi.spyOn(getLogger("betweenVisitNotifier"), "warn").mockImplementation(
      () => {},
    );
    vi.stubGlobal(
      "Notification",
      class {
        static permission: NotificationPermission = "granted";
        constructor() {
          throw new TypeError(
            "this platform shows notifications from a worker",
          );
        }
      },
    );

    await expect(showBetweenVisitNotice(NOTICE)).resolves.toBeUndefined();
  });
});
