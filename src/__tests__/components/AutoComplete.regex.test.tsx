import React from "react";
import { describe, it, expect } from "vitest";
import { optionMatches } from "../../components/ui/AutoComplete";

/**
 * Focused test to reproduce substring matching issues.
 * Verifies that queries like "has " and "part" match labels such as "has part",
 * as well as camelCase and underscore variants.
 */

describe("AutoComplete regex/substring matching", () => {
  it("matches 'has', 'has ' and 'part' against various label variants", async () => {
    const options = [
      { value: "http://example.org/hasPart", label: "has part" },
      { value: "http://example.org/has_part", label: "has_part" },
      { value: "http://example.org/hasPartCamel", label: "hasPart" },
      { value: "http://example.org/other", label: "other" },
    ];

    // Instead of interacting with the cmdk-based UI (which requires complex event simulation),
    // test the matching logic directly using the exported optionMatches helper.
    // Queries to test: "has ", "has", "part", "par"
    expect(optionMatches(options[0], "has ")).toBe(true);
    expect(optionMatches(options[1], "has ")).toBe(true);
    expect(optionMatches(options[2], "has ")).toBe(true);

    expect(optionMatches(options[0], "part")).toBe(true);
    expect(optionMatches(options[1], "part")).toBe(true);
    expect(optionMatches(options[2], "part")).toBe(true);

    expect(optionMatches(options[0], "par")).toBe(true);
    expect(optionMatches(options[1], "par")).toBe(true);
    expect(optionMatches(options[2], "par")).toBe(true);
  });
});
