import React from "react";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { N3DataProvider } from "../../providers/N3DataProvider";
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
      // No prefixed form — component shows local name via prefixShorten fallback.
      expect(screen.getByText("OtherClass")).toBeTruthy();
    });
  });
});

function mockDataProvider(linkTypes: Array<{ id: string; label?: Record<string, string> }> = []): N3DataProvider {
  return {
    knownLinkTypes: vi.fn().mockResolvedValue(linkTypes),
    knownElementTypes: vi.fn().mockResolvedValue({ elementTypes: [], subtypes: new Map() }),
    getDomainRange: vi.fn().mockReturnValue({ domains: [], ranges: [] }),
  } as unknown as N3DataProvider;
}

describe('EntityAutoComplete - dataProvider mode', () => {
  it('loads link types from dataProvider when mode=properties', async () => {
    const dp = mockDataProvider([{ id: 'http://ex.org/knows', label: { en: 'knows' } }]);
    const { container } = render(
      <EntityAutoComplete mode="properties" dataProvider={dp} onChange={() => {}} />
    );
    const input = container.querySelector('input')!;
    fireEvent.focus(input);
    await waitFor(() => {
      // 'knows' appears as both the shortened IRI and the label — use getAllByText
      expect(screen.getAllByText('knows').length).toBeGreaterThan(0);
    });
  });

  it('shows tier separator when sourceClassIri and targetClassIri provided', async () => {
    const dp = mockDataProvider([{ id: 'http://ex.org/knows', label: { en: 'knows' } }]);
    render(
      <EntityAutoComplete
        mode="properties"
        dataProvider={dp}
        sourceClassIri="http://ex.org/Person"
        targetClassIri="http://ex.org/Person"
        autoOpen
        onChange={() => {}}
      />
    );
    await waitFor(() => {
      // Score 2 (unconstrained, no domain/range) → should show "General" tier label
      expect(screen.getByText('General')).toBeTruthy();
    });
  });
});
