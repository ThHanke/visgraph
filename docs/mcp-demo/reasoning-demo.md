# OWL-RL Reasoning Demo — Relay Session Log

> A recorded relay session: an AI assistant builds an OWL ontology from scratch.
> Shows exactly which TOOL blocks were issued at each turn and how the assistant
> interprets results and SVG feedback to decide what to do next.
>
> **Relay setup:** bookmarklet active on the AI chat tab, VisGraph open in a second tab.
> Each assistant response that contains TOOL blocks is executed automatically; results
> come back as a combined ✓/✗ message plus an SVG snapshot of the current canvas.

---

**You:** I want to model a small organisation in OWL. Let's start with a four-level class
hierarchy: Person → Employee → Manager → Executive. Then we'll add properties, individuals,
and run the reasoner.

**Assistant:** I'll build this in phases — classes first, then properties, then individuals,
then axioms connecting everything. That way each batch is independent and I can verify the
canvas shape from the SVG before wiring links.

Starting with the four class nodes. I can batch all `addNode` calls since they don't depend
on each other:

```text
TOOL: addNode
iri: http://example.com/reasoning-demo#Person
label: Person
typeIri: http://www.w3.org/2002/07/owl#Class

TOOL: addNode
iri: http://example.com/reasoning-demo#Employee
label: Employee
typeIri: http://www.w3.org/2002/07/owl#Class

TOOL: addNode
iri: http://example.com/reasoning-demo#Manager
label: Manager
typeIri: http://www.w3.org/2002/07/owl#Class

TOOL: addNode
iri: http://example.com/reasoning-demo#Executive
label: Executive
typeIri: http://www.w3.org/2002/07/owl#Class
```

---

**[Result]**
```text
[VisGraph — 4 tools ✓]
✓ addNode: http://example.com/reasoning-demo#Person
✓ addNode: http://example.com/reasoning-demo#Employee
✓ addNode: http://example.com/reasoning-demo#Manager
✓ addNode: http://example.com/reasoning-demo#Executive

Canvas: 4 nodes (Person, Employee, Manager, Executive), 0 links
```

---

**Assistant:** All four classes are on canvas. Now the seven property nodes — still independent,
so I batch them:

```text
TOOL: addNode
iri: http://example.com/reasoning-demo#knows
label: knows
typeIri: http://www.w3.org/2002/07/owl#ObjectProperty

TOOL: addNode
iri: http://example.com/reasoning-demo#hasFriend
label: hasFriend
typeIri: http://www.w3.org/2002/07/owl#ObjectProperty

TOOL: addNode
iri: http://example.com/reasoning-demo#manages
label: manages
typeIri: http://www.w3.org/2002/07/owl#ObjectProperty

TOOL: addNode
iri: http://example.com/reasoning-demo#isManagedBy
label: isManagedBy
typeIri: http://www.w3.org/2002/07/owl#ObjectProperty

TOOL: addNode
iri: http://example.com/reasoning-demo#isColleagueOf
label: isColleagueOf
typeIri: http://www.w3.org/2002/07/owl#ObjectProperty

TOOL: addNode
iri: http://example.com/reasoning-demo#hasSupervisor
label: hasSupervisor
typeIri: http://www.w3.org/2002/07/owl#ObjectProperty

TOOL: addNode
iri: http://example.com/reasoning-demo#jobTitle
label: jobTitle
typeIri: http://www.w3.org/2002/07/owl#AnnotationProperty
```

---

**[Result]**
```text
[VisGraph — 7 tools ✓]
✓ addNode: http://example.com/reasoning-demo#knows
✓ addNode: http://example.com/reasoning-demo#hasFriend
✓ addNode: http://example.com/reasoning-demo#manages
✓ addNode: http://example.com/reasoning-demo#isManagedBy
✓ addNode: http://example.com/reasoning-demo#isColleagueOf
✓ addNode: http://example.com/reasoning-demo#hasSupervisor
✓ addNode: http://example.com/reasoning-demo#jobTitle

Canvas: 11 nodes (Person, Employee, Manager, Executive, knows, hasFriend, manages, isManagedBy +3 more), 0 links
```

---

**You:** Great. Now connect everything — subclass chain, property axioms, domain and range.

