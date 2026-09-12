"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button, Input, Select, Label, Card, CardHeader, Textarea, StatusBadge } from "./primitives";

/* All mutations go through the REST API — the server enforces org scoping,
   validation (zod), SSRF guards and audit logging. These forms only talk to it. */

async function post(url: string, body?: unknown, method: "POST" | "PATCH" | "PUT" | "DELETE" = "POST"): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return { ok: true };
    const data = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
    return { ok: false, error: data?.error?.message ?? `Request failed (${res.status})` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Network error" };
  }
}

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return <p className="mt-2 rounded border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 font-mono text-xs text-red-400">{error}</p>;
}

function SuccessLine({ children }: { children: ReactNode }) {
  return <p className="mt-2 rounded border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 text-xs text-emerald-400">{children}</p>;
}

/* ── Repositories ──────────────────────────────────────────────────────── */

export function AddRepositoryForm() {
  const router = useRouter();
  const [fullName, setFullName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await post("/api/repositories", { fullName: fullName.trim() });
    setBusy(false);
    if (result.ok) {
      setFullName("");
      router.refresh();
    } else {
      setError(result.error ?? null);
    }
  };

  return (
    <Card className="mb-6">
      <CardHeader title="Add repository" sub="Verifies access through the configured GitHub credentials before registering it." />
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2 px-4 py-3">
        <div className="min-w-[240px] flex-1">
          <Label>Repository (owner/name)</Label>
          <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="vercel/next.js" required />
        </div>
        <Button type="submit" variant="primary" disabled={busy || !fullName.trim()}>
          {busy ? "Adding…" : "Add repository"}
        </Button>
      </form>
      <ErrorLine error={error} />
      {error === null && busy === false ? null : null}
    </Card>
  );
}

export function TriggerReviewForm({ repositoryId }: { repositoryId: string }) {
  const router = useRouter();
  const [pullNumber, setPullNumber] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setQueued(false);
    const result = await post(`/api/repositories/${repositoryId}/review`, { pullNumber: Number(pullNumber) });
    setBusy(false);
    if (result.ok) {
      setQueued(true);
      setPullNumber("");
      setTimeout(() => router.refresh(), 800);
    } else {
      setError(result.error ?? null);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 px-4 py-3">
      <div className="w-40">
        <Label>PR number</Label>
        <Input type="number" min={1} value={pullNumber} onChange={(e) => setPullNumber(e.target.value)} placeholder="42" required />
      </div>
      <Button type="submit" variant="primary" disabled={busy || !pullNumber}>
        {busy ? "Queueing…" : "Review PR"}
      </Button>
      {queued ? <SuccessLine>Review queued — refresh in a moment.</SuccessLine> : null}
      <ErrorLine error={error} />
    </form>
  );
}

/* ── Visual suites ─────────────────────────────────────────────────────── */

export function CreateSuiteForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await post("/api/visual/suites", { name, baseUrl });
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      setName("");
      setBaseUrl("");
      router.refresh();
    } else {
      setError(result.error ?? null);
    }
  };

  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        New suite
      </Button>
    );
  }

  return (
    <Card className="w-full max-w-xl">
      <CardHeader title="New visual suite" sub="Points at a running web app. Private/local URLs need SENTINEL_ALLOW_PRIVATE_TARGETS=1." />
      <form onSubmit={submit} className="space-y-3 px-4 py-3">
        <div>
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Marketing site" required />
        </div>
        <div>
          <Label>Base URL</Label>
          <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://app.example.com" type="url" required />
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Creating…" : "Create suite"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
        <ErrorLine error={error} />
      </form>
    </Card>
  );
}

