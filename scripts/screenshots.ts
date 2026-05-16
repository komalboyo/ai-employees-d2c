/**
 * Capture screenshots of the running UI for the README.
 *
 * Boot the Next dev server first: `npm run dev` in another terminal.
 * Then: `npx tsx scripts/screenshots.ts`
 *
 * Outputs to docs/screenshots/.
 */

import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

const BASE = process.env.URL ?? "http://localhost:3000";
const OUT = "docs/screenshots";

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 2 });

  // 1. Full morning brief — top-of-page hero shot.
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector("h2:has-text('Morning brief')", { timeout: 15000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/01-morning-brief.png`, fullPage: false });
  console.log("✓ 01-morning-brief.png");

  // 2. Disagreement banner zoom (clip to top of center column).
  const briefSection = await page.$("h2:has-text('Morning brief')");
  if (briefSection) {
    const box = await briefSection.boundingBox();
    if (box) {
      await page.screenshot({
        path: `${OUT}/02-disagreement.png`,
        clip: { x: Math.max(0, box.x - 20), y: Math.max(0, box.y - 30), width: 940, height: 500 },
      });
      console.log("✓ 02-disagreement.png");
    }
  }

  // 3. Citation Inspector modal — click a citation pill from a proposal
  // (use a row_id pill, not the target_entity pill, so the modal renders
  // a real raw_payload).
  await page.waitForTimeout(300);
  const allPills = await page.$$(".cite-pill");
  // Find a pill that looks like `orders:` or `shipments:` (has a real raw_payload).
  let chosen = null;
  for (const p of allPills) {
    const txt = (await p.textContent()) ?? "";
    if (txt.startsWith("orders:") || txt.startsWith("shipments:")) {
      chosen = p;
      break;
    }
  }
  if (chosen) {
    await chosen.scrollIntoViewIfNeeded();
    await chosen.click();
    await page.waitForSelector("text=Citation Inspector", { timeout: 5000 });
    // Wait until the "loading…" text is gone (the fetch completed).
    await page.waitForFunction(
      () => !document.body.innerText.includes("loading…"),
      { timeout: 10000 }
    );
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/03-citation-inspector.png` });
    console.log("✓ 03-citation-inspector.png");
    const closeBtn = await page.$("text=close ✕");
    if (closeBtn) await closeBtn.click();
    await page.waitForTimeout(200);
  } else {
    console.log("  (no row_id pill found — skipping citation inspector)");
  }

  // 4. Chat panel — click a suggested question and wait for response.
  const suggestion = await page.$("text=What's my worst RTO courier?");
  if (suggestion) {
    await suggestion.click();
    await page.waitForFunction(
      () => Array.from(document.querySelectorAll(".panel-2")).some((el) => el.textContent?.includes("Bluedart")),
      { timeout: 30000 }
    );
    await page.waitForTimeout(500);
    // Crop the right column (chat).
    await page.screenshot({
      path: `${OUT}/04-chat-with-citations.png`,
      clip: { x: 1200, y: 80, width: 400, height: 800 },
    });
    console.log("✓ 04-chat-with-citations.png");
  } else {
    console.log("  (suggestion not found — skipping chat)");
  }

  await browser.close();
  console.log(`\n→ wrote ${OUT}/*.png`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
