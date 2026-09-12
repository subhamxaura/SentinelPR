import { describe, expect, it } from "vitest";
import { diffDomSignatures, type DomSignature } from "./dom";

const base: DomSignature = {
  url: "https://app.test/",
  title: "Dashboard",
  headings: ["Overview", "Usage"],
  controls: [
    { tag: "a", name: "Settings" },
    { tag: "button", name: "Save" },
    { tag: "input", name: "Email" },
  ],
};

describe("diffDomSignatures", () => {
  it("detects missing interactive controls", () => {
    const changes = diffDomSignatures(base, {
      ...base,
      controls: [base.controls[0], base.controls[2]],
    });
    expect(changes).toContainEqual({
      type: "missing_control",
      detail: 'button "Save" is no longer present/visible',
    });
  });

  it("detects new controls and title changes", () => {
    const changes = diffDomSignatures(base, {
      ...base,
      title: "Dashboard v2",
      controls: [...base.controls, { tag: "button", name: "Delete" }],
    });
    expect(changes.some((c) => c.type === "new_control" && c.detail.includes("Delete"))).toBe(true);
    expect(changes.some((c) => c.type === "title_changed")).toBe(true);
  });

  it("detects heading disappearance and changes", () => {
    const changes = diffDomSignatures(base, {
      ...base,
      headings: ["Overview changed"],
    });
    expect(changes.some((c) => c.type === "heading_changed")).toBe(true);
    expect(changes.some((c) => c.type === "missing_heading")).toBe(true);
  });

  it("returns empty for identical signatures", () => {
    expect(diffDomSignatures(base, base)).toEqual([]);
  });
});
