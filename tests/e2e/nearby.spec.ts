import { expect, test, type Browser, type Page } from "@playwright/test";

// Two browsers on this machine link directly over WebRTC, the way two devices on one Wi-Fi do.
test.describe.configure({ mode: "serial" });

async function device(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  await page.goto("/");
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("detour:seen-help", "true");
  });
  await page.reload();
  return { page, close: () => context.close() };
}

async function host(browser: Browser, name: string) {
  const d = await device(browser);
  await d.page.locator("label", { hasText: "Nearby" }).click();
  await d.page.locator("label:has(#roadworks-off)").click(); // no roadworks: predictable moves
  await d.page.getByLabel("Your name").fill(name);
  await d.page.getByRole("button", { name: "Host on this device" }).click();
  await expect(d.page.getByRole("heading", { name: "Pair the other device" })).toBeVisible();
  return d;
}

/** What a QR code on the page holds (the same link a camera would open). */
const qrLink = async (page: Page, label: string) => {
  const qr = page.getByRole("img", { name: label });
  await expect(qr).toBeVisible({ timeout: 10_000 });
  return (await qr.getAttribute("data-qr"))!;
};

/** The guest "scans" the host's code, and the host takes the guest's reply. */
async function pair(hostPage: Page, guestPage: Page, guestName?: string) {
  const invite = await qrLink(hostPage, "Invite QR code");
  expect(invite).toMatch(/#nearby-1o[A-Z0-9]{5}\.b[\w-]+$/);
  await guestPage.goto(invite);
  await expect(guestPage.getByRole("heading", { name: "Show this to the host" })).toBeVisible();
  if (guestName) await guestPage.getByLabel("Your name").fill(guestName);
  const reply = await qrLink(guestPage, "Reply QR code");
  expect(reply).toMatch(/#nearby-1a\.b[\w-]+$/);
  await hostPage.getByLabel("Reply code").fill(reply);
  await hostPage.getByRole("button", { name: "Connect" }).click();
}

const board = (page: Page) => expect(page.locator(".area-board svg.board")).toBeVisible({ timeout: 15_000 });
const myTurn = (page: Page) => expect(page.getByText("Your move.")).toBeVisible({ timeout: 10_000 });

async function whoFirst(a: Page, b: Page): Promise<[Page, Page]> {
  await board(a);
  await board(b);
  const aFirst = await a
    .getByText("Your move.")
    .isVisible()
    .catch(() => false);
  return aFirst ? [a, b] : [b, a];
}

test("two devices pair with QR codes, race, and pair again after a drop", async ({ browser }) => {
  const ana = await host(browser, "Ana");
  const ben = await device(browser);
  await pair(ana.page, ben.page, "Ben");

  const [first, second] = await whoFirst(ana.page, ben.page);
  await myTurn(first);
  await expect(ana.page.locator(".racer__name", { hasText: "Ben" })).toBeVisible();
  await expect(ben.page.locator(".racer__name", { hasText: "Ana" })).toBeVisible();
  await first.getByRole("button", { name: "Move to d2" }).click();
  await myTurn(second);
  await second.getByRole("button", { name: "Move to d6" }).click();
  await myTurn(first);

  // Ben's page goes away (a reload here; a phone that slept is the same): Ana is told, and pairs again.
  await ben.page.reload();
  await expect(ana.page.getByText(/dropped/).first()).toBeVisible({ timeout: 15_000 });
  await ana.page.getByRole("button", { name: "Pair again" }).click();
  await expect(ana.page.getByRole("dialog", { name: "Pair again" })).toBeVisible();
  await pair(ana.page, ben.page);

  // Ben is back in his own seat, with the race where it was.
  await expect(ana.page.getByRole("dialog")).toBeHidden({ timeout: 15_000 });
  await board(ben.page);
  await expect(ben.page.locator(".log summary")).toContainText("2");
  await expect(ben.page.locator(".racer__name", { hasText: "Ana" })).toBeVisible();
  await myTurn(first);
  await first.getByRole("button", { name: "Move to d3" }).click();
  await myTurn(second);

  await ana.close();
  await ben.close();
});

test("the host's tab can reload mid-race and the race carries on", async ({ browser }) => {
  const cy = await host(browser, "Cy");
  const di = await device(browser);
  await pair(cy.page, di.page, "Di");
  const [first, second] = await whoFirst(cy.page, di.page);
  await first.getByRole("button", { name: "Move to d2" }).click();
  await myTurn(second);

  await cy.page.reload();
  await board(cy.page);
  await expect(cy.page.locator(".log summary")).toContainText("1");
  await expect(di.page.getByText(/Lost the link/).first()).toBeVisible({ timeout: 15_000 });
  await cy.page.getByRole("button", { name: "Pair again" }).click();
  await pair(cy.page, di.page);
  await expect(cy.page.getByRole("dialog")).toBeHidden({ timeout: 15_000 });
  await myTurn(second);
  await second.getByRole("button", { name: "Move to d6" }).click();
  await myTurn(first);

  await cy.close();
  await di.close();
});