export function CreateTestForm({ suiteId }: { suiteId: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [path, setPath] = useState("/");
  const [threshold, setThreshold] = useState("0.1");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const result = await post(`/api/visual/suites/${suiteId}/tests`, {
      name,
      path,
      threshold: Number(threshold),
      browsers: ["chromium"],
      viewports: [
        { label: "desktop", width: 1280, height: 720 },
        { label: "mobile", width: 390, height: 844 },
      ],
    });
    setBusy(false);
    if (result.ok) {
      setName("");
      setPath("/");
      router.refresh();
    } else {
      setError(result.error ?? null);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 px-4 py-3">
      <div className="min-w-[180px] flex-1">
        <Label>Test name</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Homepage" required />
      </div>
      <div className="w-48">
        <Label>Path</Label>
        <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/pricing" required />
      </div>
      <div className="w-28">
        <Label>Threshold</Label>
        <Input value={threshold} onChange={(e) => setThreshold(e.target.value)} type="number" step="0.01" min="0" max="1" />
      </div>
      <Button type="submit" variant="primary" disabled={busy}>
        {busy ? "Adding…" : "Add test"}
      </Button>
      <div className="w-full">
        <ErrorLine error={error} />
      </div>
    </form>
  );
}

export function RunVisualButton({
  suiteId,
  testId,
  label = "Run now",
}: {
  suiteId: string;
  testId?: string;
  label?: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await post("/api/visual/runs", { suiteId, ...(testId ? { testId } : {}) });
          setBusy(false);
          if (result.ok) router.refresh();
          else setError(result.error ?? null);
        }}
      >
        {busy ? "Queueing…" : label}
      </Button>
      {error ? <span className="font-mono text-[11px] text-red-400">{error}</span> : null}
    </span>
  );
}

export function ApproveBaselineButton({ snapshotId }: { snapshotId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        variant="primary"
        disabled={busy || done}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await post(`/api/visual/snapshots/${snapshotId}/approve`);
          setBusy(false);
          if (result.ok) {
            setDone(true);
            router.refresh();
          } else setError(result.error ?? null);
        }}
      >
        {done ? "Approved ✓" : busy ? "Approving…" : "Approve as baseline"}
      </Button>
      {error ? <span className="font-mono text-[11px] text-red-400">{error}</span> : null}
    </span>
  );
}

/* ── Synthetic monitors ────────────────────────────────────────────────── */

const STEP_TEMPLATES: Array<{ label: string; make: () => object }> = [
  { label: "navigate", make: () => ({ type: "navigate", url: "/" }) },
  { label: "click", make: () => ({ type: "click", selector: "text=Sign in" }) },
  { label: "fill", make: () => ({ type: "fill", selector: "input[name=email]", value: "user@example.com" }) },
  { label: "wait", make: () => ({ type: "wait", ms: 1000 }) },
  { label: "assert_text", make: () => ({ type: "assert_text", selector: "h1", text: "Dashboard" }) },
  { label: "assert_visible", make: () => ({ type: "assert_visible", selector: "[data-testid=user-menu]" }) },
  { label: "assert_url", make: () => ({ type: "assert_url", url: "/dashboard" }) },
  { label: "screenshot", make: () => ({ type: "screenshot", name: "after-login" }) },
  { label: "request", make: () => ({ type: "request", method: "GET", url: "/api/health", expectStatus: 200 }) },
];

