import { expect, test, type Browser, type Page } from "@playwright/test";

test.describe.configure({ mode: "serial" });

async function player(browser: Browser, name: string, path = "/") {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("detour:seen-help", "true");
  });
  await page.goto(path);
  await page.locator("label", { hasText: "Online" }).click();
  await page.locator("label:has(#roadworks-off)").click(); // no roadworks: predictable moves
  await page.getByLabel("Your name").fill(name);
  return { page, close: () => context.close() };
}

const myTurn = (page: Page) => expect(page.getByText("Your move.")).toBeVisible({ timeout: 10_000 });

test("two players race online: invite, moves, reaction, resign, rematch", async ({ browser }) => {
  const alice = await player(browser, "Alice");
  await alice.page.getByRole("button", { name: "Invite a friend" }).click();
  await expect(alice.page.getByRole("heading", { name: "Waiting for your friend" })).toBeVisible();
  const label = await alice.page.locator(".code").getAttribute("aria-label");
  const code = label!.replace("Race code ", "").replace(/ /g, "");
  expect(code).toMatch(/^[A-Z0-9]{5}$/);

  // Bob follows the invite link: the code is already filled in.
  const bob = await player(browser, "Bob", `/#join-${code.toLowerCase()}`);
  await expect(bob.page.locator("#online-code")).toHaveValue(code);
  await bob.page.getByRole("button", { name: "Join", exact: true }).click();

  // Whoever drew orange moves first.
  await expect(alice.page.locator(".area-board svg.board")).toBeVisible();
  const aliceFirst = await alice.page
    .getByText("Your move.")
    .isVisible()
    .catch(() => false);
  const first = aliceFirst ? alice.page : bob.page;
  const second = aliceFirst ? bob.page : alice.page;
  await myTurn(first);
  await expect(second.getByText(/is thinking/)).toBeVisible();
  // Each sees the other's chosen name on their card.
  await expect(alice.page.locator(".racer__name", { hasText: "Bob" })).toBeVisible();
  await expect(bob.page.locator(".racer__name", { hasText: "Alice" })).toBeVisible();

  await first.getByRole("button", { name: "Move to d2" }).click();
  await myTurn(second);
  await second.getByRole("button", { name: "Move to d6" }).click();
  await myTurn(first);
  await expect(first.locator(".log summary")).toContainText("2");

  await second.getByRole("button", { name: "Nice move" }).click();
  await expect(first.locator(".bubble", { hasText: "Nice move" })).toBeVisible();

  // Bob reloads mid-race and lands back in his seat.
  await bob.page.reload();
  await expect(bob.page.locator(".area-board svg.board")).toBeVisible({ timeout: 10_000 });
  await expect(bob.page.locator(".log summary")).toContainText("2");

  await first.getByRole("button", { name: "Resign" }).click();
  await first.getByRole("dialog").getByRole("button", { name: "Resign" }).click();
  await expect(first.getByRole("heading", { name: "You resigned" })).toBeVisible();
  await expect(second.getByRole("heading", { name: /resigned$/ })).toBeVisible();

  await first.getByRole("button", { name: "Rematch" }).click();
  await expect(second.getByRole("button", { name: "Accept rematch" })).toBeVisible();
  await second.getByRole("button", { name: "Accept rematch" }).click();
  // Sides swap: the player who moved second now moves first.
  await myTurn(second);
  await expect(first.getByText(/is thinking/)).toBeVisible();

  await alice.close();
  await bob.close();
});

test("quick match pairs two strangers on the same board", async ({ browser }) => {
  const carol = await player(browser, "Carol");
  await carol.page.locator("label", { hasText: "Classic" }).click();
  await carol.page.getByRole("button", { name: "Quick match" }).click();
  await expect(carol.page.getByRole("heading", { name: "Finding you an opponent…" })).toBeVisible();

  const dave = await player(browser, "Dave");
  await dave.page.locator("label", { hasText: "Classic" }).click();
  await dave.page.getByRole("button", { name: "Quick match" }).click();

  for (const page of [carol.page, dave.page]) {
    await expect(page.locator(".area-board svg.board")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(".bar__meta")).toContainText("9×9");
  }
  await carol.close();
  await dave.close();
});

test("timed online race: both players see the same clock running for whoever is to move", async ({
  browser,
}) => {
  const erin = await player(browser, "Erin");
  await erin.page.locator("label", { hasText: "3 min" }).click();
  await erin.page.getByRole("button", { name: "Invite a friend" }).click();
  await expect(erin.page.locator(".lobby")).toContainText("3+2 clock");
  const label = await erin.page.locator(".code").getAttribute("aria-label");
  const code = label!.replace("Race code ", "").replace(/ /g, "");

  const frank = await player(browser, "Frank", `/#join-${code.toLowerCase()}`);
  await frank.page.getByRole("button", { name: "Join", exact: true }).click();

  for (const page of [erin.page, frank.page]) {
    await expect(page.locator(".clock")).toHaveCount(2);
    await expect(page.locator(".clock--running")).toHaveCount(1);
    await expect(page.locator(".bar__meta")).toContainText("3+2");
  }
  // The running clock belongs to the same racer on both screens: orange moves first.
  const orangeRunning = (page: Page) =>
    page
      .locator(".racer", { has: page.locator(".clock--running") })
      .evaluate((el) => el.getAttribute("style"));
  expect(await orangeRunning(erin.page)).toContain("--south");
  expect(await orangeRunning(frank.page)).toContain("--south");

  await erin.close();
  await frank.close();
});
