"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Button } from "@/components/primitives";

export interface ShellUser {
  name: string | null;
  githubLogin: string | null;
  avatarUrl: string | null;
}

export interface ShellMembership {
  organizationId: string;
  name: string;
  role: string;
}

export interface ShellIdentityProps {
  user: ShellUser | null;
  role: string | null;
  activeOrg: { id: string | null; name: string | null };
  memberships: ShellMembership[];
}

interface SearchResult {
  type: string;
  id: string;
  label: string;
  sub: string;
  href: string;
}

const NAV_SECTIONS: Array<{ heading: string; items: Array<{ label: string; href: string; keys: string }> }> = [
  {
    heading: "Signals",
    items: [
      { label: "Overview", href: "/", keys: "g o" },
      { label: "Pull Requests", href: "/pull-requests", keys: "g p" },
      { label: "Visual Regression", href: "/visual", keys: "g v" },
      { label: "Synthetic Monitoring", href: "/synthetic", keys: "g s" },
      { label: "Runs", href: "/runs", keys: "g r" },
      { label: "Alerts", href: "/alerts", keys: "g a" },
    ],
  },
  {
    heading: "Configuration",
    items: [
      { label: "Repositories", href: "/repositories", keys: "" },
      { label: "Team", href: "/team", keys: "g t" },
      { label: "Rules", href: "/rules", keys: "" },
      { label: "Settings", href: "/settings", keys: "g ," },
    ],
  },
];

function isActivePath(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(href + "/");
}