export function CreateSyntheticTestForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [cron, setCron] = useState("*/15 * * * *");
  const [stepsText, setStepsText] = useState(
    JSON.stringify(
      [
        { type: "navigate", url: "/" },
        { type: "screenshot", name: "landing" },
      ],
      null,
      2,
    ),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    let steps: unknown;
    try {
      steps = JSON.parse(stepsText);
    } catch {
      setBusy(false);
      setError("Steps is not valid JSON");
      return;
    }
    const result = await post("/api/synthetic/tests", {
      name,
      baseUrl,
      steps,
      schedule: cron.trim() ? { cron: cron.trim(), timezone: "UTC" } : undefined,
    });
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      router.refresh();
    } else {
      setError(result.error ?? null);
    }
  };

  if (!open) {
    return (
      <Button variant="primary" onClick={() => setOpen(true)}>
        New monitor
      </Button>
    );
  }

  return (
    <Card className="w-full max-w-2xl">
      <CardHeader title="New synthetic monitor" sub="A user journey executed on schedule. Steps map 1:1 to Playwright actions." />
      <form onSubmit={submit} className="space-y-3 px-4 py-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Login journey" required />
          </div>
          <div>
            <Label>Base URL</Label>
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} type="url" placeholder="https://app.example.com" required />
          </div>
          <div>
            <Label>Schedule (cron, empty = manual only)</Label>
            <Input value={cron} onChange={(e) => setCron(e.target.value)} placeholder="*/15 * * * *" />
          </div>
          <div className="flex items-end">
            <Select
              value=""
              onChange={(e) => {
                const template = STEP_TEMPLATES.find((t) => t.label === e.target.value);
                if (!template) return;
                try {
                  const steps = JSON.parse(stepsText);
                  steps.push(template.make());
                  setStepsText(JSON.stringify(steps, null, 2));
                } catch {
                  setStepsText(JSON.stringify([template.make()], null, 2));
                }
              }}
            >
              <option value="">+ Add step template…</option>
              {STEP_TEMPLATES.map((t) => (
                <option key={t.label} value={t.label}>
                  {t.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div>
          <Label>Steps (JSON)</Label>
          <Textarea rows={10} value={stepsText} onChange={(e) => setStepsText(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Creating…" : "Create monitor"}
          </Button>
          <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
        <ErrorLine error={error} />
      </form>
    </Card>
  );
}

export function RunNowButton({ testId }: { testId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        variant="primary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          const result = await post(`/api/synthetic/tests/${testId}/run`);
          setBusy(false);
          if (result.ok) setTimeout(() => router.refresh(), 500);
          else setError(result.error ?? null);
        }}
      >
        {busy ? "Queueing…" : "Run now"}
      </Button>
      {error ? <span className="font-mono text-[11px] text-red-400">{error}</span> : null}
    </span>
  );
}

export function PauseResumeButton({ testId, paused }: { testId: string; paused: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await post(`/api/synthetic/tests/${testId}`, { paused: !paused }, "PUT");
        setBusy(false);
        router.refresh();
      }}
    >
      {busy ? "…" : paused ? "Resume" : "Pause"}
    </Button>
  );
}

export function DeleteTestButton({ testId, kind }: { testId: string; kind: "synthetic" | "visual" }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  return (
    <Button
      variant="danger"
      disabled={busy}
      onClick={async () => {
        if (!confirming) {
          setConfirming(true);
          setTimeout(() => setConfirming(false), 3000);
          return;
        }
        setBusy(true);
        const url = kind === "synthetic" ? `/api/synthetic/tests/${testId}` : `/api/visual/suites/${testId}`;
        await post(url, undefined, "DELETE");
        setBusy(false);
        router.push(kind === "synthetic" ? "/synthetic" : "/visual");
        router.refresh();
      }}
    >
      {confirming ? "Click again to confirm" : busy ? "Deleting…" : "Delete"}
    </Button>
  );
}

export function AlertActions({ alertId, status }: { alertId: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const act = async (next: "acknowledged" | "resolved") => {
    setBusy(true);
    await post(`/api/alerts?id=${alertId}`, { status: next }, "PATCH");
    setBusy(false);
    router.refresh();
  };
  return (
    <span className="flex gap-2">
      {status === "open" ? (
        <Button variant="secondary" disabled={busy} onClick={() => act("acknowledged")}>
          Acknowledge
        </Button>
      ) : null}
      {status !== "resolved" ? (
        <Button variant="ghost" disabled={busy} onClick={() => act("resolved")}>
          Resolve
        </Button>
      ) : (
        <StatusBadge tone="success">resolved</StatusBadge>
      )}
    </span>
  );
}
