from rdflib import Graph, Namespace, URIRef, BNode, Literal
from rdflib.namespace import RDF, XSD
import uuid

# Standard vocabularies
PROV = Namespace("http://www.w3.org/ns/prov#")
QUDT = Namespace("http://qudt.org/schema/qudt/")
UNIT = Namespace("http://qudt.org/vocab/unit/")
OA   = Namespace("http://www.w3.org/ns/oa#")

# Domain vocabulary
EX   = Namespace("https://github.com/ThHanke/PyodideSemanticWorkflow/")
BFO  = Namespace("https://example.org/bfo/")


def _add_error(g: Graph, activity, message: str, code: str = None) -> None:
    """Add an error as a Web Annotation."""
    ann_iri = URIRef(f"#errorAnn_{uuid.uuid4().hex}")
    body = BNode()

    g.bind("prov", PROV)
    g.bind("oa", OA)
    g.bind("ex", EX)

    g.add((ann_iri, RDF.type, OA.Annotation))
    g.add((ann_iri, OA.motivatedBy, EX.errorReporting))
    g.add((ann_iri, OA.hasBody, body))

    if activity is not None:
        g.add((ann_iri, OA.hasTarget, activity))
        g.add((ann_iri, PROV.wasGeneratedBy, activity))

    g.add((body, RDF.type, OA.TextualBody))
    g.add((body, RDF.value, Literal(message, datatype=XSD.string)))

    if code is not None:
        g.add((body, EX.errorCode, Literal(code, datatype=XSD.string)))


def run(input_turtle: str, activity_iri: str) -> str:
    """
    Main entry point called by Pyodide runtime.
    
    Args:
        input_turtle: Input graph in Turtle format
        activity_iri: IRI of the prov:Activity being executed
        
    Returns:
        Output graph in Turtle format
    """
    g = Graph()

    # Parse input graph
    try:
        g.parse(data=input_turtle, format="turtle")
    except Exception as e:
        g = Graph()
        g.bind("prov", PROV)
        g.bind("oa", OA)
        g.bind("ex", EX)
        _add_error(
            g,
            activity=None,
            message=f"Failed to parse input graph: {e}",
            code="PARSE_ERROR"
        )
        return g.serialize(format="turtle")

    # Bind prefixes
    g.bind("prov", PROV)
    g.bind("qudt", QUDT)
    g.bind("unit", UNIT)
    g.bind("bfo", BFO)
    g.bind("oa", OA)
    g.bind("ex", EX)

    # Use the provided activity_iri
    activity = URIRef(activity_iri)
    
    # DON'T add activity to output graph - it already exists in the main graph
    # Adding it here would cause the node to be recreated and lose its edges

    # Find inputs using bfo:is_input_of
    inputs = [
        qv for qv in g.subjects(BFO.is_input_of, activity)
        if (qv, RDF.type, QUDT.QuantityValue) in g
    ]

    if len(inputs) < 2:
        _add_error(
            g,
            activity=activity,
            message=f"Expected at least two qudt:QuantityValue inputs linked via bfo:is_input_of. Found {len(inputs)}",
            code="INPUT_TOO_FEW"
        )
        return g.serialize(format="turtle")

    # Read numeric values
    values = []
    units = set()

    for qv in inputs:
        num = g.value(qv, QUDT.numericValue)
        unit = g.value(qv, QUDT.unit)

        if num is None:
            _add_error(g, activity, f"Input {qv} has no qudt:numericValue", "MISSING_NUMERIC_VALUE")
            return g.serialize(format="turtle")

        try:
            values.append(float(num))
        except Exception:
            _add_error(g, activity, f"Input {qv} has non-numeric value {num}", "NON_NUMERIC_VALUE")
            return g.serialize(format="turtle")

        if unit is not None:
            units.add(unit)

    if len(units) > 1:
        _add_error(
            g,
            activity,
            "Inputs have different units: " + ", ".join(str(u) for u in units),
            code="UNIT_MISMATCH"
        )
        return g.serialize(format="turtle")

    unit_iri = next(iter(units)) if units else UNIT.MilliM

    # Compute sum
    total = sum(values)

    # Create result
    result_qv = URIRef(f"#sumResult_{uuid.uuid4().hex}")
    g.add((result_qv, RDF.type, QUDT.QuantityValue))
    g.add((result_qv, QUDT.numericValue, Literal(total, datatype=XSD.decimal)))
    g.add((result_qv, QUDT.unit, unit_iri))
    g.add((result_qv, PROV.wasGeneratedBy, activity))

    for qv in inputs:
        g.add((result_qv, PROV.wasDerivedFrom, qv))

    # Serialize and return
    result = g.serialize(format="turtle")
    return result
