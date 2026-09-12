import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";

/**
 * Pixel comparison with region localization. Pure functions — unit-tested
 * without Playwright.
 */

export interface DiffResult {
  diffRatio: number; // mismatched pixels / total pixels (0..1)
  diffPng: Buffer | null;
  changedRegions: { x: number; y: number; w: number; h: number }[];
  width: number;
  height: number;
}

const CELL = 32;
const MAX_REGIONS = 20;

/** Compare two PNGs. Pass/fail (diffRatio vs. the test's threshold) is the caller's decision. */
export function comparePngs(baseline: Buffer, current: Buffer): DiffResult {
  const base = PNG.sync.read(baseline);
  const cur = PNG.sync.read(current);

  if (base.width !== cur.width || base.height !== cur.height) {
    // A size change is itself a regression signal; no meaningful pixel diff exists.
    return {
      diffRatio: 1,
      diffPng: null,
      changedRegions: [{ x: 0, y: 0, w: cur.width, h: cur.height }],
      width: cur.width,
      height: cur.height,
    };
  }

  const { width, height } = base;
  const diff = new PNG({ width, height });
  const mismatched = pixelmatch(base.data, cur.data, diff.data, width, height, {
    threshold: 0.1, // per-channel yiq delta tolerance
    includeAA: false, // ignore anti-aliasing flicker
  });

  const total = width * height;
  const diffRatio = mismatched / total;

  // Region localization: a second pass in diffMask mode marks ONLY changed
  // pixels (everything else transparent) — robust regardless of how the
  // visual diff paints unchanged areas.
  const changedRegions = [];
  if (mismatched > 0) {
    const mask = new PNG({ width, height });
    pixelmatch(base.data, cur.data, mask.data, width, height, {
      threshold: 0.1,
      includeAA: false,
      diffMask: true,
    });
    const cols = Math.ceil(width / CELL);
    const marked: boolean[] = new Array(cols * Math.ceil(height / CELL)).fill(false);
    const maskData = mask.data;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (maskData[(y * width + x) * 4 + 3] !== 0) {
          marked[Math.floor(y / CELL) * cols + Math.floor(x / CELL)] = true;
        }
      }
    }
    changedRegions.push(...mergeRegions(marked, cols, Math.ceil(height / CELL)));
  }

  return {
    diffRatio,
    diffPng: mismatched > 0 ? PNG.sync.write(diff) : null,
    changedRegions,
    width,
    height,
  };
}

function mergeRegions(marked: boolean[], cols: number, rows: number) {
  const seen = new Set<number>();
  const regions: { x: number; y: number; w: number; h: number }[] = [];
  for (let r = 0; r < rows && regions.length < MAX_REGIONS; r++) {
    for (let c = 0; c < cols && regions.length < MAX_REGIONS; c++) {
      const i = r * cols + c;
      if (!marked[i] || seen.has(i)) continue;
      // Flood-fill connected marked cells into one bounding box.
      const stack = [i];
      let minC = c, maxC = c, minR = r, maxR = r;
      while (stack.length) {
        const cur = stack.pop()!;
        if (seen.has(cur) || !marked[cur]) continue;
        seen.add(cur);
        const cr = Math.floor(cur / cols);
        const cc = cur % cols;
        minC = Math.min(minC, cc); maxC = Math.max(maxC, cc);
        minR = Math.min(minR, cr); maxR = Math.max(maxR, cr);
        if (cc > 0) stack.push(cur - 1);
        if (cc < cols - 1) stack.push(cur + 1);
        if (cr > 0) stack.push(cur - cols);
        if (cr < rows - 1) stack.push(cur + cols);
      }
      regions.push({ x: minC * CELL, y: minR * CELL, w: (maxC - minC + 1) * CELL, h: (maxR - minR + 1) * CELL });
    }
  }
  return regions;
}

export { PNG };
