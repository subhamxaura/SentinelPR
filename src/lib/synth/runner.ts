import { prisma } from "@/lib/db";
import { err, toAppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getStorage, artifactKey, sha256 } from "@/lib/storage";
import { validatePublicUrl, safeFetch } from "@/lib/net/guard";
import { installBrowserRequestGuard } from "@/lib/net/browser-guard";
import { raiseAlert, resolveAlerts } from "@/lib/alerts";
import { computeMetrics } from "./metrics";
import type { SyntheticStep } from "./steps";

const log = logger.child({ module: "synthetic-runner" });

export const STEP_TIMEOUT_MS = 20_000;
export const RUN_TIMEOUT_MS = 180_000;
export const STALE_RUN_GRACE_MS = 30_000;
export const STALE_RUN_THRESHOLD_MS = RUN_TIMEOUT_MS + STALE_RUN_GRACE_MS; // 210_000ms

export interface StaleRecoveryResult {
  recoveredCount: number;
  runIds: string[];
}

/**
 * Reconciles and terminates stale synthetic runs left behind if a worker
 * process crashed or was killed while runs were queued or running.
 * Runs that have exceeded the maximum execution duration plus grace margin
 * are transitioned to a terminal 'error' state with explanatory messaging.
 * Uses atomic updates to prevent race conditions during concurrent checks.
 */
export async function recoverStaleSyntheticRuns(
  testId?: string,
  opts: { now?: Date; thresholdMs?: number } = {},
): Promise<StaleRecoveryResult> {
  const now = opts.now ?? new Date();
  const threshold = opts.thresholdMs ?? STALE_RUN_THRESHOLD_MS;
  const cutoff = new Date(now.getTime() - threshold);

  const staleRuns = await prisma.syntheticRun.findMany({
    where: {
      ...(testId ? { testId } : {}),
      OR: [
        { status: "running", startedAt: { lt: cutoff } },
        { status: "queued", createdAt: { lt: cutoff } },
      ],
    },
    select: { id: true },
  });

  if (!staleRuns.length) return { recoveredCount: 0, runIds: [] };

  const runIds = staleRuns.map((r) => r.id);
  const updated = await prisma.syntheticRun.updateMany({
    where: {
      id: { in: runIds },
      status: { in: ["queued", "running"] },
    },
    data: {
      status: "error",
      error: `Run abandoned: execution lease expired (> ${Math.round(threshold / 1000)}s) without completion. Worker may have terminated unexpectedly.`,
      completedAt: now,
    },
  });

  if (updated.count > 0) {
    log.warn("Recovered stale synthetic runs", {
      testId,
      recoveredCount: updated.count,
      runIds,
      thresholdMs: threshold,
    });
  }

  return { recoveredCount: updated.count, runIds };
}

