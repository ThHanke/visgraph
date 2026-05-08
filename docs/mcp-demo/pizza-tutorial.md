# Pizza Tutorial — OWL-RL Demo

> Rebuilds the Manchester Pizza Tutorial ontology using only MCP tool calls, then runs OWL-RL
> reasoning to infer types from domain/range axioms, propagate types via subClassOf chains,
> fire inverse property rules, and classify ABox individuals into their named pizza types
> via owl:equivalentClass + owl:someValuesFrom restrictions.
> Seed file — do not edit the rendered file; edit this and regenerate.

---

**You:** Let's build the Manchester Pizza Ontology. Start in TBox view and add the three
top-level classes: Pizza, PizzaBase, and PizzaTopping.

**Assistant:** In OWL, a class is a named set of individuals. We start with three broad
categories — every individual in this ontology will belong to at least one of them.
Switching to TBox view (the ontology schema) and placing the root classes.


<details>
<summary>5 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"setViewMode","arguments":{"mode":"tbox"}}}`
`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#Pizza","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"Pizza"}}}`
`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#PizzaBase","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"PizzaBase"}}}`
`{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#PizzaTopping","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"PizzaTopping"}}}`
`{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"elk-layered","spacing":200}}}`

```tool-result
[Ontosphere — 5 tools ✓]
✓ setViewMode
✓ addNode: http://www.pizza-ontology.com/pizza.owl#Pizza
✓ addNode: http://www.pizza-ontology.com/pizza.owl#PizzaBase
✓ addNode: http://www.pizza-ontology.com/pizza.owl#PizzaTopping
✓ runLayout: elk-layered

Canvas: 3 nodes, 0 links
```

</details>

![Three root classes — every individual in this ontology is a Pizza, a PizzaBase, or a PizzaTopping](./pizza-tutorial/01-root-classes-bare.svg)

---

**You:** These three classes are siblings — no individual can belong to more than one.
Declare them pairwise disjoint.

**Assistant:** owl:disjointWith is a hard constraint: if two classes are disjoint and the
reasoner finds an individual typed as both, it signals an inconsistency. We need three
pairs to cover every combination.


<details>
<summary>4 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#Pizza","predicateIri":"http://www.w3.org/2002/07/owl#disjointWith","objectIri":"http://www.pizza-ontology.com/pizza.owl#PizzaBase"}}}`
`{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#Pizza","predicateIri":"http://www.w3.org/2002/07/owl#disjointWith","objectIri":"http://www.pizza-ontology.com/pizza.owl#PizzaTopping"}}}`
`{"jsonrpc":"2.0","id":8,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#PizzaBase","predicateIri":"http://www.w3.org/2002/07/owl#disjointWith","objectIri":"http://www.pizza-ontology.com/pizza.owl#PizzaTopping"}}}`
`{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"elk-layered","spacing":200}}}`

```tool-result
[Ontosphere — 4 tools ✓]
✓ addTriple
✓ addTriple
✓ addTriple
✓ runLayout: elk-layered

Canvas: 3 nodes, 3 links
```

</details>

![owl:disjointWith — an individual cannot be both a Pizza and a PizzaBase (or PizzaTopping). The reasoner enforces this.](./pizza-tutorial/02-root-disjoint.svg)

---

**You:** Add the two pizza base subclasses and declare them disjoint from each other.

**Assistant:** rdfs:subClassOf means every ThinAndCrispyBase individual is automatically
also a PizzaBase — the subclass inherits everything the superclass says. The two bases are
also disjoint: no base can be both thin and deep pan.


<details>
<summary>6 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":10,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#ThinAndCrispyBase","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"ThinAndCrispyBase"}}}`
`{"jsonrpc":"2.0","id":11,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#DeepPanBase","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"DeepPanBase"}}}`
`{"jsonrpc":"2.0","id":12,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#ThinAndCrispyBase","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#PizzaBase"}}}`
`{"jsonrpc":"2.0","id":13,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#DeepPanBase","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#PizzaBase"}}}`
`{"jsonrpc":"2.0","id":14,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#ThinAndCrispyBase","predicateIri":"http://www.w3.org/2002/07/owl#disjointWith","objectIri":"http://www.pizza-ontology.com/pizza.owl#DeepPanBase"}}}`
`{"jsonrpc":"2.0","id":15,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"elk-layered","spacing":160}}}`

```tool-result
[Ontosphere — 6 tools ✓]
✓ addNode: http://www.pizza-ontology.com/pizza.owl#ThinAndCrispyBase
✓ addNode: http://www.pizza-ontology.com/pizza.owl#DeepPanBase
✓ addTriple
✓ addTriple
✓ addTriple
✓ runLayout: elk-layered

Canvas: 5 nodes, 6 links
```

</details>

![rdfs:subClassOf — ThinAndCrispyBase and DeepPanBase are both PizzaBases, but disjoint from each other](./pizza-tutorial/03-base-hierarchy.svg)

---

**You:** Now add the NamedPizza branch with three specific pizzas under it.

**Assistant:** NamedPizza represents pizzas you'd find on a menu — it is itself a subclass of
Pizza. Margherita, AmericanHot, and FruttiDiMare are subclasses of NamedPizza, so they
are also implicitly Pizzas through the chain.


