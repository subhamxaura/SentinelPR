/**
 * DOM / experience signature: a structural snapshot of a page that goes beyond
 * pixels. Pixel comparison answers "does it look the same?"; this answers
 * "does it still contain and expose the same interactive surface?".
 * Pure diff logic — unit-tested without a browser.
 */

export interface DomSignature {
  url: string;
  title: string;
  headings: string[];
  /** Interactive surface: links, buttons, inputs, controls with accessible names. */
  controls: { tag: string; name: string }[];
}

export interface DomChange {
  type: "missing_control" | "new_control" | "title_changed" | "missing_heading" | "heading_changed";
  detail: string;
}

const CONTROL_SELECTOR = "a[href], button, input, select, textarea, [role='button'], [role='tab'], [role='link']";

/**
 * Browser-side collector, kept as a source STRING and evaluated as an IIFE:
 *  - function values passed through tsx/esbuild carry a `__name` helper that
 *    does not exist in the browser;
 *  - Playwright string+arg evaluation is unreliable, so the selector is baked
 *    into the expression instead of passed as an argument.
 * The collector must reference nothing from outer module scope.
 */
export const DOM_SIGNATURE_SOURCE = `(selector) => {
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map((h) => norm(h.textContent)).filter(Boolean).slice(0, 50);
  const controls = Array.from(document.querySelectorAll(selector))
    .filter((el) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    })
    .map((el) => ({
      tag: el.tagName.toLowerCase(),
      name: norm(el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('alt') || el.textContent || el.getAttribute('name') || el.getAttribute('id') || '').slice(0, 120),
    }))
    .slice(0, 200);
  return { url: location.href, title: document.title, headings, controls };
}`;

/** Expression evaluated in the page: collector applied to the control selector. */
export const DOM_SIGNATURE_EXPRESSION = `(${DOM_SIGNATURE_SOURCE})(${JSON.stringify(CONTROL_SELECTOR)})`;

export { CONTROL_SELECTOR };

export function diffDomSignatures(baseline: DomSignature, current: DomSignature): DomChange[] {
  const changes: DomChange[] = [];

  if (baseline.title !== current.title) {
    changes.push({ type: "title_changed", detail: `"${baseline.title}" → "${current.title}"` });
  }

  const key = (c: { tag: string; name: string }) => `${c.tag}:${c.name.toLowerCase()}`;
  const baselineKeys = new Map(baseline.controls.map((c) => [key(c), c]));
  const currentKeys = new Set(current.controls.map(key));

  for (const [k, c] of baselineKeys) {
    if (!currentKeys.has(k)) {
      changes.push({
        type: "missing_control",
        detail: `${c.tag}${c.name ? ` "${c.name}"` : ""} is no longer present/visible`,
      });
    }
  }
  const baselineKeySet = new Set(baselineKeys.keys());
  for (const c of current.controls) {
    const k = key(c);
    if (!baselineKeySet.has(k) && currentKeys.has(k)) {
      changes.push({
        type: "new_control",
        detail: `${c.tag}${c.name ? ` "${c.name}"` : ""} appeared`,
      });
    }
  }

  for (let i = 0; i < baseline.headings.length; i++) {
    const before = baseline.headings[i];
    const after = current.headings[i];
    if (after === undefined) {
      changes.push({ type: "missing_heading", detail: `Heading "${before}" disappeared` });
    } else if (before !== after) {
      changes.push({ type: "heading_changed", detail: `"${before}" → "${after}"` });
    }
  }

  return changes.slice(0, 50);
}
