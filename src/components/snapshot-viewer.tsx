"use client";

import { useState } from "react";

export type ViewerArtifact = {
  currentUrl: string | null;
  diffUrl: string | null;
};

export type ViewerSnapshot = {
  id: string;
  title: string;
  status: string;
  diffRatio: number | null;
  threshold: number;
  changedRegionCount: number;
  domChanges: string[];
  baselineUrl: string | null;
  currentUrl: string | null;
  diffUrl: string | null;
};

type Mode = "side-by-side" | "overlay" | "diff";

/**
 * Comparison viewer: SIDE-BY-SIDE / OVERLAY / DIFF modes, zoom,
 * changed-region and DOM-shift readouts.
 */
export function SnapshotViewer({ snapshots }: { snapshots: ViewerSnapshot[] }) {
  const [mode, setMode] = useState<Mode>("side-by-side");
  const [zoom, setZoom] = useState(1);
  const [selectedId, setSelectedId] = useState(snapshots[0]?.id ?? "");
  const selected = snapshots.find((s) => s.id === selectedId) ?? snapshots[0];

  if (!selected) {
    return <div className="px-4 py-8 text-center text-[13px] text-faint">No snapshots in this run.</div>;
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-1.5">
          {snapshots.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelectedId(s.id)}
              className={`rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
                s.id === selected.id
                  ? "border-accent/40 bg-accent-dim text-accent-strong"
                  : "border-line bg-surface-2 text-muted hover:text-text"
              }`}
            >
              <div className="font-medium">{s.title}</div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span
                  className={
                    s.status === "failed"
                      ? "text-red-400"
                      : s.status === "passed"
                        ? "text-emerald-400"
                        : "text-amber-400"
                  }
                >
                  {s.status}
                </span>
                {s.diffRatio !== null ? <span className="text-faint">Δ {(s.diffRatio * 100).toFixed(2)}%</span> : null}
              </div>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <ModeToggle mode={mode} setMode={setMode} />
          <ZoomControl zoom={zoom} setZoom={setZoom} />
        </div>
      </div>

      <div className="px-4 py-2.5 text-xs text-muted">
        {selected.status === "baseline_missing" ? (
          <span className="text-amber-400">
            No approved baseline exists yet — this capture is a candidate. Approve it to start versioned comparisons.
          </span>
        ) : selected.status === "failed" ? (
          <span className="text-red-400">
            Diff ratio {(selected.diffRatio! * 100).toFixed(2)}% exceeds the {(selected.threshold * 100).toFixed(1)}% threshold.
            {selected.changedRegionCount > 0 ? ` ${selected.changedRegionCount} changed region(s) localized.` : ""}
          </span>
        ) : (
          <span className="text-emerald-400">Within threshold.</span>
        )}
        {selected.domChanges.length > 0 ? (
          <div className="mt-2 rounded-md border border-amber-500/25 bg-amber-500/5 px-3 py-2">
            <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-amber-400">
              DOM / experience changes
            </div>
            <ul className="space-y-0.5">
              {selected.domChanges.slice(0, 8).map((c, i) => (
                <li key={i} className="font-mono text-[11px] text-muted">{c}</li>
              ))}
              {selected.domChanges.length > 8 ? (
                <li className="text-[11px] text-faint">+{selected.domChanges.length - 8} more</li>
              ) : null}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="max-h-[640px] overflow-auto bg-bg p-4">
        {mode === "side-by-side" ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Pane label="Baseline" url={selected.baselineUrl} zoom={zoom} />
            <Pane label="Current" url={selected.currentUrl} zoom={zoom} />
          </div>
        ) : mode === "overlay" ? (
          <OverlayView baselineUrl={selected.baselineUrl} currentUrl={selected.currentUrl} zoom={zoom} />
        ) : (
          <Pane label="Pixel diff (red = changed)" url={selected.diffUrl} zoom={zoom} emptyHint="No diff image — images were identical or sizes differed." />
        )}
      </div>
    </div>
  );
}

function ModeToggle({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  const modes: Mode[] = ["side-by-side", "overlay", "diff"];
  return (
    <div className="flex overflow-hidden rounded-md border border-line-strong" role="tablist" aria-label="viewer mode">
      {modes.map((m) => (
        <button
          key={m}
          role="tab"
          aria-selected={mode === m}
          onClick={() => setMode(m)}
          className={`px-2.5 py-1.5 text-xs ${mode === m ? "bg-accent text-white" : "bg-surface-2 text-muted hover:text-text"}`}
        >
          {m === "side-by-side" ? "Side-by-side" : m === "overlay" ? "Overlay" : "Diff"}
        </button>
      ))}
    </div>
  );
}

function ZoomControl({ zoom, setZoom }: { zoom: number; setZoom: (z: number) => void }) {
  return (
    <div className="flex items-center gap-1 text-xs text-muted">
      <button className="rounded border border-line-strong px-2 py-1 hover:text-text" onClick={() => setZoom(Math.max(0.25, zoom - 0.25))} aria-label="zoom out">
        −
      </button>
      <span className="w-10 text-center font-mono">{Math.round(zoom * 100)}%</span>
      <button className="rounded border border-line-strong px-2 py-1 hover:text-text" onClick={() => setZoom(Math.min(3, zoom + 0.25))} aria-label="zoom in">
        +
      </button>
      <button className="rounded border border-line-strong px-2 py-1 hover:text-text" onClick={() => setZoom(1)}>
        Fit
      </button>
    </div>
  );
}

function Pane({ label, url, zoom, emptyHint }: { label: string; url: string | null; zoom: number; emptyHint?: string }) {
  return (
    <figure>
      <figcaption className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{label}</figcaption>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt={label}
          className="max-w-none rounded-md border border-line"
          style={{ width: `${zoom * 100}%` }}
        />
      ) : (
        <div className="flex h-40 items-center justify-center rounded-md border border-dashed border-line text-xs text-faint">
          {emptyHint ?? "No artifact"}
        </div>
      )}
    </figure>
  );
}

function OverlayView({ baselineUrl, currentUrl, zoom }: { baselineUrl: string | null; currentUrl: string | null; zoom: number }) {
  const [opacity, setOpacity] = useState(0.5);
  if (!baselineUrl || !currentUrl) {
    return <div className="text-xs text-faint">Overlay needs both a baseline and a current capture.</div>;
  }
  return (
    <figure>
      <figcaption className="mb-1.5 flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-faint">
        <span>Overlay (current over baseline)</span>
        <label className="flex items-center gap-2 normal-case">
          opacity
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
            className="w-32 accent-[#6366f1]"
          />
        </label>
      </figcaption>
      <div className="relative w-fit overflow-hidden rounded-md border border-line" style={{ maxWidth: `${zoom * 100}%` }}>
        {/* eslint-disable @next/next/no-img-element */}
        <img src={baselineUrl} alt="baseline" className="block max-w-none" style={{ width: "100%" }} />
        <img
          src={currentUrl}
          alt="current overlay"
          className="absolute inset-0 block h-full w-full"
          style={{ opacity }}
        />
        {/* eslint-enable @next/next/no-img-element */}
      </div>
    </figure>
  );
}