<details>
<summary>9 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":16,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#NamedPizza","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"NamedPizza"}}}`
`{"jsonrpc":"2.0","id":17,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#Margherita","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"Margherita"}}}`
`{"jsonrpc":"2.0","id":18,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#AmericanHot","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"AmericanHot"}}}`
`{"jsonrpc":"2.0","id":19,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#FruttiDiMare","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"FruttiDiMare"}}}`
`{"jsonrpc":"2.0","id":20,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#NamedPizza","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#Pizza"}}}`
`{"jsonrpc":"2.0","id":21,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#Margherita","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#NamedPizza"}}}`
`{"jsonrpc":"2.0","id":22,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#AmericanHot","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#NamedPizza"}}}`
`{"jsonrpc":"2.0","id":23,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#FruttiDiMare","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#NamedPizza"}}}`
`{"jsonrpc":"2.0","id":24,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"elk-layered","spacing":160}}}`

```tool-result
[Ontosphere — 9 tools ✓]
✓ addNode: http://www.pizza-ontology.com/pizza.owl#NamedPizza
✓ addNode: http://www.pizza-ontology.com/pizza.owl#Margherita
✓ addNode: http://www.pizza-ontology.com/pizza.owl#AmericanHot
✓ addNode: http://www.pizza-ontology.com/pizza.owl#FruttiDiMare
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ runLayout: elk-layered

Canvas: 9 nodes, 10 links
```

</details>

![NamedPizza ⊆ Pizza — the subclass hierarchy means Margherita is a NamedPizza and also a Pizza](./pizza-tutorial/04-named-pizza-hierarchy.svg)

---

**You:** Add the four topping categories under PizzaTopping.

