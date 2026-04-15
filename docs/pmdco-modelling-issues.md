# PMDCo Modelling Issues & Data Quality Findings

Cross-dataspace demo datasets: `cross-project-use-case` (Catena-X / PA6GF30),
`steel-inspection-document-mapro` (Manufacturing-X / Steel 316/4401),
`pmd-x-cross-dataspace-demo` (joint assembly).

---

## 1. Incompatible property-value patterns between pipelines

**Severity: Critical — blocks unified cross-dataspace querying**

The two pipelines produce PMDCo graphs using structurally different patterns to attach
measured values to material properties. A single SPARQL query cannot retrieve both
mechanical properties (PA6GF30 + steel) and chemical composition (steel) without
branching logic.

### Pattern A — Catena-X pipeline (PA6GF30) + Steel mechanical properties

```
material
  └─ obo:RO_0000086 → quality
       └─ obo:IAO_0000417 → datum
            └─ obo:OBI_0001938 → QuantityValue
                 ├─ qudt:numericValue "210.0"^^xsd:float
                 └─ qudt:unit qudt:MegaPA
```

Used for: all 8 PA6GF30 properties, all 3 steel mechanical properties (tensile
strength, yield strength, elongation).

### Pattern B — AAS2KG pipeline (Steel 316/4401) chemical composition

```
chem_comp (PMD_0000551)
  └─ obo:RO_0000080 → material          ← INVERSE direction (quality_of, not has_quality)

mass_proportion (PMD_0020102)
  └─ pmd:PMD_0000077 → fraction_value   ← different value predicate
       └─ obo:OBI_0001937 → value        ← OBI_0001937 not OBI_0001938
  └─ pmd:PMD_0025999 → element_entity
```

Used for: 9 chemical composition elements (C, Cr, Mn, Mo, Ni, N, P, Si, S).

**Differences:**

| Aspect | Pattern A | Pattern B |
|--------|-----------|-----------|
| Material → property direction | `RO_0000086` (has quality) | `RO_0000080` (is quality of) — reversed |
| Property class | TTO / PMD quality | `PMD_0020102` (MassProportion) |
| Value predicate | `OBI_0001938` | `OBI_0001937` |
| Unit ontology | QUDT (`qudt:unit`) | UO (`IAO_0000039` / `UO_0000163`) |

**Fix:** Standardise on one pattern. Pattern A is simpler and used consistently in
both pipelines for mechanical data. Chemical composition in the AAS2KG SPARQL mapping
should be rewritten to use `RO_0000086` + `OBI_0001938` + `qudt:unit`.
**Pipeline to fix:** `InspectionDocument_AAS2KG_mapping.sparql` (Manufacturing-X
pipeline, dataset 2).

---

## 2. Wrong QUDT unit for steel elongation after fracture

**Severity: High — produces wrong query results**

In `InspectionDocument_316_4401_alloy_PMDCore.ttl` (dataset 2 + loaded in dataset 3):

```turtle
# Current (wrong)
qudt:unit qudt:MegaPA

# Should be
qudt:unit unit:PERCENT
```

The elongation value `60` is dimensionless (%), not a pressure. The incorrect unit
causes the SPARQL query to return no `?unit` binding for that row (because pattern
matching on PERCENT fails) and would produce wrong unit conversions in downstream use.

**Fix:** Replace in `InspectionDocument_316_4401_alloy_PMDCore.ttl`, re-upload to
dataset 2, re-load into dataset 3 Fuseki.
**Pipeline to fix:** `InspectionDocument_AAS2KG_mapping.sparql` — fix the unit
binding for elongation in the SPARQL CONSTRUCT, then regenerate the TTL.

---

## 3. Missing `rdfs:label` on PA6GF30 quality instances

**Severity: Medium — degrades query usability**

Three quality instances in `material_data_pa6gf30_pmdco.ttl` have no `rdfs:label`:

| Quality IRI fragment | Value | Should be labelled |
|----------------------|-------|--------------------|
| `MechanicalProperty_210_9800-qual-flexuralStrength` | 210.0 MPa | "flexural strength" |
| `MechanicalProperty_210_9800-qual-stressAtBreak` | 140.0 MPa | "stress at break" |
| `MechanicalProperty_210_9800-qual-strainAtBreak` | 3.0 % | "strain at break" |

The SPARQL query currently falls back to extracting the camelCase fragment from the
IRI (e.g. `flexuralStrength`), which is readable but not clean.

