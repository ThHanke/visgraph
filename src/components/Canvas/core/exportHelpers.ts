import * as htmlToImage from "html-to-image";

/**
 * Minimal exporters that call html-to-image directly on the React Flow viewport.
 * No cloning, no preprocessing, no fallbacks — per request.
 *
 * exportViewportSvgMinimal(): Promise<string>
 *   - Returns an SVG string (raw XML) produced by html-to-image.toSvg(viewport, { cacheBust: true }).
 *
 * exportViewportPngMinimal(scale?): Promise<string>
 *   - Returns a PNG data URL string (data:image/png;base64,...) produced by html-to-image.toPng(viewport, { cacheBust: true, pixelRatio: scale }).
 *
 * Both functions throw if the viewport element is not found or html-to-image fails.
 */

export async function exportViewportSvgMinimal(): Promise<string> {
  if (typeof document === "undefined") throw new Error("exportViewportSvgMinimal must run in a browser environment");
  // Prefer common renderer/portal selectors so portalled React Flow content is captured.
  const viewport = document.querySelector('.react-flow__viewport') as HTMLElement | null;
  if (!viewport) throw new Error('Viewport element ".react-flow__viewport" not found');
  // Small delay to allow any portalled renderer content to attach/paint.
  if (typeof window === "undefined") {
    // In non-browser/test environments, schedule a microtask instead of a real timeout
    await Promise.resolve();
  } else {
    await new Promise((r) => setTimeout(r, 2000));
  }
  const svgResult = await (htmlToImage as any).toSvg(viewport, { cacheBust: true });
  if (typeof svgResult !== "string") throw new Error("html-to-image.toSvg did not return a string");
  const prefix = "data:image/svg+xml;charset=utf-8,";
  if (svgResult.startsWith(prefix)) {
    return decodeURIComponent(svgResult.replace(prefix, "").trim());
  }
  return svgResult;
}

export async function exportViewportPngMinimal(scale = 2): Promise<string> {
  if (typeof document === "undefined") throw new Error("exportViewportPngMinimal must run in a browser environment");
  // Prefer common renderer/portal selectors so portalled React Flow content is captured.
  const viewport = document.querySelector('.react-flow__viewport') as HTMLElement | null;
  if (!viewport) throw new Error('Viewport element ".react-flow__viewport" not found');
  // Small delay to allow any portalled renderer content to attach/paint.
  if (typeof window === "undefined") {
    // In non-browser/test environments, schedule a microtask instead of a real timeout
    await Promise.resolve();
  } else {
    await new Promise((r) => setTimeout(r, 2000));
  }
  const dataUrl = await (htmlToImage as any).toPng(viewport, { cacheBust: true, pixelRatio: scale });
  if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png")) throw new Error("html-to-image.toPng did not return a PNG data URL");
  return dataUrl;
}
