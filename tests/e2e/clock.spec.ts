import { expect, test } from "@playwright/test";

const yourClock = (page: import("@playwright/test").Page) =>
  page.locator(".racer").first().locator(".clock .num");

async function startTimedBotRace(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("detour:seen-help", "true");
  });
  await page.reload();
  await page.locator("label", { hasText: "3 min" }).click();
  await page.getByRole("button", { name: /Start race/ }).click();
  await expect(page.locator(".area-board svg.board")).toBeVisible();
}

test("a timed race shows both clocks, runs yours, adds the increment, and has no undo", async ({ page }) => {
  await page.clock.install();
  await startTimedBotRace(page);
  await expect(page.locator(".clock")).toHaveCount(2);
  await expect(yourClock(page)).toHaveText("3:00");
  await expect(page.locator(".bar__meta")).toContainText("3+2");

  await page.clock.runFor(7_000);
  await expect(yourClock(page)).toHaveText("2:53");

  await page.getByRole("button", { name: "Move to d2" }).click();
  // 2:53 left, plus 2 seconds back for the move.
  await expect(yourClock(page)).toHaveText("2:55");
  await page.clock.runFor(2_000); // the bot replies
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
});

// These two run on real time. (Playwright's fake clock moves page timers but not the browser's
// animation timeline, so after a big jump the screen transitions sit waiting for it.)

test("running out of time ends the race", async ({ page }) => {
  await startTimedBotRace(page);
  await expect(yourClock(page)).toHaveText("3:00");
  // Wind the saved race back so the clock has 1.5 seconds left, and pick it up again.
  await page.evaluate(() => {
    const match = JSON.parse(localStorage.getItem("detour:match")!);
    match.clockRun = { turnStartedAt: Date.now() - 178_500, bankedMs: 0 };
    localStorage.setItem("detour:match", JSON.stringify(match));
  });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Out of time" })).toBeVisible({ timeout: 8_000 });
  await expect(page.getByText("Your clock hit zero.")).toBeVisible();
  await expect(yourClock(page)).toHaveText("0:00.0");
});

const seconds = (text: string) => {
  const [m, s] = text.split(":");
  return Number(m) * 60 + Number(s);
};

test("the clock pauses when you leave the race and picks up where it stopped", async ({ page }) => {
  await startTimedBotRace(page);
  await page.waitForTimeout(2_200);
  const before = seconds(await yourClock(page).innerText());
  expect(before).toBeLessThan(180);
  await page.getByRole("button", { name: "Menu" }).click();
  await page.waitForTimeout(4_000); // none of this should come off the clock
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(yourClock(page)).toBeVisible();
  const after = seconds(await yourClock(page).innerText());
  expect(before - after).toBeLessThanOrEqual(1);
});
