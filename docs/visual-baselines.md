# Visual baselines

Baselines make visual regression meaningful: a comparison is only as good as the reference it
trusts. SentinelPR treats baselines as explicit, versioned artifacts — runs never silently replace
them.

## Lifecycle

```
first run ──► snapshots marked "baseline_missing" (current capture stored as a candidate)
                     │
                     ▼  user clicks "Approve as baseline" (deliberate, audited)
             VisualBaseline row (browser × viewport, version 1, active)
                     │
                     ▼  later runs compare against the active baseline
             passed (≤ threshold) / failed (> threshold) + diff artifact + changed regions
                     │
                     ▼  deliberate UI change? approve the new capture
             baseline version N+1 (old version deactivated, bytes retained)
```

- One active baseline per (test, browser, viewport).
- Every approval creates a new **version**; history is preserved, and the action is audit-logged.
- Comparisons store the diff ratio, the diff PNG, and localized changed regions (32px grid,
  flood-filled bounding boxes).

## Determinism

Screenshots are only comparable when rendering is reproducible. Captures standardize:

- device scale factor 1, fixed locale (`en-US`) and timezone (UTC), `reducedMotion: reduce`
- CSS animations paused, transitions disabled, caret hidden (injected style)
- `networkidle` wait (best-effort, 10s cap) plus a settle delay after the style freeze

Even so, expect noise from live clocks, rotating content, and ads — point suites at stable pages
or add data attributes to pin dynamic regions (v2 roadmap: per-region masking).

## Beyond pixels: the DOM experience signature

Each capture also records a structural signature (headings, visible interactive controls with
accessible names). Comparing signatures surfaces:

- `missing_control` — a button/link/input disappeared (often the *real* regression behind a
  "small pixel diff")
- `new_control` — unexpected new interactive surface
- `heading_changed` / `missing_heading` — content restructure
- `title_changed`

Signatures are stored with snapshots; the diff renders in the comparison viewer under "DOM /
experience changes". Pixel thresholds catch rendering drift; the signature catches functional
structure drift. Together they answer *"does the UI still look AND behave correct?"*, not just
*"are two PNGs different?"*.

## Thresholds

Per-test `threshold` is the maximum allowed diff ratio (mismatched pixels / total pixels), default
0.1 (10%). Anti-aliasing is excluded from the count (`includeAA: false`); per-channel yiq tolerance
is 0.1. Image size changes are treated as a full mismatch with a full-page changed region — a
layout shift is exactly the kind of regression you want flagged.

## Viewers

The run page offers side-by-side, overlay (opacity slider) and diff modes with zoom. Artifact URLs
are HMAC-signed and expire (2h) — nothing is publicly readable.
