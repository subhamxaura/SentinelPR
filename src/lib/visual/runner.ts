import { prisma } from "@/lib/db";
import { err, toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getStorage, artifactKey, sha256 } from "@/lib/storage";
import { validatePublicUrl } from "@/lib/net/guard";
import { comparePngs } from "./diff";
import { DOM_SIGNATURE_EXPRESSION, diffDomSignatures, type DomSignature } from "./dom";
import { raiseAlert, resolveAlerts } from "@/lib/alerts";

const log = logger.child({ module: "visual-runner" });

type BrowserName = "chromium" | "firefox" | "webkit";

export interface ViewportConfig {
  label: string;
  width: number;
  height: number;
}

/** Wait until the suite's readiness URL responds 2xx/3xx, or throw a timeout error. */
async function waitForReadiness(baseUrl: string, readinessPath: string, timeoutMs: number): Promise<void> {
  const { url } = await validatePublicUrl(new URL(readinessPath, baseUrl).toString());
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
      if (res.status < 400) return;
      lastError = new Error(`readiness returned ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw err.timeout(`Readiness URL did not become healthy within ${timeoutMs}ms: ${lastError instanceof Error ? lastError.message : "unknown"}`);
}

async function launchBrowser(browserName: BrowserName) {
  const { chromium, firefox, webkit } = await import("playwright");
  const registry = { chromium, firefox, webkit };
  const engine = registry[browserName] ?? chromium;
  try {
    return await engine.launch({ args: ["--force-device-scale-factor=1"] });
  } catch (e) {
    throw toAppError(e);
  }
}

const STABILITY_CSS = `
  *, *::before, *::after {
    animation-play-state: paused !important;
    transition: none !important;
    caret-color: transparent !important;
  }
`;

async function capturePage(opts: {
  browserName: BrowserName;
  url: string;
  viewport: ViewportConfig;
  fullPage: boolean;
  timeoutMs: number;
}): Promise<{ png: Buffer; signature: DomSignature; userAgent: string }> {
  const { url } = await validatePublicUrl(opts.url);
  const browser = await launchBrowser(opts.browserName);
  try {
    const context = await browser.newContext({
      viewport: { width: opts.viewport.width, height: opts.viewport.height },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
      timezoneId: "UTC",
      locale: "en-US",
    });
    const page = await context.newPage();
    await page.goto(url.toString(), { waitUntil: "load", timeout: opts.timeoutMs });
    try {
      await page.waitForLoadState("networkidle", { timeout: 10_000 });
    } catch {
      // networkidle is best-effort; long-polling pages would never settle.
    }
    await page.addStyleTag({ content: STABILITY_CSS });
    await page.waitForTimeout(250); // let fonts/images settle after style freeze

    const png = await page.screenshot({ fullPage: opts.fullPage, animations: "disabled" });
    const signature = (await page.evaluate(DOM_SIGNATURE_EXPRESSION)) as DomSignature;
    const userAgent = await page.evaluate(() => navigator.userAgent);
    await context.close();
    return { png, signature, userAgent };
  } finally {
    await browser.close();
  }
}

/** Process a visual run: capture → compare → persist snapshots/artifacts. */
export async function processVisualRun(visualRunId: string): Promise<void> {
  const run = await prisma.visualRun.findUnique({
    where: { id: visualRunId },
    include: { suite: true, test: true },
  });
  if (!run || (run.status !== "queued" && run.status !== "running")) {
    log.info("Visual run not found or not pending", { visualRunId });
    return;
  }

  await prisma.visualRun.update({ where: { id: run.id }, data: { status: "running", startedAt: new Date() } });

  const tests = run.test
    ? [run.test]
    : await prisma.visualTest.findMany({ where: { suiteId: run.suiteId, enabled: true } });
  if (!tests.length) {
    await prisma.visualRun.update({
      where: { id: run.id },
      data: { status: "error", error: "Suite has no enabled tests", completedAt: new Date() },
    });
    return;
  }

  const storage = getStorage();
  let anyFailed = false;
  let worstRatio = 0;
  let firstError: string | null = null;

  try {
    await waitForReadiness(run.suite.baseUrl, run.suite.readinessPath, run.suite.readinessTimeoutMs);
  } catch (e) {
    const appErr = toAppError(e);
    await prisma.visualRun.update({
      where: { id: run.id },
      data: { status: "error", error: appErr.message, completedAt: new Date() },
    });
    log.warn("Visual run readiness failed", { visualRunId, error: appErr.message });
    return;
  }

  for (const test of tests) {
    const browsers = parseBrowsers(test.browsers);
    const viewports = parseViewports(test.viewports);
    for (const browserName of browsers) {
      for (const viewport of viewports) {
        try {
          const capture = await capturePage({
            browserName,
            url: new URL(test.path, run.suite.baseUrl).toString(),
            viewport,
            fullPage: test.fullPage,
            timeoutMs: 30_000,
          });

          const currentKey = artifactKey(run.suite.organizationId, "screenshot");
          await storage.put(currentKey, capture.png, "image/png");
          const currentArtifact = await prisma.artifact.create({
            data: {
              organizationId: run.suite.organizationId,
              kind: "screenshot",
              storageKey: currentKey,
              contentType: "image/png",
              sizeBytes: capture.png.length,
              sha256: sha256(capture.png),
            },
          });

          const baseline = await prisma.visualBaseline.findFirst({
            where: { testId: test.id, browser: browserName, viewportLabel: viewport.label, active: true },
            include: { artifact: true },
          });

          let status: "passed" | "failed" | "new" | "baseline_missing" = "new";
          let diffRatio: number | null = null;
          let changedRegions: object | null = null;
          let domChanges: object | null = null;
          let diffArtifactId: string | null = null;

          if (!baseline) {
            status = "baseline_missing";
          } else {
            const baselinePng = await storage.get(baseline.artifact.storageKey);
            const result = comparePngs(baselinePng, capture.png);
            diffRatio = result.diffRatio;
            worstRatio = Math.max(worstRatio, result.diffRatio);
            if (result.diffPng && result.diffRatio > 0) {
              const diffKey = artifactKey(run.suite.organizationId, "diff");
              await storage.put(diffKey, result.diffPng, "image/png");
              const diffArtifact = await prisma.artifact.create({
                data: {
                  organizationId: run.suite.organizationId,
                  kind: "diff",
                  storageKey: diffKey,
                  contentType: "image/png",
                  sizeBytes: result.diffPng.length,
                  sha256: sha256(result.diffPng),
                },
              });
              diffArtifactId = diffArtifact.id;
            }
            changedRegions = result.changedRegions;
            status = result.diffRatio <= test.threshold ? "passed" : "failed";
          }

          // DOM / experience diff: compare against the signature captured when the
          // active baseline originated (earliest snapshot for this test/browser/viewport).
          if (baseline) {
            const originSnapshot = await prisma.visualSnapshot.findFirst({
              where: { testId: test.id, browser: browserName, viewportLabel: viewport.label },
              orderBy: { createdAt: "asc" },
              select: { metadata: true },
            });
            const originSignature = (originSnapshot?.metadata as { domSignature?: DomSignature } | null)?.domSignature;
            if (originSignature) {
              const changes = diffDomSignatures(originSignature, capture.signature);
              if (changes.length) domChanges = changes;
            }
          }

          await prisma.visualSnapshot.create({
            data: {
              runId: run.id,
              testId: test.id,
              browser: browserName,
              viewportLabel: viewport.label,
              viewport: { label: viewport.label, width: viewport.width, height: viewport.height },
              status,
              diffRatio,
              currentArtifactId: currentArtifact.id,
              diffArtifactId,
              baselineId: baseline?.id ?? null,
              ...(changedRegions ? { changedRegions } : {}),
              ...(domChanges ? { domChanges } : {}),
              metadata: {
                url: new URL(test.path, run.suite.baseUrl).toString(),
                userAgent: capture.userAgent,
                domSignature: {
                  url: capture.signature.url,
                  title: capture.signature.title,
                  headings: capture.signature.headings,
                  controls: capture.signature.controls,
                },
              },
            },
          });

          if (status === "failed") {
            anyFailed = true;
            await raiseAlert({
              organizationId: run.suite.organizationId,
              type: "visual_regression",
              severity: "warning",
              title: `Visual regression: ${test.name} (${browserName}/${viewport.label})`,
              body: `diffRatio ${(diffRatio ?? 0).toFixed(4)} exceeded threshold ${test.threshold}.`,
              entityType: "visual_test",
              entityId: test.id,
              dedupKey: `visual_regression:${test.id}:${browserName}:${viewport.label}`,
            });
          } else if (status === "passed") {
            await resolveAlerts(run.suite.organizationId, `visual_regression:${test.id}:`);
          }
        } catch (e) {
          const appErr = toAppError(e);
          firstError = firstError ?? appErr.message;
          log.error("Snapshot capture failed", { visualRunId, testId: test.id, error: appErr.toJSON() });
        }
      }
    }
  }

  await prisma.visualRun.update({
    where: { id: run.id },
    data: {
      status: firstError && !anyFailed && worstRatio === 0 ? "error" : anyFailed ? "failed" : "passed",
      diffRatio: worstRatio > 0 ? worstRatio : null,
      error: firstError,
      completedAt: new Date(),
    },
  });
  log.info("Visual run completed", { visualRunId, failed: anyFailed, worstRatio });
}

export function parseBrowsers(raw: unknown): BrowserName[] {
  if (!Array.isArray(raw)) return ["chromium"];
  const valid = raw.filter((b): b is BrowserName => b === "chromium" || b === "firefox" || b === "webkit");
  return valid.length ? valid : ["chromium"];
}

export function parseViewports(raw: unknown): ViewportConfig[] {
  if (!Array.isArray(raw)) return [{ label: "desktop", width: 1280, height: 720 }];
  const valid = raw
    .map((v) => v as { label?: unknown; width?: unknown; height?: unknown })
    .filter((v) => typeof v.width === "number" && typeof v.height === "number" && typeof v.label === "string")
    .map((v) => ({ label: v.label as string, width: v.width as number, height: v.height as number }));
  return valid.length ? valid : [{ label: "desktop", width: 1280, height: 720 }];
}