export function Shell({ children, user, role, activeOrg, memberships }: { children: ReactNode } & ShellIdentityProps) {
  const pathname = usePathname() ?? "";
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    let lastG = 0;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (!typing && e.key === "/" && !e.metaKey && !e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (!typing && e.key === "g") {
        lastG = Date.now();
        return;
      }
      if (!typing && Date.now() - lastG < 900) {
        const map: Record<string, string> = { o: "/", p: "/pull-requests", v: "/visual", s: "/synthetic", r: "/runs", a: "/alerts", t: "/team", ",": "/settings" };
        const dest = map[e.key];
        if (dest) {
          window.location.href = dest;
          lastG = 0;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col border-r border-line bg-surface/60 md:flex">
        <div className="flex h-14 items-center gap-2.5 border-b border-line px-4">
          <Logo />
          <div>
            <div className="text-[13px] font-semibold leading-tight tracking-tight">SentinelPR</div>
            <div className="text-[10px] leading-tight text-faint">PR quality · visual · synthetic</div>
          </div>
        </div>
        <div className="border-t border-line px-2 py-3">
          <IdentityBar user={user} role={role} activeOrg={activeOrg} memberships={memberships} />
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-3">
          {NAV_SECTIONS.map((section) => (
            <div key={section.heading} className="mb-4">
              <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-faint">{section.heading}</div>
              {section.items.map((item) => {
                const active = isActivePath(item.href, pathname);
                return (
                  <a
                    key={item.href}
                    href={item.href}
                    className={`mb-0.5 flex items-center justify-between rounded-md px-2 py-1.5 text-[13px] transition-colors ${
                      active ? "bg-accent-dim font-medium text-accent-strong" : "text-muted hover:bg-surface-2 hover:text-text"
                    }`}
                  >
                    {item.label}
                  </a>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="border-t border-line p-2">
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex w-full items-center justify-between rounded-md border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-faint hover:border-line-strong hover:text-muted"
          >
            Search…
            <kbd className="font-mono text-[10px]">⌘K</kbd>
          </button>
        </div>
      </aside>

      {/* Mobile top nav */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="sticky top-0 z-40 flex h-12 items-center justify-between border-b border-line bg-bg/90 px-4 backdrop-blur md:hidden">
          <div className="flex items-center gap-2">
            <Logo />
            <span className="text-[13px] font-semibold">SentinelPR</span>
          </div>
          <div className="flex items-center gap-2">
            <IdentityBar user={user} role={role} activeOrg={activeOrg} memberships={memberships} compact />
            <button onClick={() => setPaletteOpen(true)} className="rounded-md border border-line px-2 py-1 text-xs text-faint">
              Search
            </button>
          </div>
        </div>
        <div className="flex gap-1 overflow-x-auto border-b border-line px-3 py-2 md:hidden">
          {NAV_SECTIONS.flatMap((s) => s.items).map((item) => (
            <a key={item.href} href={item.href} className={`whitespace-nowrap rounded-md px-2 py-1 text-xs ${isActivePath(item.href, pathname) ? "bg-accent-dim text-accent-strong" : "text-muted"}`}>
              {item.label}
            </a>
          ))}
        </div>
        <main className="mx-auto w-full max-w-[1200px] flex-1 px-5 py-6 md:px-8">{children}</main>
      </div>

      {paletteOpen ? <CommandPalette onClose={() => setPaletteOpen(false)} /> : null}
    </div>
  );
}

function IdentityBar({
  user,
  role,
  activeOrg,
  memberships,
  compact = false,
}: ShellIdentityProps & { compact?: boolean }) {
  const router = useRouter();

  if (!user) {
    return (
      <div className={`flex ${compact ? "" : "flex-col"} items-center gap-2`}>
        <a href="/signin" className="w-full">
          <Button variant="secondary" className="w-full">Sign in</Button>
        </a>
      </div>
    );
  }

  return (
    <div className={`flex ${compact ? "items-center" : "flex-col"} gap-2`}>
      <div className={`flex items-center gap-2 ${compact ? "" : "px-1"}`}>
        <Avatar user={user} />
        <div className="min-w-0">
          <div className="truncate text-[12px] font-medium leading-tight">{user.name ?? user.githubLogin}</div>
          <div className="truncate text-[10px] leading-tight text-faint">
            {role ? `${role} · ` : ""}{user.githubLogin ?? ""}
          </div>
        </div>
      </div>
      {memberships.length > 1 ? (
        <select
          aria-label="Active organization"
          value={activeOrg.id ?? ""}
          onChange={async (e) => {
            const organizationId = e.target.value;
            await fetch("/api/session", {
              method: "POST",
              headers: { "content-type": "application/json" },
            body: JSON.stringify({ organizationId }),
            }).catch(() => undefined);
            router.refresh();
          }}
          className="w-full rounded-md border border-line bg-surface-2 px-2 py-1 text-[11px] text-muted"
        >
          {memberships.map((m) => (
            <option key={m.organizationId} value={m.organizationId}>
              {m.name} ({m.role})
            </option>
          ))}
        </select>
      ) : memberships.length === 1 ? (
        <div className="truncate px-1 text-[10px] text-faint">{memberships[0].name}</div>
      ) : null}
      <form action="/api/auth/signout" method="post" className={compact ? "" : "px-1"}>
        <button type="submit" className="text-[11px] text-faint hover:text-text">
          Sign out
        </button>
      </form>
    </div>
  );
}

function Avatar({ user }: { user: ShellUser }) {
  if (user.avatarUrl) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={user.avatarUrl} alt="" width={24} height={24} className="h-6 w-6 rounded-full" />;
  }
  return <div className="flex h-6 w-6 items-center justify-center rounded-full bg-accent-dim text-[10px] font-semibold text-accent-strong">{(user.name ?? user.githubLogin ?? "?").slice(0, 1).toUpperCase()}</div>;
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="19" height="19" rx="4" stroke="url(#g)" strokeWidth="1.6" />
      <path d="M8 12.2l2.6 2.6L16.2 9" stroke="#818cf8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="24" y2="24">
          <stop stopColor="#6366f1" />
          <stop offset="1" stopColor="#3f3f46" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function CommandPalette({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [selected, setSelected] = useState(0);
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    if (query.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        if (res.ok) {
          const data = (await res.json()) as { results: SearchResult[] };
          setResults(data.results);
          setSelected(0);
        }
      } catch {
        setResults([]);
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [query]);

  const go = (href: string) => {
    onClose();
    router.push(href);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh]" onClick={onClose} role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="w-full max-w-lg overflow-hidden rounded-lg border border-line-strong bg-surface shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, results.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
            if (e.key === "Enter" && results[selected]) go(results[selected].href);
          }}
          placeholder="Search PRs, repositories, monitors, suites…"
          className="h-11 w-full border-b border-line bg-transparent px-4 text-sm outline-none placeholder:text-faint"
        />
        <div className="max-h-80 overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-faint">
              {query.trim().length < 2 ? "Type at least 2 characters" : "No matches"}
            </div>
          ) : (
            results.map((r, i) => (
              <button
                key={`${r.type}-${r.id}`}
                onClick={() => go(r.href)}
                onMouseEnter={() => setSelected(i)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-[13px] ${i === selected ? "bg-accent-dim text-text" : "text-muted"}`}
              >
                <span className="truncate">{r.label}</span>
                <span className="ml-3 shrink-0 text-[11px] text-faint">{r.sub}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
