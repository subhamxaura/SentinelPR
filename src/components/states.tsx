import type { ReactNode } from "react";
import { Card, Button } from "./primitives";

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: { label: string; href?: string; onClick?: () => void };
}) {
  return (
    <Card className="px-6 py-12 text-center">
      <div className="mx-auto flex h-10 w-10 items-center justify-center rounded-md border border-line bg-surface-2">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" className="text-faint">
          <path d="M4 6h16M4 12h16M4 18h10" strokeLinecap="round" />
        </svg>
      </div>
      <h3 className="mt-3 text-sm font-semibold">{title}</h3>
      <div className="mx-auto mt-1.5 max-w-md text-[13px] leading-relaxed text-muted">{children}</div>
      {action ? (
        <div className="mt-4">
          {action.href ? (
            <a href={action.href}>
              <Button variant="primary">{action.label}</Button>
            </a>
          ) : (
            <Button variant="primary" onClick={action.onClick}>
              {action.label}
            </Button>
          )}
        </div>
      ) : null}
    </Card>
  );
}

export function ErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <Card className="border-red-500/25 px-6 py-10 text-center">
      <h3 className="text-sm font-semibold text-red-400">{title}</h3>
      {detail ? <p className="mx-auto mt-1.5 max-w-lg font-mono text-xs leading-relaxed text-muted">{detail}</p> : null}
      <p className="mt-3 text-xs text-faint">
        Check <a className="text-accent-strong underline-offset-2 hover:underline" href="/settings">Settings</a> for the exact configuration state.
      </p>
    </Card>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-16 text-[13px] text-faint">
      <span className="h-3 w-3 animate-spin rounded-full border-2 border-line-strong border-t-accent" />
      {label}…
    </div>
  );
}

export function SetupRequired({ missing }: { missing: string[] }) {
  return (
    <Card className="border-amber-500/25 bg-amber-500/[0.04] px-5 py-4">
      <div className="text-[13px] font-semibold text-amber-400">Configuration required</div>
      <p className="mt-1 text-[13px] text-muted">
        This feature needs configuration before it can run. Missing:
      </p>
      <ul className="mt-2 space-y-1">
        {missing.map((m) => (
          <li key={m} className="font-mono text-xs text-amber-300/90">
            {m}
          </li>
        ))}
      </ul>
    </Card>
  );
}