**Assistant:** The tutorial groups toppings into four categories. Each is a subclass of
PizzaTopping — so every MozzarellaTopping (which we'll add next) will also be a
PizzaTopping through the chain.


<details>
<summary>9 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":25,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#CheeseTopping","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"CheeseTopping"}}}`
`{"jsonrpc":"2.0","id":26,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#MeatTopping","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"MeatTopping"}}}`
`{"jsonrpc":"2.0","id":27,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#VegetableTopping","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"VegetableTopping"}}}`
`{"jsonrpc":"2.0","id":28,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#FishTopping","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"FishTopping"}}}`
`{"jsonrpc":"2.0","id":29,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#CheeseTopping","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#PizzaTopping"}}}`
`{"jsonrpc":"2.0","id":30,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#MeatTopping","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#PizzaTopping"}}}`
`{"jsonrpc":"2.0","id":31,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#VegetableTopping","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#PizzaTopping"}}}`
`{"jsonrpc":"2.0","id":32,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#FishTopping","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#PizzaTopping"}}}`
`{"jsonrpc":"2.0","id":33,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"elk-layered","spacing":160}}}`

```tool-result
[Ontosphere — 9 tools ✓]
✓ addNode: http://www.pizza-ontology.com/pizza.owl#CheeseTopping
✓ addNode: http://www.pizza-ontology.com/pizza.owl#MeatTopping
✓ addNode: http://www.pizza-ontology.com/pizza.owl#VegetableTopping
✓ addNode: http://www.pizza-ontology.com/pizza.owl#FishTopping
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ runLayout: elk-layered

Canvas: 13 nodes, 14 links
```

</details>

![Four topping categories — each a subclass of PizzaTopping, so every specific topping inherits PizzaTopping membership](./pizza-tutorial/05-topping-categories.svg)

---

**You:** The four topping categories are mutually exclusive. Declare all six pairwise disjointness axioms.

**Assistant:** An ingredient cannot be both a cheese and a meat topping at the same time —
this is a real-world constraint we encode explicitly. With four categories there are six
unique pairs. If the reasoner later finds an individual typed as two disjoint categories,
it will flag an inconsistency.


<details>
<summary>7 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":34,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#CheeseTopping","predicateIri":"http://www.w3.org/2002/07/owl#disjointWith","objectIri":"http://www.pizza-ontology.com/pizza.owl#MeatTopping"}}}`
`{"jsonrpc":"2.0","id":35,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#CheeseTopping","predicateIri":"http://www.w3.org/2002/07/owl#disjointWith","objectIri":"http://www.pizza-ontology.com/pizza.owl#VegetableTopping"}}}`
`{"jsonrpc":"2.0","id":36,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#CheeseTopping","predicateIri":"http://www.w3.org/2002/07/owl#disjointWith","objectIri":"http://www.pizza-ontology.com/pizza.owl#FishTopping"}}}`
`{"jsonrpc":"2.0","id":37,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#MeatTopping","predicateIri":"http://www.w3.org/2002/07/owl#disjointWith","objectIri":"http://www.pizza-ontology.com/pizza.owl#VegetableTopping"}}}`
`{"jsonrpc":"2.0","id":38,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#MeatTopping","predicateIri":"http://www.w3.org/2002/07/owl#disjointWith","objectIri":"http://www.pizza-ontology.com/pizza.owl#FishTopping"}}}`
`{"jsonrpc":"2.0","id":39,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#VegetableTopping","predicateIri":"http://www.w3.org/2002/07/owl#disjointWith","objectIri":"http://www.pizza-ontology.com/pizza.owl#FishTopping"}}}`
`{"jsonrpc":"2.0","id":40,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"elk-layered","spacing":160}}}`

```tool-result
[Ontosphere — 7 tools ✓]
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ runLayout: elk-layered

Canvas: 13 nodes, 20 links
```

</details>

![Six disjointWith axioms guard consistency — Cheese, Meat, Vegetable, Fish cannot overlap](./pizza-tutorial/06-topping-disjoint.svg)

---

**You:** Add the specific leaf toppings under each category.

**Assistant:** Leaf classes are the most specific types in the hierarchy. The reasoner will
later use the subClassOf chain to automatically lift an individual typed as MozzarellaTopping
all the way up to CheeseTopping and then PizzaTopping — no extra assertions needed.


<details>
<summary>17 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":41,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#MozzarellaTopping","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"MozzarellaTopping"}}}`
`{"jsonrpc":"2.0","id":42,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#ParmesanTopping","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"ParmesanTopping"}}}`
`{"jsonrpc":"2.0","id":43,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#PeperoniSausageTopping","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"PeperoniSausageTopping"}}}`
`{"jsonrpc":"2.0","id":44,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#TomatoTopping","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"TomatoTopping"}}}`
`{"jsonrpc":"2.0","id":45,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#OliveTopping","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"OliveTopping"}}}`
`{"jsonrpc":"2.0","id":46,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#GarlicTopping","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"GarlicTopping"}}}`
`{"jsonrpc":"2.0","id":47,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#AnchoviesTopping","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"AnchoviesTopping"}}}`
`{"jsonrpc":"2.0","id":48,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#MozzarellaTopping","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#CheeseTopping"}}}`
`{"jsonrpc":"2.0","id":49,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#ParmesanTopping","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#CheeseTopping"}}}`
`{"jsonrpc":"2.0","id":50,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#PeperoniSausageTopping","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#MeatTopping"}}}`
`{"jsonrpc":"2.0","id":51,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#TomatoTopping","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#VegetableTopping"}}}`
`{"jsonrpc":"2.0","id":52,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#OliveTopping","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#VegetableTopping"}}}`
`{"jsonrpc":"2.0","id":53,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#GarlicTopping","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#VegetableTopping"}}}`
`{"jsonrpc":"2.0","id":54,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#AnchoviesTopping","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#FishTopping"}}}`
`{"jsonrpc":"2.0","id":55,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"elk-layered","spacing":140}}}`
`{"jsonrpc":"2.0","id":56,"method":"tools/call","params":{"name":"expandNode","arguments":{}}}`
`{"jsonrpc":"2.0","id":57,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"elk-layered","spacing":140}}}`

```tool-result
[Ontosphere — 17 tools ✓]
✓ addNode: http://www.pizza-ontology.com/pizza.owl#MozzarellaTopping
✓ addNode: http://www.pizza-ontology.com/pizza.owl#ParmesanTopping
✓ addNode: http://www.pizza-ontology.com/pizza.owl#PeperoniSausageTopping
✓ addNode: http://www.pizza-ontology.com/pizza.owl#TomatoTopping
✓ addNode: http://www.pizza-ontology.com/pizza.owl#OliveTopping
✓ addNode: http://www.pizza-ontology.com/pizza.owl#GarlicTopping
✓ addNode: http://www.pizza-ontology.com/pizza.owl#AnchoviesTopping
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ runLayout: elk-layered
✓ expandNode
✓ runLayout: elk-layered

Canvas: 20 nodes, 27 links
```

</details>

![Leaf toppings — the most specific types. Reasoner will climb the chain: MozzarellaTopping → CheeseTopping → PizzaTopping](./pizza-tutorial/07-tbox-leaf-toppings.svg)

---

**You:** Add the two object properties — hasTopping and hasBase — with their domain and range.

**Assistant:** Properties are relations between individuals. The domain says what the subject
must be; the range says what the object must be. This is what powers type inference: if
an individual X uses hasTopping, the reasoner deduces X is a Pizza even without an
explicit type assertion.


<details>
<summary>7 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":58,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#hasTopping","typeIri":"http://www.w3.org/2002/07/owl#ObjectProperty","label":"hasTopping"}}}`
`{"jsonrpc":"2.0","id":59,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#hasBase","typeIri":"http://www.w3.org/2002/07/owl#ObjectProperty","label":"hasBase"}}}`
`{"jsonrpc":"2.0","id":60,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#hasTopping","predicateIri":"http://www.w3.org/2000/01/rdf-schema#domain","objectIri":"http://www.pizza-ontology.com/pizza.owl#Pizza"}}}`
`{"jsonrpc":"2.0","id":61,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#hasTopping","predicateIri":"http://www.w3.org/2000/01/rdf-schema#range","objectIri":"http://www.pizza-ontology.com/pizza.owl#PizzaTopping"}}}`
`{"jsonrpc":"2.0","id":62,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#hasBase","predicateIri":"http://www.w3.org/2000/01/rdf-schema#domain","objectIri":"http://www.pizza-ontology.com/pizza.owl#Pizza"}}}`
`{"jsonrpc":"2.0","id":63,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#hasBase","predicateIri":"http://www.w3.org/2000/01/rdf-schema#range","objectIri":"http://www.pizza-ontology.com/pizza.owl#PizzaBase"}}}`
`{"jsonrpc":"2.0","id":64,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"elk-layered","spacing":140}}}`

```tool-result
[Ontosphere — 7 tools ✓]
✓ addNode: http://www.pizza-ontology.com/pizza.owl#hasTopping
✓ addNode: http://www.pizza-ontology.com/pizza.owl#hasBase
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ runLayout: elk-layered

Canvas: 22 nodes, 31 links
```

</details>

![hasTopping domain Pizza, range PizzaTopping — using this property is enough for the reasoner to infer the type](./pizza-tutorial/08-properties-domain-range.svg)

---

**You:** Add isToppingOf and isBaseOf as inverse properties, and mark hasBase as functional.

**Assistant:** owl:inverseOf means if pizza1 hasTopping mozz1 is asserted, the reasoner
automatically adds mozz1 isToppingOf pizza1 without any extra triples from us.
owl:FunctionalProperty on hasBase says each pizza has at most one base — a useful constraint
on the real world.


<details>
<summary>12 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":65,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#isToppingOf","typeIri":"http://www.w3.org/2002/07/owl#ObjectProperty","label":"isToppingOf"}}}`
`{"jsonrpc":"2.0","id":66,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#isBaseOf","typeIri":"http://www.w3.org/2002/07/owl#ObjectProperty","label":"isBaseOf"}}}`
`{"jsonrpc":"2.0","id":67,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#isToppingOf","predicateIri":"http://www.w3.org/2002/07/owl#inverseOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#hasTopping"}}}`
`{"jsonrpc":"2.0","id":68,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#isBaseOf","predicateIri":"http://www.w3.org/2002/07/owl#inverseOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#hasBase"}}}`
`{"jsonrpc":"2.0","id":69,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#isToppingOf","predicateIri":"http://www.w3.org/2000/01/rdf-schema#domain","objectIri":"http://www.pizza-ontology.com/pizza.owl#PizzaTopping"}}}`
`{"jsonrpc":"2.0","id":70,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#isToppingOf","predicateIri":"http://www.w3.org/2000/01/rdf-schema#range","objectIri":"http://www.pizza-ontology.com/pizza.owl#Pizza"}}}`
`{"jsonrpc":"2.0","id":71,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#isBaseOf","predicateIri":"http://www.w3.org/2000/01/rdf-schema#domain","objectIri":"http://www.pizza-ontology.com/pizza.owl#PizzaBase"}}}`
`{"jsonrpc":"2.0","id":72,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#isBaseOf","predicateIri":"http://www.w3.org/2000/01/rdf-schema#range","objectIri":"http://www.pizza-ontology.com/pizza.owl#Pizza"}}}`
`{"jsonrpc":"2.0","id":73,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#hasBase","predicateIri":"http://www.w3.org/1999/02/22-rdf-syntax-ns#type","objectIri":"http://www.w3.org/2002/07/owl#FunctionalProperty"}}}`
`{"jsonrpc":"2.0","id":74,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"elk-layered","spacing":140}}}`
`{"jsonrpc":"2.0","id":75,"method":"tools/call","params":{"name":"expandNode","arguments":{}}}`
`{"jsonrpc":"2.0","id":76,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"elk-layered","spacing":140}}}`

```tool-result
[Ontosphere — 12 tools ✓]
✓ addNode: http://www.pizza-ontology.com/pizza.owl#isToppingOf
✓ addNode: http://www.pizza-ontology.com/pizza.owl#isBaseOf
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ runLayout: elk-layered
✓ expandNode
✓ runLayout: elk-layered

Canvas: 24 nodes, 37 links
```

</details>

![owl:inverseOf — asserting pizza hasTopping mozz is enough; the reasoner adds mozz isToppingOf pizza for free](./pizza-tutorial/09-tbox-complete.svg)

---

**You:** Now define equivalentClass axioms so the reasoner can infer which named pizza type each individual belongs to.

**Assistant:** In OWL, a named pizza class can be made *defined* by stating what is necessary and
sufficient to be a member. We use anonymous blank-node `owl:someValuesFrom` restrictions as
characteristic markers — each pizza carries at least one topping that is unique to its type.
Linking the blank-node restriction to the named class with `owl:equivalentClass` turns the
subclass into a *defined* class: any individual that satisfies the restriction is automatically
classified as that pizza, with no extra type assertion needed.

The blank-node pattern is the correct OWL DL encoding:
`owl:equivalentClass [ a owl:Restriction; owl:onProperty P; owl:someValuesFrom C ]`.
Using *named* restriction IRIs instead would cause the OWL-RL `scm-svf1` rule to merge all
restrictions sharing the same property into one equivalence group — collapsing all named pizza
types into a single class. Anonymous blank nodes never enter the class hierarchy by name, so
each restriction stays isolated. We load these axioms with `loadRdf` inline Turtle.

The characteristic toppings we exploit:

- **Margherita** — identified by TomatoTopping (tomato is the hallmark ingredient; unique to pizza1 in this ABox)
- **AmericanHot** — identified by PeperoniSausageTopping (unique to pizza2)
- **FruttiDiMare** — identified by AnchoviesTopping (unique to pizza3)

Note: full OWL-DL definitions use `owl:intersectionOf` combining multiple `someValuesFrom`
restrictions. OWL-RL with n3.js does not support the `e:findall` builtin required for
`cls-int1`, so we use a single characteristic topping per class — sufficient for correct
inference over this ABox.


<details>
<summary>2 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":115,"method":"tools/call","params":{"name":"loadRdf","arguments":{"turtle":"@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n@prefix pizza: <http://www.pizza-ontology.com/pizza.owl#> .\n\npizza:Margherita owl:equivalentClass [\n    rdf:type owl:Restriction ;\n    owl:onProperty pizza:hasTopping ;\n    owl:someValuesFrom pizza:TomatoTopping\n] .\npizza:AmericanHot owl:equivalentClass [\n    rdf:type owl:Restriction ;\n    owl:onProperty pizza:hasTopping ;\n    owl:someValuesFrom pizza:PeperoniSausageTopping\n] .\npizza:FruttiDiMare owl:equivalentClass [\n    rdf:type owl:Restriction ;\n    owl:onProperty pizza:hasTopping ;\n    owl:someValuesFrom pizza:AnchoviesTopping\n] ."}}}`
`{"jsonrpc":"2.0","id":116,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"elk-layered","spacing":140}}}`

```tool-result
[Ontosphere — 2 tools ✓]
✓ loadRdf: loaded
✓ runLayout: elk-layered

Canvas: 24 nodes, 37 links
```

</details>

![owl:equivalentClass + anonymous owl:someValuesFrom restriction — each NamedPizza class is now defined; blank nodes stay isolated so no type collapse occurs](./pizza-tutorial/10-tbox-equiv-class-axioms.svg)

---

**You:** Now define VegetarianPizza — a pizza that has at least one vegetable topping.

**Assistant:** VegetarianPizza is a NamedPizza defined by having some VegetableTopping. The
`cls-svf1` rule will fire whenever an individual has a VegetableTopping via hasTopping —
automatically classifying it as VegetarianPizza without any explicit type assertion.

This also sets up an important lesson about the **Open World Assumption**: because OWL
assumes the world may contain facts we have not yet stated, a pizza without any *asserted*
meat toppings cannot be concluded to be vegetarian. The reasoner infers VegetarianPizza
only from *positive* evidence — the presence of a VegetableTopping — not from the
*absence* of meat. Full closure would require `owl:allValuesFrom` combined with an
intersection, which needs the EYE reasoner's `e:findall` builtin (not available in OWL-RL
via n3.js). As a result, FruttiDiMare — which has a GarlicTopping — will *also* be
inferred as VegetarianPizza, which is semantically wrong but demonstrates exactly why
closure axioms exist.


