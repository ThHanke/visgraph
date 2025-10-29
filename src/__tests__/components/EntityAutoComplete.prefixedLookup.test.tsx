import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import EntityAutoComplete from "../../components/ui/EntityAutoComplete";

/**
 * Verify that typing a prefixed namespace (e.g. "iof"), a prefixed identifier
 * (e.g. "iof:SomeClass") or a fragment of the full IRI shows the matching
 * entity in the suggestion list.
 */

describe("EntityAutoComplete - prefixed & IRI lookup", () => {
  it("suggests an entity when typing its stored prefixed form or namespace", async () => {
    const entities = [
      {
        iri: "http://example.org/iof#SomeClass",
        label: "Some IOF Class",
        prefixed: "iof:SomeClass",
        namespace: "http://example.org/iof#",
      },
    ];

    const { container } = render(
      <EntityAutoComplete
        entities={entities as any}
        onChange={() => {}}
        placeholder="Search..."
      />
    );

    const input = container.querySelector("input");
    expect(input).toBeTruthy();

    // Type namespace prefix
    fireEvent.change(input!, { target: { value: "iof" } });
    await waitFor(() => {
      expect(screen.getByText("iof:SomeClass")).toBeTruthy();
    });

    // Clear and type the prefixed identifier
    fireEvent.change(input!, { target: { value: "" } });
    fireEvent.change(input!, { target: { value: "iof:Some" } });
    await waitFor(() => {
      expect(screen.getByText("iof:SomeClass")).toBeTruthy();
    });

    // Clear and type a fragment of the full IRI
    fireEvent.change(input!, { target: { value: "" } });
    fireEvent.change(input!, { target: { value: "SomeClass" } });
    await waitFor(() => {
      expect(screen.getByText("iof:SomeClass")).toBeTruthy();
    });
  });

  it("matches when entity has no stored prefixed but iri contains the query", async () => {
    const entities = [
      {
        iri: "http://example.org/iof#OtherClass",
        label: "Other Class",
        // no prefixed property provided
        namespace: "http://example.org/iof#",
      },
    ];

    const { container } = render(
      <EntityAutoComplete
        entities={entities as any}
        onChange={() => {}}
        placeholder="Search..."
      />
    );

    const input = container.querySelector("input");
    expect(input).toBeTruthy();

    // Typing a fragment of the IRI should match
    fireEvent.change(input!, { target: { value: "OtherClass" } });
    await waitFor(() => {
      // The component displays ent.prefixed || ent.iri in the list;
      // since prefixed is absent, it will show the full IRI.
      expect(screen.getByText("http://example.org/iof#OtherClass")).toBeTruthy();
    });
  });
});
