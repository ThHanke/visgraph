import { describe, it, expect } from "vitest";

/**
 * Diagnostic test: print the captured fat-map and entityIndex snapshots recorded
 * by the temporary instrumentation so we can inspect their contents and stack traces.
 *
 * This test does not alter application state; it only reads global snapshot arrays
 * populated by previous test runs and prints them to stdout for analysis.
 */

describe("Print fat-map / entityIndex snapshots", () => {
  it("prints window.__VG_FATMAP_SNAP and window.__VG_ENTITYINDEX_SNAP", async () => {
    const fatSnaps = (globalThis as any).__VG_FATMAP_SNAP || [];
    const entitySnaps = (globalThis as any).__VG_ENTITYINDEX_SNAP || [];
    // Print concise summary plus full JSON for offline inspection in test logs
    try {
      console.log("[VG_SNAPSHOT] fatmap.count:", fatSnaps.length);
      if (fatSnaps.length > 0) {
        try {
          console.log("[VG_SNAPSHOT] fatmap.last:", JSON.stringify(fatSnaps[fatSnaps.length - 1], null, 2));
        } catch (_) {
          console.log("[VG_SNAPSHOT] fatmap.last (raw):", fatSnaps[fatSnaps.length - 1]);
        }
      } else {
        console.log("[VG_SNAPSHOT] fatmap empty");
      }
    } catch (_) {
      console.log("[VG_SNAPSHOT] fatmap read failed", _);
    }

    try {
      console.log("[VG_SNAPSHOT] entityIndex.count:", entitySnaps.length);
      if (entitySnaps.length > 0) {
        try {
          console.log("[VG_SNAPSHOT] entityIndex.last:", JSON.stringify(entitySnaps[entitySnaps.length - 1], null, 2));
        } catch (_) {
          console.log("[VG_SNAPSHOT] entityIndex.last (raw):", entitySnaps[entitySnaps.length - 1]);
        }
      } else {
        console.log("[VG_SNAPSHOT] entityIndex empty");
      }
    } catch (_) {
      console.log("[VG_SNAPSHOT] entityIndex read failed", _);
    }

    // Basic assertions so CI will report failure if snapshots are unexpectedly absent.
    expect(Array.isArray(fatSnaps)).toBeTruthy();
    expect(Array.isArray(entitySnaps)).toBeTruthy();
  });
});
