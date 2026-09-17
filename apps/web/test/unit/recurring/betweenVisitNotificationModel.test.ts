import { describe, expect, test } from "vitest";

import { betweenVisitNotificationDisplay } from "@recurring/betweenVisitNotificationModel";

// What the operator reads about between-visit notifications in each state, and
// which of those states offers a control at all: the browser's own refusal cannot
// be asked past from here, and an engine without notifications shows nothing.

describe("betweenVisitNotificationDisplay", () => {
  test("an engine without notifications shows nothing", () => {
    expect(betweenVisitNotificationDisplay("unsupported")).toBeUndefined();
  });

  test("the opt-in names what is gained, not what is lost", () => {
    const display = betweenVisitNotificationDisplay("off");

    expect(display?.action).toEqual({
      label: "Notify me between visits",
      turnsOn: true,
    });
    expect(display?.note).toContain("next time you open this app");
  });

  test("an operator who opted in can turn it back off", () => {
    const display = betweenVisitNotificationDisplay("on");

    expect(display?.action?.turnsOn).toBe(false);
    expect(display?.note).toContain("Notifications are on");
  });

  test("a blocked browser offers no control and names the way back", () => {
    const display = betweenVisitNotificationDisplay("blocked");

    expect(display?.action).toBeUndefined();
    expect(display?.note).toContain("browser's settings");
    expect(display?.note).toContain("next time you open the app");
  });
});