<details>
<summary>4 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":128,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#VegetarianPizza","typeIri":"http://www.w3.org/2002/07/owl#Class","label":"VegetarianPizza"}}}`
`{"jsonrpc":"2.0","id":129,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#VegetarianPizza","predicateIri":"http://www.w3.org/2000/01/rdf-schema#subClassOf","objectIri":"http://www.pizza-ontology.com/pizza.owl#NamedPizza"}}}`
`{"jsonrpc":"2.0","id":130,"method":"tools/call","params":{"name":"loadRdf","arguments":{"turtle":"@prefix owl: <http://www.w3.org/2002/07/owl#> .\n@prefix rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .\n@prefix pizza: <http://www.pizza-ontology.com/pizza.owl#> .\n\npizza:VegetarianPizza owl:equivalentClass [\n    rdf:type owl:Restriction ;\n    owl:onProperty pizza:hasTopping ;\n    owl:someValuesFrom pizza:VegetableTopping\n] ."}}}`
`{"jsonrpc":"2.0","id":131,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"elk-layered","spacing":140}}}`

```tool-result
[Ontosphere — 4 tools ✓]
✓ addNode: http://www.pizza-ontology.com/pizza.owl#VegetarianPizza
✓ addTriple
✓ loadRdf: loaded
✓ runLayout: elk-layered

Canvas: 25 nodes, 38 links
```

</details>

![VegetarianPizza ≡ ∃hasTopping.VegetableTopping — a defined class that will expose the Open World Assumption after reasoning](./pizza-tutorial/11-tbox-vegetarian-pizza.svg)

---

**You:** The TBox is complete. Switch to ABox and add three untyped pizza individuals.

**Assistant:** The ABox is the instance data — real individuals, not classes.
We intentionally give the three pizzas no type. Their Pizza type will be inferred
by the reasoner from the domain of hasTopping and hasBase. This is the key lesson:
you don't have to state the obvious if the schema already says it.


<details>
<summary>5 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":77,"method":"tools/call","params":{"name":"setViewMode","arguments":{"mode":"abox"}}}`
`{"jsonrpc":"2.0","id":78,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#pizza1","label":"pizza1"}}}`
`{"jsonrpc":"2.0","id":79,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#pizza2","label":"pizza2"}}}`
`{"jsonrpc":"2.0","id":80,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#pizza3","label":"pizza3"}}}`
`{"jsonrpc":"2.0","id":81,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"dagre-lr","spacing":200}}}`

```tool-result
[Ontosphere — 5 tools ✓]
✓ setViewMode
✓ addNode: http://www.pizza-ontology.com/pizza.owl#pizza1
✓ addNode: http://www.pizza-ontology.com/pizza.owl#pizza2
✓ addNode: http://www.pizza-ontology.com/pizza.owl#pizza3
✓ runLayout: dagre-lr

Canvas: 7 nodes, 0 links
```

</details>

![Three untyped individuals — no explicit Pizza type yet. The reasoner will derive it from the property domain.](./pizza-tutorial/12-abox-untyped-pizzas.svg)

---

**You:** Build pizza1 — a Margherita pizza. Add its toppings and base.

**Assistant:** Margherita is defined by exactly two ingredients: Mozzarella and Tomato.
No garlic, no peperoni — the recipe and the ontology agree. Each individual is typed at
the most specific leaf class; the subClassOf chain propagates membership upward automatically.


<details>
<summary>8 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":82,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#mozz1","typeIri":"http://www.pizza-ontology.com/pizza.owl#MozzarellaTopping","label":"mozz"}}}`
`{"jsonrpc":"2.0","id":83,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#tom1","typeIri":"http://www.pizza-ontology.com/pizza.owl#TomatoTopping","label":"tomato"}}}`
`{"jsonrpc":"2.0","id":84,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#thin1","typeIri":"http://www.pizza-ontology.com/pizza.owl#ThinAndCrispyBase","label":"thin & crispy"}}}`
`{"jsonrpc":"2.0","id":85,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#pizza1","predicateIri":"http://www.pizza-ontology.com/pizza.owl#hasTopping","objectIri":"http://www.pizza-ontology.com/pizza.owl#mozz1"}}}`
`{"jsonrpc":"2.0","id":86,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#pizza1","predicateIri":"http://www.pizza-ontology.com/pizza.owl#hasTopping","objectIri":"http://www.pizza-ontology.com/pizza.owl#tom1"}}}`
`{"jsonrpc":"2.0","id":87,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#pizza1","predicateIri":"http://www.pizza-ontology.com/pizza.owl#hasBase","objectIri":"http://www.pizza-ontology.com/pizza.owl#thin1"}}}`
`{"jsonrpc":"2.0","id":88,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"dagre-lr","spacing":180}}}`
`{"jsonrpc":"2.0","id":200,"method":"tools/call","params":{"name":"focusNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#pizza1"}}}`

```tool-result
[Ontosphere — 8 tools ✓]
✓ addNode: http://www.pizza-ontology.com/pizza.owl#mozz1
✓ addNode: http://www.pizza-ontology.com/pizza.owl#tom1
✓ addNode: http://www.pizza-ontology.com/pizza.owl#thin1
✓ addTriple
✓ addTriple
✓ addTriple
✓ runLayout: dagre-lr
✓ focusNode

Canvas: 10 nodes, 3 links
```

</details>

![pizza1 (Margherita) — Mozzarella + Tomato, no type asserted yet; TomatoTopping will be the characteristic that triggers classification](./pizza-tutorial/13-pizza1-built.svg)

---

**You:** Now pizza2 — an AmericanHot-style pizza with peperoni, mozzarella, olive, and a deep pan base.

**Assistant:** Pizza2 has a meat topping alongside a cheese topping. The disjointWith axioms
we set on the categories don't fire here — Mozzarella is Cheese and Peperoni is Meat,
so no conflict.


<details>
<summary>10 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":91,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#pep1","typeIri":"http://www.pizza-ontology.com/pizza.owl#PeperoniSausageTopping","label":"peperoni"}}}`
`{"jsonrpc":"2.0","id":92,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#mozz2","typeIri":"http://www.pizza-ontology.com/pizza.owl#MozzarellaTopping","label":"mozz"}}}`
`{"jsonrpc":"2.0","id":93,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#olive1","typeIri":"http://www.pizza-ontology.com/pizza.owl#OliveTopping","label":"olive"}}}`
`{"jsonrpc":"2.0","id":94,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#deep1","typeIri":"http://www.pizza-ontology.com/pizza.owl#DeepPanBase","label":"deep pan"}}}`
`{"jsonrpc":"2.0","id":95,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#pizza2","predicateIri":"http://www.pizza-ontology.com/pizza.owl#hasTopping","objectIri":"http://www.pizza-ontology.com/pizza.owl#pep1"}}}`
`{"jsonrpc":"2.0","id":96,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#pizza2","predicateIri":"http://www.pizza-ontology.com/pizza.owl#hasTopping","objectIri":"http://www.pizza-ontology.com/pizza.owl#mozz2"}}}`
`{"jsonrpc":"2.0","id":97,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#pizza2","predicateIri":"http://www.pizza-ontology.com/pizza.owl#hasTopping","objectIri":"http://www.pizza-ontology.com/pizza.owl#olive1"}}}`
`{"jsonrpc":"2.0","id":98,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#pizza2","predicateIri":"http://www.pizza-ontology.com/pizza.owl#hasBase","objectIri":"http://www.pizza-ontology.com/pizza.owl#deep1"}}}`
`{"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"dagre-lr","spacing":180}}}`
`{"jsonrpc":"2.0","id":201,"method":"tools/call","params":{"name":"focusNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#pizza2"}}}`

```tool-result
[Ontosphere — 10 tools ✓]
✓ addNode: http://www.pizza-ontology.com/pizza.owl#pep1
✓ addNode: http://www.pizza-ontology.com/pizza.owl#mozz2
✓ addNode: http://www.pizza-ontology.com/pizza.owl#olive1
✓ addNode: http://www.pizza-ontology.com/pizza.owl#deep1
✓ addTriple
✓ addTriple
✓ addTriple
✓ addTriple
✓ runLayout: dagre-lr
✓ focusNode

Canvas: 14 nodes, 7 links
```

</details>

![pizza2 (AmericanHot-style) — Meat and Cheese toppings are disjoint categories but can co-exist on one pizza](./pizza-tutorial/14-pizza2-built.svg)

---

**You:** And pizza3 — a FruttiDiMare with anchovies, garlic, and a thin base.

**Assistant:** The official Manchester tutorial defines FruttiDiMare with GarlicTopping as one
of its ingredients — garlic is the correct accompaniment to seafood here, not a Margherita
ingredient. Anchovies are unique to this pizza in our ABox, making them the characteristic
topping the reasoner will use for classification.


<details>
<summary>8 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":100,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#anch1","typeIri":"http://www.pizza-ontology.com/pizza.owl#AnchoviesTopping","label":"anchovies"}}}`
`{"jsonrpc":"2.0","id":101,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#garlic1","typeIri":"http://www.pizza-ontology.com/pizza.owl#GarlicTopping","label":"garlic"}}}`
`{"jsonrpc":"2.0","id":102,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#thin2","typeIri":"http://www.pizza-ontology.com/pizza.owl#ThinAndCrispyBase","label":"thin & crispy"}}}`
`{"jsonrpc":"2.0","id":103,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#pizza3","predicateIri":"http://www.pizza-ontology.com/pizza.owl#hasTopping","objectIri":"http://www.pizza-ontology.com/pizza.owl#anch1"}}}`
`{"jsonrpc":"2.0","id":104,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#pizza3","predicateIri":"http://www.pizza-ontology.com/pizza.owl#hasTopping","objectIri":"http://www.pizza-ontology.com/pizza.owl#garlic1"}}}`
`{"jsonrpc":"2.0","id":105,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#pizza3","predicateIri":"http://www.pizza-ontology.com/pizza.owl#hasBase","objectIri":"http://www.pizza-ontology.com/pizza.owl#thin2"}}}`
`{"jsonrpc":"2.0","id":106,"method":"tools/call","params":{"name":"expandNode","arguments":{}}}`
`{"jsonrpc":"2.0","id":107,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"dagre-lr","spacing":180}}}`

```tool-result
[Ontosphere — 8 tools ✓]
✓ addNode: http://www.pizza-ontology.com/pizza.owl#anch1
✓ addNode: http://www.pizza-ontology.com/pizza.owl#garlic1
✓ addNode: http://www.pizza-ontology.com/pizza.owl#thin2
✓ addTriple
✓ addTriple
✓ addTriple
✓ expandNode
✓ runLayout: dagre-lr

Canvas: 17 nodes, 10 links
```

</details>

![ABox — three untyped pizzas with correct ingredients: Margherita (mozz+tomato), AmericanHot (peperoni+mozz+olive), FruttiDiMare (anchovies+garlic)](./pizza-tutorial/15-abox-before-reasoning.svg)

---

**You:** Add a fourth pizza — purely vegetable toppings, no type asserted. We'll use this to demonstrate the Open World Assumption.

**Assistant:** pizza4 has only an OliveTopping and a TomatoTopping — both VegetableToppings.
We give it no type at all. After reasoning, the VegetarianPizza equivalentClass axiom will
fire and classify it — but we also need to observe what the reasoner says about pizza3
(FruttiDiMare), which has a garlic (VegetableTopping) alongside its anchovies.


<details>
<summary>10 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":135,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#pizza4","label":"pizza4"}}}`
`{"jsonrpc":"2.0","id":136,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#olive2","typeIri":"http://www.pizza-ontology.com/pizza.owl#OliveTopping","label":"olive"}}}`
`{"jsonrpc":"2.0","id":137,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#tom2","typeIri":"http://www.pizza-ontology.com/pizza.owl#TomatoTopping","label":"tomato"}}}`
`{"jsonrpc":"2.0","id":138,"method":"tools/call","params":{"name":"addNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#thin3","typeIri":"http://www.pizza-ontology.com/pizza.owl#ThinAndCrispyBase","label":"thin & crispy"}}}`
`{"jsonrpc":"2.0","id":139,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#pizza4","predicateIri":"http://www.pizza-ontology.com/pizza.owl#hasTopping","objectIri":"http://www.pizza-ontology.com/pizza.owl#olive2"}}}`
`{"jsonrpc":"2.0","id":140,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#pizza4","predicateIri":"http://www.pizza-ontology.com/pizza.owl#hasTopping","objectIri":"http://www.pizza-ontology.com/pizza.owl#tom2"}}}`
`{"jsonrpc":"2.0","id":141,"method":"tools/call","params":{"name":"addTriple","arguments":{"subjectIri":"http://www.pizza-ontology.com/pizza.owl#pizza4","predicateIri":"http://www.pizza-ontology.com/pizza.owl#hasBase","objectIri":"http://www.pizza-ontology.com/pizza.owl#thin3"}}}`
`{"jsonrpc":"2.0","id":142,"method":"tools/call","params":{"name":"expandNode","arguments":{}}}`
`{"jsonrpc":"2.0","id":143,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"dagre-lr","spacing":180}}}`
`{"jsonrpc":"2.0","id":202,"method":"tools/call","params":{"name":"focusNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#pizza4"}}}`

```tool-result
[Ontosphere — 10 tools ✓]
✓ addNode: http://www.pizza-ontology.com/pizza.owl#pizza4
✓ addNode: http://www.pizza-ontology.com/pizza.owl#olive2
✓ addNode: http://www.pizza-ontology.com/pizza.owl#tom2
✓ addNode: http://www.pizza-ontology.com/pizza.owl#thin3
✓ addTriple
✓ addTriple
✓ addTriple
✓ expandNode
✓ runLayout: dagre-lr
✓ focusNode

Canvas: 21 nodes, 13 links
```

</details>

![pizza4 — olive + tomato, no type; set up to expose what OWL-RL can and cannot infer about vegetarian status](./pizza-tutorial/16-pizza4-built.svg)

---

**You:** Run the OWL-RL reasoner. What can it derive from the axioms we set?

**Assistant:** OWL-RL applies forward-chaining rules over the graph. Here is what each rule
fires on our data:

- **rdfs2 (domain):** pizza1/2/3 used hasTopping → their type is inferred as Pizza
- **rdfs3 (range):** toppings used as hasTopping objects → inferred as PizzaTopping
- **rdfs9 / cax-sco (subClassOf propagation):** mozz1 is MozzarellaTopping → also CheeseTopping → also PizzaTopping; anch1 is AnchoviesTopping → FishTopping → PizzaTopping; etc.
- **prp-inv (inverseOf):** every hasTopping edge generates an isToppingOf edge back; every hasBase edge generates an isBaseOf edge back
- **cls-svf1 (someValuesFrom):** pizza1 hasTopping tom1 and tom1 is TomatoTopping → pizza1 is `_:b` (the anonymous Margherita restriction); pizza2 has PeperoniSausageTopping → `_:b` (AmericanHot restriction); pizza3 has AnchoviesTopping → `_:b` (FruttiDiMare restriction)
- **scm-eqc1 + cax-sco (equivalentClass → subClassOf):** Margherita≡`_:b` → `_:b` rdfs:subClassOf Margherita → pizza1 a **Margherita**; same for pizza2 → **AmericanHot**; pizza3 → **FruttiDiMare**
- **cax-sco again:** Margherita ⊆ NamedPizza ⊆ Pizza → pizza1 also gets NamedPizza (Pizza already inferred by rdfs2)
- **scm-svf1 + VegetarianPizza:** TomatoTopping ⊆ VegetableTopping → Margherita restriction ⊆ VegetarianPizza restriction (scm-svf1); pizza1 a Margherita restriction → pizza1 a VegetarianPizza restriction → pizza1 is **VegetarianPizza** (cax-sco); pizza4 likewise; pizza3 (FruttiDiMare) also has garlic (VegetableTopping) — see OWA note below


<details>
<summary>3 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":108,"method":"tools/call","params":{"name":"runReasoning","arguments":{}}}`
`{"jsonrpc":"2.0","id":109,"method":"tools/call","params":{"name":"expandNode","arguments":{}}}`
`{"jsonrpc":"2.0","id":110,"method":"tools/call","params":{"name":"runLayout","arguments":{"algorithm":"dagre-lr","spacing":180}}}`

```tool-result
[Ontosphere — 3 tools ✓]
✓ runReasoning: 10798 triples inferred
✓ expandNode
✓ runLayout: dagre-lr

Canvas: 21 nodes, 43 links
```

</details>

![OWL-RL reasoning complete — Pizza types inferred, subClassOf chains climbed, all inverse edges materialised](./pizza-tutorial/17-after-reasoning.svg)

---

**You:** Focus on pizza1 and show what the reasoner gave it.

**Assistant:** Panning to pizza1 and expanding its card. The annotation panel will show
the inferred rdf:type assertions — Pizza (domain axiom), an anonymous blank-node restriction
`_:b` (cls-svf1 fires because tom1 is TomatoTopping), **Margherita** (scm-eqc1 makes `_:b`
a subClassOf Margherita → cax-sco lifts pizza1), and **VegetarianPizza** (scm-svf1 derives
Margherita restriction ⊆ VegetarianPizza restriction because TomatoTopping ⊆ VegetableTopping,
then cax-sco propagates). Not one of these types was explicitly stated in the ABox.


<details>
<summary>2 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":111,"method":"tools/call","params":{"name":"focusNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#pizza1"}}}`
`{"jsonrpc":"2.0","id":112,"method":"tools/call","params":{"name":"expandNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#pizza1","expand":true}}}`

```tool-result
[Ontosphere — 2 tools ✓]
✓ focusNode
✓ expandNode

Canvas: 21 nodes, 43 links
```

</details>

![pizza1 inferred as Margherita AND VegetarianPizza — tomato fires cls-svf1 for both characterisations; cax-eqc2 lifts each to its named class](./pizza-tutorial/18-pizza1-inferred.svg)

---

**You:** Show mozz1 — does it know its full superclass chain?

**Assistant:** Focusing on mozz1 to confirm the three-level type propagation:
MozzarellaTopping (asserted) → CheeseTopping (rdfs9) → PizzaTopping (rdfs9).
Each step was derived automatically from the subClassOf chain in the TBox.


<details>
<summary>2 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":113,"method":"tools/call","params":{"name":"focusNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#mozz1"}}}`
`{"jsonrpc":"2.0","id":114,"method":"tools/call","params":{"name":"expandNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#mozz1","expand":true}}}`

```tool-result
[Ontosphere — 2 tools ✓]
✓ focusNode
✓ expandNode

Canvas: 21 nodes, 43 links
```

</details>

![mozz1 — one asserted type, two inferred: MozzarellaTopping → CheeseTopping → PizzaTopping via subClassOf chain](./pizza-tutorial/19-mozz1-inferred.svg)

---

**You:** Focus on pizza4. Did the reasoner classify it as VegetarianPizza? And what about pizza3?

**Assistant:** Focusing on pizza4 first. It has OliveTopping and TomatoTopping — both
VegetableToppings. The reasoner fired `cls-svf1` on each: pizza4 satisfies
VegetarianPizzaCharacterisation, so `cax-eqc2` classifies it as VegetarianPizza. ✓

Now the important part: focus on pizza3 (FruttiDiMare). It has GarlicTopping, which is a
VegetableTopping. So pizza3 is *also* inferred as VegetarianPizza — even though it carries
AnchoviesTopping (a FishTopping), which makes it clearly non-vegetarian in the real world.

This is the **Open World Assumption** in action. The reasoner does not reason by absence:
it cannot conclude "pizza3 has no meat toppings, therefore it is vegetarian" correctly,
because under OWA there might be unstated toppings. But it *can* (and does) infer
VegetarianPizza positively from the garlic. To block this, a correct definition needs an
`owl:allValuesFrom` closure restricting toppings to non-meat classes — combined with
`owl:intersectionOf`. OWL-RL with n3.js does not support `cls-int1` (requires the EYE
reasoner's `e:findall`), so fixing this classification requires either a full OWL-DL
reasoner or a SHACL constraint.


<details>
<summary>2 tool calls ✓</summary>

`{"jsonrpc":"2.0","id":144,"method":"tools/call","params":{"name":"focusNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#pizza4"}}}`
`{"jsonrpc":"2.0","id":145,"method":"tools/call","params":{"name":"expandNode","arguments":{"iri":"http://www.pizza-ontology.com/pizza.owl#pizza4","expand":true}}}`

```tool-result
[Ontosphere — 2 tools ✓]
✓ focusNode
✓ expandNode

Canvas: 21 nodes, 43 links
```

</details>

![pizza4 correctly classified as VegetarianPizza; pizza3 (FruttiDiMare) also gets VegetarianPizza — the Open World Assumption at work](./pizza-tutorial/20-owa-vegetarian-lesson.svg)
