# FOAF Social Network — Relay Session Log

> A recorded relay session: an AI assistant builds a FOAF social network from scratch.
> Shows the exact TOOL blocks issued at each turn and how the assistant reads SVG feedback
> to decide what to do next.
>
> **Relay setup:** bookmarklet active on the AI chat tab, VisGraph open in a second tab.

---

**You:** I'd like to model a social network using FOAF. Can you get that set up?

**Assistant:** Loading the FOAF vocabulary first so the classes and properties are available
in the RDF store. Then I'll check what landed:

```text
TOOL: loadRdf
url: http://xmlns.com/foaf/0.1/

TOOL: getGraphState
```

---

**[Result]**
```text
[VisGraph — 2 tools ✓]
✓ loadRdf: http://xmlns.com/foaf/0.1/ — 62 new entities available
✓ getGraphState: 0 nodes, 0 links

Canvas: 0 nodes (), 0 links
```

---

**Assistant:** FOAF vocabulary is in the RDF store. Canvas is empty — the vocabulary nodes
aren't placed yet, which is fine; I'll add the domain individuals directly.

---

**You:** We have four researchers — Alice (the PI), Bob, Carol, and Dave — plus two
organisations: ACME Corp and Research Labs. Can you add them all?

**Assistant:** Six nodes, all independent — batching them together. Adding layout and export
at the end so you can see the initial placement:

```text
TOOL: addNode
iri: http://example.org/alice
label: Alice (PI)
typeIri: http://xmlns.com/foaf/0.1/Person

TOOL: addNode
iri: http://example.org/bob
label: Bob
typeIri: http://xmlns.com/foaf/0.1/Person

TOOL: addNode
iri: http://example.org/carol
label: Carol
typeIri: http://xmlns.com/foaf/0.1/Person

TOOL: addNode
iri: http://example.org/dave
label: Dave
typeIri: http://xmlns.com/foaf/0.1/Person

TOOL: addNode
iri: http://example.org/acme
label: ACME Corp
typeIri: http://xmlns.com/foaf/0.1/Organization

TOOL: addNode
iri: http://example.org/labs
label: Research Labs
typeIri: http://xmlns.com/foaf/0.1/Organization

TOOL: runLayout
algorithm: dagre-lr

TOOL: fitCanvas

TOOL: exportImage
format: svg
noCss: true
```

---

**[Result]**
```text
[VisGraph — 9 tools ✓]
✓ addNode: http://example.org/alice
✓ addNode: http://example.org/bob
✓ addNode: http://example.org/carol
✓ addNode: http://example.org/dave
✓ addNode: http://example.org/acme
✓ addNode: http://example.org/labs
✓ runLayout: dagre-lr
✓ fitCanvas: ok
✓ exportImage: (SVG attached)

Canvas: 6 nodes (Alice (PI), Bob, Carol, Dave, ACME Corp, Research Labs), 0 links
```

![Six nodes on canvas](./foaf-social-network/01-nodes.svg)

---

**Assistant:** SVG shows all six boxes with correct labels. Ready for relationships.

---

**You:** Alice knows Bob and Carol. Bob knows Carol. Dave knows Alice. Alice and Bob are
members of ACME Corp; Carol and Dave are members of Research Labs.

**Assistant:** Eight edges, all source and target nodes confirmed on canvas — batching all
`addLink` calls plus a layout/export at the end:

```text
TOOL: addLink
subjectIri: http://example.org/alice
predicateIri: http://xmlns.com/foaf/0.1/knows
objectIri: http://example.org/bob

TOOL: addLink
subjectIri: http://example.org/alice
predicateIri: http://xmlns.com/foaf/0.1/knows
objectIri: http://example.org/carol

TOOL: addLink
subjectIri: http://example.org/bob
predicateIri: http://xmlns.com/foaf/0.1/knows
objectIri: http://example.org/carol

TOOL: addLink
subjectIri: http://example.org/dave
predicateIri: http://xmlns.com/foaf/0.1/knows
objectIri: http://example.org/alice

TOOL: addLink
subjectIri: http://example.org/alice
predicateIri: http://xmlns.com/foaf/0.1/member
objectIri: http://example.org/acme

TOOL: addLink
subjectIri: http://example.org/bob
predicateIri: http://xmlns.com/foaf/0.1/member
objectIri: http://example.org/acme

TOOL: addLink
subjectIri: http://example.org/carol
predicateIri: http://xmlns.com/foaf/0.1/member
objectIri: http://example.org/labs

TOOL: addLink
subjectIri: http://example.org/dave
predicateIri: http://xmlns.com/foaf/0.1/member
objectIri: http://example.org/labs

TOOL: runLayout
algorithm: dagre-lr

TOOL: fitCanvas

TOOL: exportImage
format: svg
noCss: true
```

---

**[Result]**
```text
[VisGraph — 11 tools ✓]
✓ addLink: s=alice p=foaf:knows o=bob
✓ addLink: s=alice p=foaf:knows o=carol
✓ addLink: s=bob p=foaf:knows o=carol
✓ addLink: s=dave p=foaf:knows o=alice
✓ addLink: s=alice p=foaf:member o=acme
✓ addLink: s=bob p=foaf:member o=acme
✓ addLink: s=carol p=foaf:member o=labs
✓ addLink: s=dave p=foaf:member o=labs
✓ runLayout: dagre-lr
✓ fitCanvas: ok
✓ exportImage: (SVG attached)

Canvas: 6 nodes (Alice (PI), Bob, Carol, Dave, ACME Corp, Research Labs), 8 links
```