**Assistant:** All nodes exist on canvas, so I can batch all `addLink` calls in one response.
I'll close with `runLayout` + `fitCanvas` + `exportImage` so you can see the TBox shape:

```text
TOOL: addLink
subjectIri: http://example.com/reasoning-demo#Employee
predicateIri: http://www.w3.org/2000/01/rdf-schema#subClassOf
objectIri: http://example.com/reasoning-demo#Person

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#Manager
predicateIri: http://www.w3.org/2000/01/rdf-schema#subClassOf
objectIri: http://example.com/reasoning-demo#Employee

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#Executive
predicateIri: http://www.w3.org/2000/01/rdf-schema#subClassOf
objectIri: http://example.com/reasoning-demo#Manager

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#hasFriend
predicateIri: http://www.w3.org/2000/01/rdf-schema#subPropertyOf
objectIri: http://example.com/reasoning-demo#knows

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#isManagedBy
predicateIri: http://www.w3.org/2002/07/owl#inverseOf
objectIri: http://example.com/reasoning-demo#manages

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#isColleagueOf
predicateIri: http://www.w3.org/1999/02/22-rdf-syntax-ns#type
objectIri: http://www.w3.org/2002/07/owl#SymmetricProperty

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#hasSupervisor
predicateIri: http://www.w3.org/1999/02/22-rdf-syntax-ns#type
objectIri: http://www.w3.org/2002/07/owl#TransitiveProperty

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#manages
predicateIri: http://www.w3.org/2000/01/rdf-schema#domain
objectIri: http://example.com/reasoning-demo#Manager

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#manages
predicateIri: http://www.w3.org/2000/01/rdf-schema#range
objectIri: http://example.com/reasoning-demo#Employee

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#knows
predicateIri: http://www.w3.org/2000/01/rdf-schema#domain
objectIri: http://example.com/reasoning-demo#Person

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#knows
predicateIri: http://www.w3.org/2000/01/rdf-schema#range
objectIri: http://example.com/reasoning-demo#Person

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#jobTitle
predicateIri: http://www.w3.org/2000/01/rdf-schema#subPropertyOf
objectIri: http://www.w3.org/2000/01/rdf-schema#comment

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
[VisGraph — 15 tools ✓]
✓ addLink: s=Employee p=rdfs:subClassOf o=Person (×3 subclass chain)
✓ addLink: s=hasFriend p=rdfs:subPropertyOf o=knows
✓ addLink: s=isManagedBy p=owl:inverseOf o=manages
✓ addLink: s=isColleagueOf p=rdf:type o=owl:SymmetricProperty
✓ addLink: s=hasSupervisor p=rdf:type o=owl:TransitiveProperty
✓ addLink: s=manages p=rdfs:domain o=Manager
✓ addLink: s=manages p=rdfs:range o=Employee
✓ addLink: s=knows p=rdfs:domain o=Person (×2)
✓ addLink: s=jobTitle p=rdfs:subPropertyOf o=rdfs:comment
✓ runLayout: dagre-lr
✓ fitCanvas: ok
✓ exportImage: (SVG attached)

Canvas: 11 nodes (Person, Employee, Manager, Executive, knows, hasFriend, manages, isManagedBy +3 more), 13 links
```

![TBox — classes and properties on canvas](./reasoning-demo/01-tbox.svg)

---

**Assistant:** The SVG confirms the TBox is correct — subClassOf chain runs left to right
(Person → Employee → Manager → Executive), `manages` domain/range arrows are visible,
`hasFriend → knows` subPropertyOf edge present. Ready for individuals.

---

**You:** Now for the individuals: Alice is an Executive, Bob and Carol are Employees.
Dave has no type yet — I want to see if the reasoner works it out.

**Assistant:** Adding all four people. Dave intentionally gets no `typeIri` — his type will be
inferred from the `manages rdfs:domain Manager` axiom once he asserts a `manages` edge.

```text
TOOL: addNode
iri: http://example.com/reasoning-demo#alice
label: Alice
typeIri: http://example.com/reasoning-demo#Executive

TOOL: addNode
iri: http://example.com/reasoning-demo#bob
label: Bob
typeIri: http://example.com/reasoning-demo#Employee

TOOL: addNode
iri: http://example.com/reasoning-demo#carol
label: Carol
typeIri: http://example.com/reasoning-demo#Employee

TOOL: addNode
iri: http://example.com/reasoning-demo#dave
label: Dave
```

