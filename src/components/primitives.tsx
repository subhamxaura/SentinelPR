import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes, TextareaHTMLAttributes } from "react";

/* Minimal, hand-rolled primitives on the spec's visual system.
   No UI dependency weight; every component is predictable and server-renderable. */

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-md border border-line bg-surface ${className}`}>{children}</div>
  );
}

export function CardHeader({ title, action, sub }: { title: ReactNode; action?: ReactNode; sub?: string }) {
  return (
    <div className="flex items-center justify-between border-b border-line px-4 py-3">
      <div>
        <h2 className="text-[13px] font-semibold tracking-wide text-text">{title}</h2>
        {sub ? <p className="mt-0.5 text-xs text-faint">{sub}</p> : null}
      </div>
      {action}
    </div>
  );
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export function Button({
  children,
  variant = "secondary",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  const base =
    "inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 text-[13px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const styles: Record<ButtonVariant, string> = {
    primary: "bg-accent text-white hover:bg-accent-strong",
    secondary: "border border-line-strong bg-surface-2 text-text hover:bg-surface-3",
    ghost: "text-muted hover:bg-surface-2 hover:text-text",
    danger: "border border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20",
  };
  return (
    <button className={`${base} ${styles[variant]} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export function Input({ className = "", ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`h-8 w-full rounded-md border border-line-strong bg-bg px-2.5 text-[13px] text-text placeholder:text-faint focus:border-accent ${className}`}
      {...rest}
    />
  );
}

export function Select({ className = "", children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`h-8 rounded-md border border-line-strong bg-bg px-2 text-[13px] text-text ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Textarea({ className = "", ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`w-full rounded-md border border-line-strong bg-bg px-2.5 py-1.5 font-mono text-xs text-text placeholder:text-faint focus:border-accent ${className}`}
      {...rest}
    />
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <label className="mb-1 block text-xs font-medium text-muted">{children}</label>;
}

/* ── Status vocabulary, rendered consistently everywhere ───────────────── */

export type StatusTone = "success" | "failure" | "running" | "pending" | "warning" | "neutral" | "accent";

const TONE_STYLES: Record<StatusTone, string> = {
  success: "bg-emerald-500/10 text-emerald-400 border-emerald-500/25",
  failure: "bg-red-500/10 text-red-400 border-red-500/25",
  running: "bg-blue-500/10 text-blue-400 border-blue-500/25",
  pending: "bg-zinc-500/10 text-zinc-400 border-zinc-500/25",
  warning: "bg-amber-500/10 text-amber-400 border-amber-500/25",
  neutral: "bg-zinc-500/10 text-faint border-zinc-500/25",
  accent: "bg-accent-dim text-accent-strong border-accent/25",
};

export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-medium leading-none ${TONE_STYLES[tone]}`}>
      {children}
    </span>
  );
}

const SEVERITY_TONE: Record<string, StatusTone> = {
  critical: "failure",
  high: "failure",
  medium: "warning",
  low: "accent",
  info: "neutral",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return <StatusBadge tone={SEVERITY_TONE[severity] ?? "neutral"}>{severity}</StatusBadge>;
}

const RISK_TONE: Record<string, StatusTone> = {
  none: "neutral",
  low: "success",
  medium: "warning",
  high: "failure",
  critical: "failure",
};

export function RiskBadge({ level }: { level: string | null }) {
  if (!level) return <StatusBadge tone="neutral">no risk data</StatusBadge>;
  return <StatusBadge tone={RISK_TONE[level] ?? "neutral"}>risk {level}</StatusBadge>;
}

export const STATUS_TONE: Record<string, StatusTone> = {
  // runs
  passed: "success",
  success: "success",
  failed: "failure",
  failure: "failure",
  error: "failure",
  running: "running",
  queued: "pending",
  skipped: "neutral",
  // infra
  open: "failure",
  acknowledged: "warning",
  resolved: "success",
  processed: "success",
  received: "pending",
};

export function RunStatusBadge({ status }: { status: string }) {
  return <StatusBadge tone={STATUS_TONE[status] ?? "neutral"}>{status}</StatusBadge>;
}

export function Mono({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-xs ${className}`}>{children}</span>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        {description ? <p className="mt-1 text-[13px] text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function MetricCard({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: StatusTone }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-[11px] font-medium uppercase tracking-wider text-faint">{label}</div>
      <div className={`mt-1.5 font-mono text-2xl font-semibold ${tone === "failure" ? "text-red-400" : tone === "success" ? "text-emerald-400" : tone === "warning" ? "text-amber-400" : "text-text"}`}>
        {value}
      </div>
      {sub ? <div className="mt-1 text-xs text-faint">{sub}</div> : null}
    </Card>
  );
}