**Fix:** Add `rdfs:label` triples in `pmdco-mapping-insert.sparql`, regenerate and
re-upload `material_data_pa6gf30_pmdco.ttl`.
**Pipeline to fix:** `pmdco-mapping-insert.sparql` (Catena-X pipeline, dataset 1).

---

## 4. Overly generic PMDCo class assignments in PA6GF30 graph

**Severity: Medium — harms ontological precision**

Two PMDCo classes used in the PA6GF30 mapping are too generic to identify properties
unambiguously:

- `PMD_0000952` ("strength") assigned to both **flexural strength** (210 MPa) and
  **stress at break** (140 MPa). These are distinct material properties and should use
  distinct subclasses.
- `PMD_0000005` ("material property") assigned to **strain at break** (3.0 %).
  This is effectively untyped — any property could be a `material property`.

**Fix:** Identify or request more specific PMDCo subclasses for these properties.
If no specific class exists, raise with PMDCo maintainers
([core-ontology issue tracker](https://github.com/materialdigital/core-ontology)).
**Pipeline to fix:** `pmdco-mapping-insert.sparql` (Catena-X pipeline, dataset 1).

---

## 5. TTO ontology classes not loaded into Fuseki

**Severity: Medium — prevents label resolution from ontology**

The steel mechanical properties use TTO (Technical Terminology Ontology) class IRIs:
- `https://w3id.org/pmd/tto/TTO_0000009` (yield strength)
- `https://w3id.org/pmd/tto/TTO_0000033` (elongation at fracture)
- `https://w3id.org/pmd/tto/TTO_0000053` (tensile strength)

These classes have no `rdfs:label` in any of the three dataset Fuseki stores.
Label resolution via `?qualityType rdfs:label ?label` fails for all steel mechanical
properties. The cross-dataspace query works around this with a hardcoded `VALUES`
block, but any generic PMDCo explorer tool relying on labels would show blank entries.

**Fix:** Load the TTO ontology as a named graph into the Fuseki stores, or add
`rdfs:label` triples directly to the steel PMDCo TTL.
**Pipeline to fix:** AAS2KG output step — add labels to generated quality instances
in `InspectionDocument_AAS2KG_mapping.sparql`.

---

## 6. No dedicated `hasMaterial` property in PMDCo

**Severity: Low — workaround in place, but semantically imprecise**

PMDCo has no direct `hasMaterial` or `isMadeOf` object property linking a physical
object to its material entity. The assembly graph (`tension_pully.ttl`) and the
cross-dataspace query use `obo:BFO_0000051` (has part) as a substitute:

```turtle
ex:PulleyWheel obo:BFO_0000051 <...#MaterialData_Z1234-material> .
```

`BFO_0000051` (has part) is a mereological relation intended for physical parts of
physical wholes, not for object-material composition. Semantically, a material entity
is not a "part" of a physical object in the BFO sense.

**Fix:** When PMDCo introduces a dedicated property, update `tension_pully.ttl` and
the cross-dataspace query. For now, document the workaround explicitly.

---

## 7. Demo IRIs in non-dereferenceable namespaces

**Severity: Low — demo context only, not a production issue**

All component and material IRIs in `tension_pully.ttl` use placeholder namespaces:

```turtle
# Fake EDC IRI (Catena-X component)
<https://catena-x.net/edc/assets/urn:uuid:3f5a8c2d-1234-4b6e-9abc-def012345678>

# Fake Manufacturing-X IRI
<https://mfg-x.2024.2de/dsp/assets/component-87654321>

# Example namespace (steel material)
<http://www.example.org/#316-4401_material>
```

None of these dereference. For a production demonstration, component IRIs should be
resolvable to actual dataspace catalogue entries, or at minimum use a declared
`ex:` namespace with a documented base URI.

**Fix:** For the demo, acceptable as-is. For a production pilot, replace with actual
EDC asset catalogue IRIs and resolvable material identifiers.

---

## 8. Chemical composition entirely absent from cross-dataspace query results

**Severity: High — demo shows only 3 of 12 steel properties**

Due to issue #1 (incompatible patterns), the 9 chemical composition mass fractions
from the steel dataset do not appear in the cross-dataspace query output. Users
running the example query see only 3 steel mechanical properties, giving a
misleading impression of the dataset's coverage.

The chemical composition data IS present in `InspectionDocument_316_4401_alloy_PMDCore.ttl`
and loaded in dataset 3 Fuseki, but uses Pattern B (see issue #1) which the current
query does not traverse.

**Fix:** Either fix Pattern B to use Pattern A (preferred, see issue #1), or extend
the cross-dataspace query with a UNION branch for Pattern B.
**Pipeline to fix:** `InspectionDocument_AAS2KG_mapping.sparql` (Manufacturing-X).

---

## 9. Unit ontology inconsistency: QUDT vs UO

**Severity: Medium — prevents unified unit handling**

The two pipelines use different unit ontologies:

- **Catena-X (PA6GF30)**: `qudt:unit <https://qudt.org/vocab/unit/MegaPA>` etc.
- **Steel mechanical**: same QUDT pattern
- **Steel chemical composition**: `obo:IAO_0000039 obo:UO_0000163` (Units Ontology,
  OBO format)

Any downstream application normalising units (e.g. converting MPa → Pa) must handle
two different unit IRI schemes.

**Fix:** Standardise on QUDT throughout. Update chemical composition mapping in
`InspectionDocument_AAS2KG_mapping.sparql`.
**Pipeline to fix:** Manufacturing-X pipeline (dataset 2).

---

## 10. Dataportal steel TTL is outdated — newer cross-usecase version exists in repo

**Severity: High — wrong file is loaded in demo**

The AAS2KG GitHub repo contains a dedicated output for the cross-dataspace demo at
`demo_cross_usecase/Output (RDF)/inspectiondocument_316_4401_alloy_pmdco.ttl`
that is more recent than the file currently on the dataportal and in dataset 3 Fuseki.

**New version differences vs dataportal version:**

| Aspect | Dataportal (old) | GitHub cross-usecase (new) |
|--------|-----------------|---------------------------|
| Elongation unit | `qudt:MegaPA` ❌ | `obo:IAO_0000039 qudt:PERCENT` ✅ |
| Numeric value predicate | `qudt:numericValue` | `pmd:PMD_0000006` |
| Unit predicate | `qudt:unit` | `obo:IAO_0000039` |
| QUDT namespace | `https://qudt.org/schema/qudt/` | `http://qudt.org/schema/qudt/` |
| Material IRI | separate `ex:#316-4401_material` | component IRI directly bears qualities |
| Component IRI | matches tension_pully.ttl | matches tension_pully.ttl |
| Chemical composition | present (Pattern B) | absent (simplified) |

**The new version still differs from Pattern A** (PA6GF30) in predicate names and
QUDT namespace. Uploading it to the dataportal will fix the elongation unit but the
cross-dataspace query must also be updated to use `pmd:PMD_0000006` and
`obo:IAO_0000039` instead of `qudt:numericValue` and `qudt:unit` — or the AAS2KG
output should be aligned to use QUDT predicates.

Saved locally as `docs/InspectionDocument_316_4401_alloy_PMDCore_v2.ttl`.

**Fix:** Upload new TTL to dataset 2 and dataset 3 Fuseki. Then either:
- (a) Update cross-dataspace query to handle both predicate patterns via UNION, or
- (b) Align AAS2KG output to use `qudt:numericValue` + `qudt:unit` + `https://` QUDT namespace

---

## Summary table

| # | Issue | Pipeline to fix | Severity |
|---|-------|----------------|----------|
| 1 | Incompatible property-value patterns (mechanical vs chemical) | AAS2KG (Mfg-X) | Critical |
| 2 | Steel elongation unit MPa → PERCENT | AAS2KG (Mfg-X) | High |
| 8 | Chemical composition missing from cross-dataspace query | AAS2KG (Mfg-X) | High |
| 9 | Unit ontology mismatch: QUDT vs UO | AAS2KG (Mfg-X) | Medium |
| 3 | Missing `rdfs:label` on PA6GF30 quality instances | pmdco-mapping-insert (CX) | Medium |
| 4 | Overly generic PMDCo classes for PA6GF30 properties | pmdco-mapping-insert (CX) | Medium |
| 5 | TTO ontology classes not loaded into Fuseki | AAS2KG output / Fuseki config | Medium |
| 6 | No `hasMaterial` property in PMDCo (BFO workaround) | PMDCo upstream / assembly graph | Low |
| 7 | Demo IRIs non-dereferenceable | tension_pully.ttl | Low |
| 10 | Dataportal steel TTL outdated (wrong unit, old predicates) | dataset 2 + 3 upload | High |