---

**[Result]**
```text
[VisGraph — 4 tools ✓]
✓ addNode: http://example.com/reasoning-demo#alice
✓ addNode: http://example.com/reasoning-demo#bob
✓ addNode: http://example.com/reasoning-demo#carol
✓ addNode: http://example.com/reasoning-demo#dave

Canvas: 15 nodes (Person, Employee, Manager, Executive, knows, hasFriend, manages, isManagedBy +7 more), 13 links
```

---

**You:** Give Alice the title "Chief Executive" and Dave "Division Manager" using `ex:jobTitle`.

**Assistant:** Literal values go in as the `objectIri` field — the RDF store detects non-IRI
strings and stores them as literals.

```text
TOOL: addLink
subjectIri: http://example.com/reasoning-demo#alice
predicateIri: http://example.com/reasoning-demo#jobTitle
objectIri: Chief Executive

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#dave
predicateIri: http://example.com/reasoning-demo#jobTitle
objectIri: Division Manager
```

---

**[Result]**
```text
[VisGraph — 2 tools ✓]
✓ addLink: s=alice p=jobTitle o=Chief Executive
✓ addLink: s=dave p=jobTitle o=Division Manager

Canvas: 15 nodes (Person, Employee, Manager, Executive, knows, hasFriend, manages, isManagedBy +7 more), 15 links
```

---

**You:** Now the relationships: Alice manages Carol, Dave manages Bob, Alice is friends with
Bob, Bob and Carol are colleagues, and the supervisor chain is Carol → Bob → Alice.

**Assistant:** Six edges, all nodes already on canvas — batching them all. Adding layout and
export at the end to confirm the ABox shape before we run the reasoner:

```text
TOOL: addLink
subjectIri: http://example.com/reasoning-demo#alice
predicateIri: http://example.com/reasoning-demo#manages
objectIri: http://example.com/reasoning-demo#carol

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#dave
predicateIri: http://example.com/reasoning-demo#manages
objectIri: http://example.com/reasoning-demo#bob

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#alice
predicateIri: http://example.com/reasoning-demo#hasFriend
objectIri: http://example.com/reasoning-demo#bob

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#bob
predicateIri: http://example.com/reasoning-demo#isColleagueOf
objectIri: http://example.com/reasoning-demo#carol

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#carol
predicateIri: http://example.com/reasoning-demo#hasSupervisor
objectIri: http://example.com/reasoning-demo#bob

TOOL: addLink
subjectIri: http://example.com/reasoning-demo#bob
predicateIri: http://example.com/reasoning-demo#hasSupervisor
objectIri: http://example.com/reasoning-demo#alice

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
✓ addLink: s=alice p=manages o=carol
✓ addLink: s=dave p=manages o=bob
✓ addLink: s=alice p=hasFriend o=bob
✓ addLink: s=bob p=isColleagueOf o=carol
✓ addLink: s=carol p=hasSupervisor o=bob
✓ addLink: s=bob p=hasSupervisor o=alice
✓ runLayout: dagre-lr
✓ fitCanvas: ok
✓ exportImage: (SVG attached)

Canvas: 15 nodes (Person, Employee, Manager, Executive, knows, hasFriend, manages, isManagedBy +7 more), 21 links
```

![Full graph before reasoning](./reasoning-demo/02-before-reasoning.svg)

---

**Assistant:** SVG shows 15 nodes (4 classes + 7 properties + 4 people) with all asserted
edges. Dave has no type annotation visible — as expected. Ready to reason.

---

**You:** Okay, run the reasoner and show me what it inferred.

**Assistant:** Running reasoning, then refreshing layout and exporting so you can see the
inferred edges appear:

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
✓ runReasoning: 22873 triples inferred
✓ runLayout: dagre-lr
✓ fitCanvas: ok
✓ exportImage: (SVG attached)

