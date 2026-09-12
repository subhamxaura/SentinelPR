/**
 * Renders the SentinelPR project analysis report (HTML) into a PDF.
 *
 * Usage: pnpm report
 * Output: docs/reports/sentinelpr-project-report.pdf (A4)
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(here, "report-template.html");
const outPath = resolve(here, "..", "docs", "reports", "sentinelpr-project-report.pdf");

mkdirSync(dirname(outPath), { recursive: true });

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`file://${htmlPath.replace(/\\/g, "/")}`, { waitUntil: "networkidle" });
  await page.pdf({
    path: outPath,
    format: "A4",
    printBackground: true,
    margin: { top: "18mm", bottom: "16mm", left: "16mm", right: "16mm" },
    displayHeaderFooter: true,
    headerTemplate: `<div style="font-size:7px;color:#a1a1aa;width:100%;padding:0 16mm;display:flex;justify-content:space-between;font-family:Segoe UI,Helvetica,sans-serif;">
      <span>SENTELPR — Engineering Analysis Report</span><span>Confidential · Internal</span></div>`,
    footerTemplate: `<div style="font-size:7px;color:#a1a1aa;width:100%;padding:0 16mm;display:flex;justify-content:space-between;font-family:Segoe UI,Helvetica,sans-serif;">
      <span>Generated ${new Date().toISOString().slice(0, 10)} · v0.1.0 · commit 6730ba9</span>
      <span class="pageNumber"></span>/<span class="totalPages"></span></div>`,
  });
  await browser.close();
  console.log(outPath);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