function assertRunActive(signal: AbortSignal | undefined, deadline: number): number {
  if (signal?.aborted) {
    throw err.timeout(`Synthetic run aborted after ${RUN_TIMEOUT_MS}ms.`);
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    throw err.timeout(`Synthetic run exceeded ${RUN_TIMEOUT_MS}ms.`);
  }
  return remaining;
}

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
  signal?: AbortSignal;
}): Promise<{ passed: boolean; outcomes: StepOutcome[]; failedStepIndex: number | null; durationMs: number; error: string | null }> {
  const started = Date.now();
  const deadline = started + RUN_TIMEOUT_MS;
  assertRunActive(opts.signal, deadline);

  const outcomes: StepOutcome[] = [];
  const { chromium } = await import("playwright");
  const engine = opts.browser === "firefox" ? (await import("playwright")).firefox : opts.browser === "webkit" ? (await import("playwright")).webkit : chromium;

  const { url: validatedBase } = await validatePublicUrl(opts.baseUrl);
  const browser = await engine.launch({ timeout: Math.min(30_000, assertRunActive(opts.signal, deadline)) });
  const abortBrowser = () => {
    void browser.close().catch(() => undefined);
  };
  opts.signal?.addEventListener("abort", abortBrowser, { once: true });

  let failedStepIndex: number | null = null;
  let runError: string | null = null;

  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, serviceWorkers: "block" });
    await installBrowserRequestGuard(context);
    const page = await context.newPage();

    for (let i = 0; i < opts.steps.length; i++) {
      assertRunActive(opts.signal, deadline);
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
      const stepTimeout = Math.min(STEP_TIMEOUT_MS, assertRunActive(opts.signal, deadline));
      try {
        await executeStep(page, opts.steps[i], validatedBase.origin, { signal: opts.signal, timeoutMs: stepTimeout });
        let screenshot: Buffer | null = null;
        if (opts.steps[i].type === "screenshot") {
          screenshot = await page.screenshot({ timeout: Math.min(STEP_TIMEOUT_MS, assertRunActive(opts.signal, deadline)) });
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
        const remaining = deadline - Date.now();
        if (!opts.signal?.aborted && remaining > 0) {
          try {
            screenshot = await page.screenshot({ timeout: Math.min(5_000, remaining) });
          } catch {
            // page may be destroyed — best effort
          }
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
    await context.close().catch(() => undefined);
    assertRunActive(opts.signal, deadline);
  } finally {
    opts.signal?.removeEventListener("abort", abortBrowser);
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

function withTimeout<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const resolveOnce = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const rejectOnce = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => rejectOnce(new Error("Synthetic run aborted"));
    if (signal?.aborted) {
      rejectOnce(new Error("Synthetic run aborted"));
      return;
    }
    timer = setTimeout(() => rejectOnce(new Error(`Step timed out after ${ms}ms`)), ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(resolveOnce, rejectOnce);
  });
}

async function executeStep(
  page: import("playwright").Page,
  step: SyntheticStep,
  baseUrlOrigin: string,
  opts: { signal?: AbortSignal; timeoutMs: number },
): Promise<void> {
  const { signal, timeoutMs } = opts;

  switch (step.type) {
    case "navigate": {
      const { url } = await validatePublicUrl(new URL(step.url, baseUrlOrigin).toString());
      await withTimeout(page.goto(url.toString(), { waitUntil: "load", timeout: timeoutMs }), timeoutMs, signal);
      return;
    }
    case "click":
      await withTimeout(page.click(step.selector, { timeout: timeoutMs }), timeoutMs, signal);
      return;
    case "fill":
      await withTimeout(page.fill(step.selector, step.value, { timeout: timeoutMs }), timeoutMs, signal);
      return;
    case "press":
      if (step.selector) await page.click(step.selector, { timeout: timeoutMs }).catch(() => undefined);
      if (signal?.aborted) throw new Error("Synthetic run aborted");
      await page.keyboard.press(step.key);
      return;
    case "select":
      await withTimeout(page.selectOption(step.selector, step.value, { timeout: timeoutMs }), timeoutMs, signal);
      return;
    case "wait":
      if (step.selector) {
        await withTimeout(
          page.waitForSelector(step.selector, { timeout: Math.min(step.ms ?? timeoutMs, timeoutMs) }),
          timeoutMs,
          signal,
        );
      } else {
        await withTimeout(page.waitForTimeout(Math.min(step.ms ?? 500, timeoutMs)), timeoutMs, signal);
        if (signal?.aborted) throw new Error("Synthetic run aborted");
      }
      return;
    case "assert_text": {
      const el = page.locator(step.selector).first();
      const actual = await withTimeout(el.textContent({ timeout: timeoutMs }), timeoutMs, signal);
      const text = (actual ?? "").trim();
      const ok = step.contains === false ? text === step.text : text.includes(step.text);
      if (!ok) throw new Error(`Text assertion failed on "${step.selector}": expected ${step.contains === false ? "exact" : "contains"} "${step.text}", got "${text.slice(0, 200)}"`);
      return;
    }
    case "assert_visible": {
      const visible = await withTimeout(page.locator(step.selector).first().isVisible().catch(() => false), timeoutMs, signal);
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
      const target = new URL(step.url, baseUrlOrigin).toString();
      const res = await withTimeout(
        safeFetch(target, {
          method: step.method,
          headers: step.headers,
          body: step.body,
          signal: AbortSignal.timeout(timeoutMs),
        }),
        timeoutMs,
        signal,
      );
      if (step.expectStatus && res.status !== step.expectStatus) {
        throw new Error(`API request ${step.method} ${target} returned ${res.status}, expected ${step.expectStatus}`);
      }
      if (!step.expectStatus && res.status >= 400) {
        throw new Error(`API request ${step.method} ${target} returned ${res.status}`);
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
      signal: runController.signal,
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
