import { prisma } from "@/lib/db";
import { toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getStorage, artifactKey, sha256 } from "@/lib/storage";
import { validatePublicUrl } from "@/lib/net/guard";
import { raiseAlert, resolveAlerts } from "@/lib/alerts";
import { computeMetrics } from "./metrics";
import type { SyntheticStep } from "./steps";

const log = logger.child({ module: "synthetic-runner" });

const STEP_TIMEOUT_MS = 20_000;
const RUN_TIMEOUT_MS = 180_000;

export interface StepOutcome {
  index: number;
  type: string;
  name: string | null;
  status: "passed" | "failed" | "skipped";
  durationMs: number | null;
  error: string | null;
  screenshot: Buffer | null;
}

/** Execute one synthetic test: steps in order, first failure stops the journey. */
export async function executeSyntheticTest(opts: {
  organizationId: string;
  baseUrl: string;
  steps: SyntheticStep[];
  browser?: string;
}): Promise<{ passed: boolean; outcomes: StepOutcome[]; failedStepIndex: number | null; durationMs: number; error: string | null }> {
  const started = Date.now();
  const outcomes: StepOutcome[] = [];
  const { chromium } = await import("playwright");
  const engine = opts.browser === "firefox" ? (await import("playwright")).firefox : opts.browser === "webkit" ? (await import("playwright")).webkit : chromium;

  const { url: validatedBase } = await validatePublicUrl(opts.baseUrl);
  const browser = await engine.launch();
  let failedStepIndex: number | null = null;
  let runError: string | null = null;

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();

    for (let i = 0; i < opts.steps.length; i++) {
      if (failedStepIndex !== null) {
        outcomes.push({
          index: i,
          type: opts.steps[i].type,
          name: opts.steps[i].name ?? null,
          status: "skipped",
          durationMs: null,
          error: null,
          screenshot: null,
        });
        continue;
      }
      const stepStart = Date.now();
      try {
        await executeStep(page, opts.steps[i], validatedBase.origin);
        let screenshot: Buffer | null = null;
        if (opts.steps[i].type === "screenshot") {
          screenshot = await page.screenshot();
        }
        outcomes.push({
          index: i,
          type: opts.steps[i].type,
          name: opts.steps[i].name ?? null,
          status: "passed",
          durationMs: Date.now() - stepStart,
          error: null,
          screenshot,
        });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        let screenshot: Buffer | null = null;
        try {
          screenshot = await page.screenshot();
        } catch {
          // page may be destroyed — best effort
        }
        outcomes.push({
          index: i,
          type: opts.steps[i].type,
          name: opts.steps[i].name ?? null,
          status: "failed",
          durationMs: Date.now() - stepStart,
          error: message.slice(0, 2000),
          screenshot,
        });
        failedStepIndex = i;
        runError = `Step ${i + 1} (${opts.steps[i].type}${opts.steps[i].name ? `: ${opts.steps[i].name}` : ""}) failed: ${message}`;
      }
    }
    await context.close();
  } finally {
    await browser.close().catch(() => undefined);
  }

  return {
    passed: failedStepIndex === null,
    outcomes,
    failedStepIndex,
    durationMs: Date.now() - started,
    error: runError,
  };
}

