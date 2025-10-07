import { exportViewportSvgMinimal, exportViewportPngMinimal } from "./exportHelpers";

/**
 * Minimal download helpers.
 *
 * These helpers do the absolute minimum:
 * - For SVG: call exportViewportSvgMinimal() to receive raw SVG string, create a Blob and trigger a download.
 * - For PNG: call exportViewportPngMinimal() to receive a data URL (data:image/png;base64,...) and trigger a download.
 *
 * No cloning, no iframes, no dom-to-svg, no fallbacks, no preprocessing. Errors are thrown back to the caller.
 */

function triggerDownloadUrl(url: string, filename: string) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke object URLs should be handled by caller when appropriate; revoke after a short delay to allow download
  setTimeout(() => {
    try { URL.revokeObjectURL(url); } catch (_) { /* ignore */ }
  }, 3000);
}

export async function exportSvgFull(opts?: { filename?: string }): Promise<void> {
  // Use a stable default filename per request; allow override via opts.filename.
  const filename = opts?.filename || `knowledgegraph.svg`;
  // Get SVG string from minimal exporter
  const svgString = await exportViewportSvgMinimal();
  const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  triggerDownloadUrl(url, filename);
}

export async function exportPngFull(opts?: { filename?: string; scale?: number }): Promise<void> {
  // Use stable default filename per request; allow override via opts.filename.
  const filename = opts?.filename || `knowledgegraph.png`;
  const scale = opts?.scale || 2;
  // Get data URL from minimal exporter
  const dataUrl = await exportViewportPngMinimal(scale);
  // Convert data URL to Blob and trigger download
  const base64 = dataUrl.split(",")[1] || "";
  const bytes = Uint8Array.from(atob(base64), c => c.charCodeAt(0));
  const blob = new Blob([bytes], { type: "image/png" });
  const url = URL.createObjectURL(blob);
  triggerDownloadUrl(url, filename);
}
