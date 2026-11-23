import { expect, test, type Page } from "@playwright/test";

type SavedMatch = { moves: Array<{ side: string; action: { type: string } }>; resigned?: string | null };

const saved = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem("detour:match") || "null") as SavedMatch | null);

/** Waits until the bot has replied and the race has been saved, so the human is to move. */
async function settle(page: Page) {
  await expect(page.getByText("The bot is thinking…")).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(async () => ((await saved(page))?.moves.length ?? 1) % 2, { timeout: 10_000 }).toBe(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("detour:seen-help", "true");
  });
  await page.reload();
});

test("menu shows the setup and a live demo race", async ({ page }) => {
  await expect(page.getByRole("img", { name: "Detour" })).toBeVisible();
  await expect(page.getByRole("group", { name: "A demo race between two bots" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Start race/ })).toBeVisible();
});

test("a race against the bot: step, bot replies, undo, resign", async ({ page }) => {
  await page.getByRole("button", { name: /Start race/ }).click();
  await page.getByRole("button", { name: "Move to d2" }).click();
  await settle(page);
  expect((await saved(page))!.moves).toHaveLength(2);

  await page.getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await saved(page))!.moves.length).toBe(0);

  await page.getByRole("button", { name: "Move to d2" }).click();
  await settle(page);
  await page.getByRole("button", { name: "Resign" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Resign" }).click();
  await expect(page.getByRole("heading", { name: "You resigned" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Race again/ })).toBeVisible();
});

test("barricades: place one, and an illegal one is explained", async ({ page }) => {
  await page.locator("label", { hasText: "Friend" }).click();
  // No roadworks, so the keyboard cursor's starting slot is free.
  await page.locator("label", { hasText: "Off" }).click();
  await page.getByRole("button", { name: /Start race/ }).click();
  await page.getByRole("button", { name: "Move to d2" }).click();

  // Teal drops a barricade by keyboard: W for barricade mode, arrows to aim, Enter to place.
  await page.keyboard.press("w");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await saved(page))!.moves.at(-1)?.action.type).toBe("wall");

  // Orange tries the exact same slot: refused, with a reason.
  await page.keyboard.press("w");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.locator(".toast", { hasText: "That spot overlaps another barricade." })).toBeVisible();
  expect((await saved(page))!.moves).toHaveLength(2);
});

test("an unfinished race resumes after a reload", async ({ page }) => {
  await page.getByRole("button", { name: /Start race/ }).click();
  await page.getByRole("button", { name: "Move to d2" }).click();
  await settle(page);
  await page.reload();
  await expect(page.getByRole("button", { name: "Undo" })).toBeEnabled();
  expect((await saved(page))!.moves).toHaveLength(2);
});

test("settings switch the theme", async ({ page }) => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("dialog").locator("label", { hasText: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