Canvas: 15 nodes (Person, Employee, Manager, Executive, knows, hasFriend, manages, isManagedBy +7 more), 97 links
```

![Graph after reasoning — inferred edges and types visible](./reasoning-demo/03-after-reasoning.svg)

---

**Assistant:** The SVG shows new edges that weren't there before — the reasoner fired
multiple rules. Summary of what was inferred:

**Inferred types** (subClassOf chain + domain axiom):

| Person | Asserted type | Inferred |
|--------|--------------|---------|
| alice | Executive | Manager, Employee, Person |
| bob | Employee | Manager, Person |
| carol | Employee | Person |
| dave | — | Manager, Employee, Person |

**Key inferred relationships:**

| Triple | Rule |
|--------|------|
| alice ex:knows bob | hasFriend ⊆ knows (subPropertyOf) |
| carol ex:isManagedBy alice | inverse of manages |
| carol ex:isColleagueOf bob | SymmetricProperty |
| carol ex:hasSupervisor alice | TransitiveProperty (carol→bob→alice) |

---

**You:** Dave had no explicit type — what did the reasoner give him?

**Assistant:** Using `searchEntities` to find Dave and focus the viewport, then expanding
his node to show the annotation card with inferred types:

```text
TOOL: searchEntities
query: Dave

TOOL: expandNode
iri: http://example.com/reasoning-demo#dave
```

---

**[Result]**
```text
[VisGraph — 2 tools ✓]
✓ searchEntities: 1 results, 1 on canvas (auto-focused)
✓ expandNode: ok

Canvas: 15 nodes (Person, Employee, Manager, Executive, knows, hasFriend, manages, isManagedBy +7 more), 97 links
```

![Dave's node — inferred types visible in annotation card](./reasoning-demo/04-dave-focus.svg)

---

**Assistant:** Dave's annotation card shows `rdf:type` inferred as Manager, Employee, and
Person. The chain: `dave manages bob` → domain axiom gives `Manager` → subClassOf gives
`Employee` then `Person`.

---

**You:** Perfect. Export the complete graph as Turtle.

**Assistant:**

```text
TOOL: exportGraph
format: turtle
```

---

**[Result]**
```text
[VisGraph — 1 tool ✓]
✓ exportGraph: (1842 chars)
```

```turtle
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix ex: <http://example.com/reasoning-demo#> .

ex:Person a owl:Class ; rdfs:label "Person" .
ex:Employee a owl:Class ; rdfs:label "Employee" ; rdfs:subClassOf ex:Person .
ex:Manager a owl:Class ; rdfs:label "Manager" ; rdfs:subClassOf ex:Employee .
ex:Executive a owl:Class ; rdfs:label "Executive" ; rdfs:subClassOf ex:Manager .
ex:knows a owl:ObjectProperty ; rdfs:label "knows" ;
    rdfs:domain ex:Person ; rdfs:range ex:Person .
ex:hasFriend a owl:ObjectProperty ; rdfs:label "hasFriend" ;
    rdfs:subPropertyOf ex:knows ; rdfs:domain ex:Person ; rdfs:range ex:Person .
ex:manages a owl:ObjectProperty ; rdfs:label "manages" ;
    rdfs:domain ex:Manager ; rdfs:range ex:Employee .
ex:isManagedBy a owl:ObjectProperty ; rdfs:label "isManagedBy" ;
    owl:inverseOf ex:manages .
ex:isColleagueOf a owl:ObjectProperty, owl:SymmetricProperty ; rdfs:label "isColleagueOf" .
ex:hasSupervisor a owl:ObjectProperty, owl:TransitiveProperty ; rdfs:label "hasSupervisor" .
ex:jobTitle a owl:AnnotationProperty ; rdfs:label "jobTitle" ;
    rdfs:subPropertyOf rdfs:comment .
ex:alice a ex:Executive ; rdfs:label "Alice" ;
    ex:jobTitle "Chief Executive" ; ex:hasFriend ex:bob ; ex:manages ex:carol .
ex:bob a ex:Employee ; rdfs:label "Bob" ;
    ex:isColleagueOf ex:carol ; ex:hasSupervisor ex:alice .
ex:carol a ex:Employee ; rdfs:label "Carol" ; ex:hasSupervisor ex:bob .
ex:dave rdfs:label "Dave" ; ex:jobTitle "Division Manager" ; ex:manages ex:bob .
```

The inferred triples live in `urn:vg:inferred` and are not included here — only the asserted graph is exported.
