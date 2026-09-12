/**
 * Regenerates the README screenshots from a running SentinelPR dashboard.
 *
 * Usage:
 *   pnpm dev &            # dashboard with seeded/real data
 *   pnpm screenshots      # writes docs/images/*.png
 *
 * Environment:
 *   SCREENSHOT_BASE_URL  dashboard origin (default http://localhost:3000)
 *
 * The script never fabricates product data — it photographs whatever the
 * instance actually shows, so empty instances produce honest empty states.
 * If a page fails to render (missing config, connection error), the script
 * exits non-zero instead of committing a broken screenshot.
 */
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { config } from "dotenv";

config();

const BASE_URL = process.env.SCREENSHOT_BASE_URL ?? "http://localhost:3000";
const OUT_DIR = "docs/images";

interface Shot {
  file: string;
  path: string;
  wait: (page: import("playwright").Page) => Promise<void>;
}

const SHOTS: Shot[] = [
  {
    file: "overview.png",
    path: "/",
    wait: async (page) => page.waitForLoadState("networkidle"),
  },
  {
    file: "pr-detail.png",
    path: "/pull-requests",
    wait: async (page) => page.waitForLoadState("networkidle"),
  },
  {
    file: "visual-run.png",
    path: "/visual",
    wait: async (page) => page.waitForLoadState("networkidle"),
  },
  {
    file: "synthetic-monitor.png",
    path: "/synthetic",
    wait: async (page) => page.waitForLoadState("networkidle"),
  },
];

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2, // crisp retina-quality PNGs
    colorScheme: "dark",
  });

  // OAuth deployments require a session; local single-operator mode does not.
  const token = process.env.SCREENSHOT_SESSION_TOKEN;
  if (token) {
    await page.context().addCookies([
      {
        name: "sentinel_session",
        value: token,
        domain: new URL(BASE_URL).hostname,
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  }

  let failed = false;
  for (const shot of SHOTS) {
    const url = `${BASE_URL}${shot.path}`;
    const res = await page.goto(url, { waitUntil: "domcontentloaded" });
    if (!res || !res.ok()) {
      console.error(`✗ ${shot.file}: ${url} responded ${res?.status() ?? "no response"}`);
      failed = true;
      continue;
    }
    await shot.wait(page);
    await page.screenshot({ path: `${OUT_DIR}/${shot.file}`, fullPage: false });
    console.log(`✓ ${shot.file}`);
  }

  await browser.close();
  if (failed) {
    console.error("\nSome captures failed — fix the dashboard state before committing screenshots.");
    process.exit(1);
  }
  console.log(`\nScreenshots written to ${OUT_DIR}/ — commit them with any UI change.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
