import type { ReactNode } from "react";

/** Real-data SVG charts — no chart library weight, deterministic SSR. */

export function Sparkline({
  points,
  width = 240,
  height = 48,
  stroke = "var(--color-accent)",
  fill = "rgba(99,102,241,0.12)",
  max,
}: {
  points: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  max?: number;
}) {
  if (points.length < 2) {
    return <div className="flex h-12 items-center text-xs text-faint">Not enough data yet</div>;
  }
  const cap = max ?? Math.max(...points, 1);
  const step = width / (points.length - 1);
  const coords = points.map((p, i) => `${(i * step).toFixed(1)},${(height - (p / cap) * (height - 4) - 2).toFixed(1)}`);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="trend">
      <polygon points={`0,${height} ${coords.join(" ")} ${width},${height}`} fill={fill} />
      <polyline points={coords.join(" ")} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function LatencyBars({
  values,
  labels,
  height = 64,
}: {
  values: number[];
  labels?: string[];
  height?: number;
}) {
  if (!values.length) return <div className="text-xs text-faint">No runs yet</div>;
  const max = Math.max(...values, 1);
  const barW = Math.max(3, Math.floor(100 / Math.max(values.length, 12)));
  return (
    <div className="flex items-end gap-px" style={{ height }} role="img" aria-label="latency per run">
      {values.map((v, i) => (
        <div
          key={i}
          title={labels?.[i] ? `${labels[i]}: ${v}ms` : `${v}ms`}
          className="bg-accent/70 hover:bg-accent-strong"
          style={{ width: barW, height: Math.max(2, (v / max) * (height - 4)) }}
        />
      ))}
    </div>
  );
}

export function AvailabilityDots({ statuses }: { statuses: string[] }) {
  if (!statuses.length) return <div className="text-xs text-faint">No history yet</div>;
  const recent = statuses.slice(0, 40);
  return (
    <div className="flex items-center gap-[3px]" role="img" aria-label="recent run outcomes">
      {recent.map((s, i) => (
        <span
          key={i}
          title={`${s}`}
          className={`h-2.5 w-2.5 rounded-[2px] ${
            s === "passed" ? "bg-emerald-500/80" : s === "failed" ? "bg-red-500/80" : s === "error" ? "bg-amber-500/70" : "bg-zinc-600"
          }`}
        />
      ))}
    </div>
  );
}

export function ScoreRing({ score, level }: { score: number; level: string }) {
  const color = level === "critical" || level === "high" ? "#f87171" : level === "medium" ? "#fbbf24" : level === "low" ? "#818cf8" : "#34d399";
  const r = 15;
  const c = 2 * Math.PI * r;
  const filled = (Math.min(100, Math.max(0, score)) / 100) * c;
  return (
    <svg width="44" height="44" viewBox="0 0 44 44" role="img" aria-label={`risk score ${score}`}>
      <circle cx="22" cy="22" r={r} fill="none" stroke="var(--color-line-strong)" strokeWidth="4" />
      <circle
        cx="22"
        cy="22"
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${c - filled}`}
        transform="rotate(-90 22 22)"
      />
      <text x="22" y="26" textAnchor="middle" className="fill-current font-mono" fontSize="13" fontWeight="600">
        {score}
      </text>
    </svg>
  );
}

export function KeyValue({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-[13px]">
      {rows.map(([k, v], i) => (
        <div key={i} className="col-span-2 grid grid-cols-[140px_1fr] items-baseline gap-x-4">
          <dt className="text-faint">{k}</dt>
          <dd className="min-w-0 break-words font-mono text-xs text-text">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