![Network with knows and member relationships](./foaf-social-network/02-links.svg)

---

**Assistant:** SVG shows the network structure — `knows` edges between researchers,
`member` edges connecting people to organisations. Looking correct.

---

**You:** Can you run the reasoner now and tell me what it figured out?

**Assistant:** Running OWL-RL. FOAF declares `foaf:Person rdfs:subClassOf foaf:Agent`, so
every Person should also receive the `foaf:Agent` type automatically.

```text
TOOL: runReasoning

TOOL: runLayout
algorithm: dagre-lr

TOOL: fitCanvas

TOOL: exportImage
format: svg
noCss: true
```

---

**[Result]**
```text
[VisGraph — 4 tools ✓]
✓ runReasoning: 22778 triples inferred
✓ runLayout: dagre-lr
✓ fitCanvas: ok
✓ exportImage: (SVG attached)

Canvas: 6 nodes (Alice (PI), Bob, Carol, Dave, ACME Corp, Research Labs), 54 links
```

![Graph after reasoning — Agent types inferred](./foaf-social-network/03-after-reasoning.svg)

---

**Assistant:** All four researchers now carry `foaf:Agent` as an inferred type — visible
as additional type annotations in the SVG node cards. The inferred triples are stored
in `urn:vg:inferred` and won't appear in an `exportGraph` call.

---

**You:** Who's a member of ACME Corp? Can you zoom in on it?

**Assistant:** Using `searchEntities` to focus the viewport on ACME, then expanding the
node to show its annotation card:

```text
TOOL: searchEntities
query: ACME

TOOL: expandNode
iri: http://example.org/acme
```

---

**[Result]**
```text
[VisGraph — 2 tools ✓]
✓ searchEntities: 1 results, 1 on canvas (auto-focused)
✓ expandNode: ok

Canvas: 6 nodes (Alice (PI), Bob, Carol, Dave, ACME Corp, Research Labs), 54 links
```

![ACME Corp and its members](./foaf-social-network/04-acme-focus.svg)

---

**Assistant:** The expanded ACME node shows Alice and Bob as `foaf:member`. Carol and Dave
are at Research Labs.

---

**You:** One more person: add Eve. She's a researcher who knows Bob and works at Research Labs.

**Assistant:** Adding Eve first — links must come after the node exists, so this needs two
batches:

```text
TOOL: addNode
iri: http://example.org/eve
label: Eve
typeIri: http://xmlns.com/foaf/0.1/Person
```

---

**[Result]**
```text
[VisGraph — 1 tool ✓]
✓ addNode: http://example.org/eve

Canvas: 7 nodes (Alice (PI), Bob, Carol, Dave, ACME Corp, Research Labs, Eve), 54 links
```

---

**Assistant:** Node confirmed. Now wiring her relationships:

```text
TOOL: addLink
subjectIri: http://example.org/eve
predicateIri: http://xmlns.com/foaf/0.1/knows
objectIri: http://example.org/bob

TOOL: addLink
subjectIri: http://example.org/eve
predicateIri: http://xmlns.com/foaf/0.1/member
objectIri: http://example.org/labs

TOOL: runLayout
algorithm: dagre-lr

TOOL: fitCanvas

TOOL: exportImage
format: svg
noCss: true
```

---

**[Result]**
```text
[VisGraph — 5 tools ✓]
✓ addLink: s=eve p=foaf:knows o=bob
✓ addLink: s=eve p=foaf:member o=labs
✓ runLayout: dagre-lr
✓ fitCanvas: ok
✓ exportImage: (SVG attached)

Canvas: 7 nodes (Alice (PI), Bob, Carol, Dave, ACME Corp, Research Labs, Eve), 56 links
```

![Eve added — knows Bob, member of Research Labs](./foaf-social-network/05-eve-added.svg)

---

**You:** Nice! Export the whole thing as Turtle so I can use it elsewhere.

**Assistant:**

```text
TOOL: exportGraph
format: turtle
```

---

**[Result]**
```text
[VisGraph — 1 tool ✓]
✓ exportGraph: (748 chars)
```

```turtle
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .

<http://example.org/alice> a foaf:Person ;
    rdfs:label "Alice (PI)" ;
    foaf:knows <http://example.org/bob>, <http://example.org/carol> ;
    foaf:member <http://example.org/acme> .
<http://example.org/bob> a foaf:Person ;
    rdfs:label "Bob" ;
    foaf:knows <http://example.org/carol> ;
    foaf:member <http://example.org/acme> .
<http://example.org/carol> a foaf:Person ;
    rdfs:label "Carol" ;
    foaf:member <http://example.org/labs> .
<http://example.org/dave> a foaf:Person ;
    rdfs:label "Dave" ;
    foaf:knows <http://example.org/alice> ;
    foaf:member <http://example.org/labs> .
<http://example.org/acme> a foaf:Organization ;
    rdfs:label "ACME Corp" .
<http://example.org/labs> a foaf:Organization ;
    rdfs:label "Research Labs" .
<http://example.org/eve> a foaf:Person ;
    rdfs:label "Eve" ;
    foaf:knows <http://example.org/bob> ;
    foaf:member <http://example.org/labs> .
```

7 nodes · 16 links
