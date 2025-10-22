import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import EntityAutoComplete from "../../components/ui/EntityAutoComplete";

/**
 * Verify that when a value (IRI) is provided and the corresponding entity
 * exists in the lookup (entities prop), the component displays the entity.prefixed
 * value inside the input when the user is not typing (query is empty).
 */

describe("EntityAutoComplete - in-field prefixed display", () => {
  it("shows entity.prefixed in the input when value matches an entity and query is empty", () => {
    const entities = [
      {
        iri: "http://example.org/test#propSeed",
        label: "Prop Seed",
        prefixed: "ex:propSeed",
        namespace: "http://example.org/test#",
      },
    ];

    const { container } = render(
      <EntityAutoComplete
        entities={entities as any}
        value="http://example.org/test#propSeed"
        onChange={() => {}}
        placeholder="Select option..."
      />
    );

    const input = container.querySelector('input');
    expect(input).toBeTruthy();
    expect((input as HTMLInputElement).value).toBe("ex:propSeed");
  });

  it("shows placeholder (empty input) when value does not match any entity", () => {
    const entities: any[] = [];

    const { container } = render(
      <EntityAutoComplete
        entities={entities}
        value="http://example.org/test#nonexistent"
        onChange={() => {}}
        placeholder="Select option..."
      />
    );

    const input = container.querySelector('input');
    expect(input).toBeTruthy();
    // input should be empty so placeholder is visible (value === "")
    expect((input as HTMLInputElement).value).toBe("");
  });
});
