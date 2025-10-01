import React from "react";
import { describe, test, expect, beforeEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import KnowledgeCanvas from "../../../src/components/Canvas/KnowledgeCanvas";

describe("KnowledgeCanvas autoload initializer", () => {
  beforeEach(() => {
    try {
      delete (window as any).__VG_INIT_APP_RAN;
    } catch (_) {
      /* intentionally ignored during test setup */
    }
  });

  test("calls the initializer on mount so autoload runs", async () => {
    render(<KnowledgeCanvas />);

    // Wait for the initializer to set a visible flag on window.
    await waitFor(() => {
      // __VG_INIT_APP_RAN is set by the initializer when it runs.
      if (!(window as any).__VG_INIT_APP_RAN) {
        throw new Error("initializer did not run");
      }
    }, { timeout: 3000 });
  });
});