async function executeStep(
  page: import("playwright").Page,
  step: SyntheticStep,
  baseUrlOrigin: string,
): Promise<void> {
  const withTimeout = <T>(p: Promise<T>, ms = STEP_TIMEOUT_MS): Promise<T> =>
    Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Step timed out after ${ms}ms`)), ms)),
    ]);

  switch (step.type) {
    case "navigate": {
      const { url } = await validatePublicUrl(new URL(step.url, baseUrlOrigin).toString());
      await withTimeout(page.goto(url.toString(), { waitUntil: "load", timeout: STEP_TIMEOUT_MS }));
      return;
    }
    case "click":
      await withTimeout(page.click(step.selector, { timeout: STEP_TIMEOUT_MS }));
      return;
    case "fill":
      await withTimeout(page.fill(step.selector, step.value, { timeout: STEP_TIMEOUT_MS }));
      return;
    case "press":
      if (step.selector) await page.click(step.selector, { timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
      await page.keyboard.press(step.key);
      return;
    case "select":
      await withTimeout(page.selectOption(step.selector, step.value, { timeout: STEP_TIMEOUT_MS }));
      return;
    case "wait":
      if (step.selector) await page.waitForSelector(step.selector, { timeout: Math.min(step.ms ?? STEP_TIMEOUT_MS, STEP_TIMEOUT_MS) });
      else await page.waitForTimeout(step.ms ?? 500);
      return;
    case "assert_text": {
      const el = page.locator(step.selector).first();
      const actual = await withTimeout(el.textContent({ timeout: STEP_TIMEOUT_MS }));
      const text = (actual ?? "").trim();
      const ok = step.contains === false ? text === step.text : text.includes(step.text);
      if (!ok) throw new Error(`Text assertion failed on "${step.selector}": expected ${step.contains === false ? "exact" : "contains"} "${step.text}", got "${text.slice(0, 200)}"`);
      return;
    }
    case "assert_visible": {
      const visible = await page.locator(step.selector).first().isVisible().catch(() => false);
      if (!visible) throw new Error(`Element "${step.selector}" is not visible`);
      return;
    }
    case "assert_url": {
      const current = page.url();
      const target = new URL(step.url, baseUrlOrigin).toString();
      if (current !== target && !current.startsWith(target)) {
        throw new Error(`URL assertion failed: expected "${target}", got "${current}"`);
      }
      return;
    }
    case "screenshot":
      // Screenshots on success are captured by the runner below; nothing to assert.
      return;
    case "request": {
      const { url } = await validatePublicUrl(new URL(step.url, baseUrlOrigin).toString());
      const res = await withTimeout(
        fetch(url, {
          method: step.method,
          headers: step.headers,
          body: step.body,
          signal: AbortSignal.timeout(STEP_TIMEOUT_MS),
        }),
      );
      if (step.expectStatus && res.status !== step.expectStatus) {
        throw new Error(`API request ${step.method} ${url} returned ${res.status}, expected ${step.expectStatus}`);
      }
      if (!step.expectStatus && res.status >= 400) {
        throw new Error(`API request ${step.method} ${url} returned ${res.status}`);
      }
      return;
    }
  }
}

/** Worker entry: run a synthetic test row through to persisted results + alerts. */
export async function processSyntheticRun(syntheticRunId: string): Promise<void> {
  const run = await prisma.syntheticRun.findUnique({
    where: { id: syntheticRunId },
    include: { test: true },
  });
  if (!run || (run.status !== "queued" && run.status !== "running")) {
    log.info("Synthetic run not found or not pending", { syntheticRunId });
    return;
  }

  await prisma.syntheticRun.update({ where: { id: run.id }, data: { status: "running", startedAt: new Date() } });

  const storage = getStorage();
  let steps: SyntheticStep[];
  try {
    steps = run.test.steps as SyntheticStep[];
    if (!Array.isArray(steps) || !steps.length) throw new Error("Test has no steps");
  } catch (e) {
    await prisma.syntheticRun.update({
      where: { id: run.id },
      data: { status: "error", error: `Invalid step configuration: ${toAppError(e).message}`, completedAt: new Date() },
    });
    return;
  }

  const runController = new AbortController();
  const killTimer = setTimeout(() => runController.abort(), RUN_TIMEOUT_MS);
  try {
    const result = await executeSyntheticTest({
      organizationId: run.test.organizationId,
      baseUrl: run.test.baseUrl,
      steps,
      browser: run.browser,
    });
    clearTimeout(killTimer);

    // Persist step results — screenshots exist on failures and explicit screenshot steps.
    for (const outcome of result.outcomes) {
      let screenshotArtifactId: string | null = null;
      if (outcome.screenshot) {
        const key = artifactKey(run.test.organizationId, "screenshot");
        await storage.put(key, outcome.screenshot, "image/png");
        const artifact = await prisma.artifact.create({
          data: {
            organizationId: run.test.organizationId,
            kind: "screenshot",
            storageKey: key,
            contentType: "image/png",
            sizeBytes: outcome.screenshot.length,
            sha256: sha256(outcome.screenshot),
          },
        });
        screenshotArtifactId = artifact.id;
      }

      await prisma.syntheticStepResult.create({
        data: {
          runId: run.id,
          index: outcome.index,
          type: outcome.type,
          name: outcome.name,
          status: outcome.status,
          durationMs: outcome.durationMs,
          error: outcome.error,
          screenshotArtifactId,
        },
      });
    }

    await prisma.syntheticRun.update({
      where: { id: run.id },
      data: {
        status: result.passed ? "passed" : "failed",
        durationMs: result.durationMs,
        failedStepIndex: result.failedStepIndex,
        error: result.error,
        completedAt: new Date(),
      },
    });

    await evaluateSyntheticAlerts(run.test.organizationId, run.testId, run.test.name, run.test.alertLatencyMs, run.test.maxConsecutiveFailures, result.passed, result.durationMs);
    log.info("Synthetic run completed", { syntheticRunId, passed: result.passed, durationMs: result.durationMs });
  } catch (e) {
    clearTimeout(killTimer);
    const appErr = toAppError(e);
    await prisma.syntheticRun.update({
      where: { id: run.id },
      data: { status: "error", error: appErr.message, completedAt: new Date() },
    });
    log.error("Synthetic run errored", { syntheticRunId, error: appErr.toJSON() });
  }
}

async function evaluateSyntheticAlerts(
  organizationId: string,
  testId: string,
  testName: string,
  alertLatencyMs: number | null,
  maxConsecutiveFailures: number,
  justPassed: boolean,
  durationMs: number,
): Promise<void> {
  const recent = await prisma.syntheticRun.findMany({
    where: { testId, status: { in: ["passed", "failed"] } },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { status: true, durationMs: true },
  });
  const metrics = computeMetrics(recent.map((r) => ({ status: r.status, durationMs: r.durationMs })));

  if (justPassed) {
    await resolveAlerts(organizationId, `synthetic_failure:${testId}`);
    await resolveAlerts(organizationId, `consecutive_failures:${testId}`);
  } else {
    await raiseAlert({
      organizationId,
      type: "synthetic_failure",
      severity: "warning",
      title: `Synthetic test failed: ${testName}`,
      body: `Latest run failed in ${(durationMs / 1000).toFixed(1)}s.`,
      entityType: "synthetic_test",
      entityId: testId,
      dedupKey: `synthetic_failure:${testId}`,
    });
  }

  if (metrics.consecutiveFailures >= maxConsecutiveFailures) {
    await raiseAlert({
      organizationId,
      type: "consecutive_failures",
      severity: "critical",
      title: `${testName}: ${metrics.consecutiveFailures} consecutive failures`,
      body: "The monitor is failing repeatedly — the user journey is likely broken in production.",
      entityType: "synthetic_test",
      entityId: testId,
      dedupKey: `consecutive_failures:${testId}`,
    });
  }

  if (alertLatencyMs && metrics.p95Ms !== null && metrics.p95Ms > alertLatencyMs) {
    await raiseAlert({
      organizationId,
      type: "latency_threshold",
      severity: "warning",
      title: `${testName}: P95 latency ${metrics.p95Ms}ms exceeds ${alertLatencyMs}ms`,
      entityType: "synthetic_test",
      entityId: testId,
      dedupKey: `latency_threshold:${testId}`,
    });
  }
}
