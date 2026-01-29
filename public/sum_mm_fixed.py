from rdflib import Graph, Namespace, URIRef, BNode, Literal
from rdflib.namespace import RDF, XSD
import hashlib

# Standard vocabularies
PROV = Namespace("http://www.w3.org/ns/prov#")
QUDT = Namespace("http://qudt.org/schema/qudt/")
UNIT = Namespace("http://qudt.org/vocab/unit/")
OA   = Namespace("http://www.w3.org/ns/oa#")

# Domain vocabulary
EX   = Namespace("https://github.com/ThHanke/PyodideSemanticWorkflow/")
BFO  = Namespace("https://example.org/bfo/")


def create_execution_hash(activity_iri: str, *input_iris: str) -> str:
    """
    Create a deterministic hash from activity IRI and input IRIs.
    
    This hash is shared by ALL results from the same execution, making it easy
    to identify which resources belong to the same activity run.
    
    Args:
        activity_iri: IRI of the activity being executed
        *input_iris: IRIs of all inputs to the activity
        
    Returns:
        16-character hex hash string
    """
    # Sort inputs for order-independent hashing
    sorted_inputs = sorted(str(iri) for iri in input_iris)
    
    # Combine activity IRI with all input IRIs
    combined = str(activity_iri) + ''.join(sorted_inputs)
    
    # Create SHA256 hash and truncate to 16 characters for readability
    return hashlib.sha256(combined.encode('utf-8')).hexdigest()[:16]


def create_deterministic_iri(prefix: str, execution_hash: str) -> URIRef:
    """
    Create a deterministic IRI using a prefix and shared execution hash.
    
    The prefix (spelling part) makes IRIs unique within an execution.
    The hash (shared part) groups all results from the same execution.
    
    Args:
        prefix: Meaningful prefix for the IRI (e.g., "sumResult", "errorAnn")
        execution_hash: Shared hash from create_execution_hash()
        
    Returns:
        URIRef with format: #{prefix}_{hash}
    """
    return URIRef(f"#{prefix}_{execution_hash}")


def cleanup_previous_result(g: Graph, result_iri: URIRef) -> int:
    """
    Remove all triples related to a previous result entity from the graph.
    
    This prevents base URI pollution when re-running an activity by ensuring
    the old result entity is completely removed before creating a new one.
    
    Args:
        g: The RDF graph to clean
        result_iri: The IRI of the result entity to remove
        
    Returns:
        Number of triples removed
    """
    triples_to_remove = []
    
    # Find all triples where result_iri is the subject
    for s, p, o in g.triples((result_iri, None, None)):
        triples_to_remove.append((s, p, o))
    
    # Find all triples where result_iri is the object
    for s, p, o in g.triples((None, None, result_iri)):
        triples_to_remove.append((s, p, o))
    
    # Remove all found triples
    for triple in triples_to_remove:
        g.remove(triple)
    
    return len(triples_to_remove)


def _add_error(g: Graph, activity, message: str, code: str = None, execution_hash: str = "unknown") -> None:
    """Add an error as a Web Annotation with deterministic IRI."""
    # Use shared execution hash - prefix makes it unique
    ann_iri = create_deterministic_iri("errorAnn", execution_hash)
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

    # Create execution hash ONCE - shared by all IRIs from this execution
    execution_hash = create_execution_hash(activity_iri, *[str(qv) for qv in inputs])

    if len(inputs) < 2:
        _add_error(
            g,
            activity=activity,
            message=f"Expected at least two qudt:QuantityValue inputs linked via bfo:is_input_of. Found {len(inputs)}",
            code="INPUT_TOO_FEW",
            execution_hash=execution_hash
        )
        return g.serialize(format="turtle")

    # Read numeric values
    values = []
    units = set()

    for qv in inputs:
        num = g.value(qv, QUDT.numericValue)
        unit = g.value(qv, QUDT.unit)

        if num is None:
            _add_error(g, activity, f"Input {qv} has no qudt:numericValue", "MISSING_NUMERIC_VALUE", execution_hash=execution_hash)
            return g.serialize(format="turtle")

        try:
            values.append(float(num))
        except Exception:
            _add_error(g, activity, f"Input {qv} has non-numeric value {num}", "NON_NUMERIC_VALUE", execution_hash=execution_hash)
            return g.serialize(format="turtle")

        if unit is not None:
            units.add(unit)

    if len(units) > 1:
        _add_error(
            g,
            activity,
            "Inputs have different units: " + ", ".join(str(u) for u in units),
            code="UNIT_MISMATCH",
            execution_hash=execution_hash
        )
        return g.serialize(format="turtle")

    unit_iri = next(iter(units)) if units else UNIT.MilliM

    # Compute sum
    total = sum(values)

    # Create result IRI using shared execution hash
    # The prefix "sumResult" makes it unique, hash groups it with other results from same execution
    result_qv = create_deterministic_iri("sumResult", execution_hash)
    
    # CRITICAL: Clean up any previous result with this IRI from the graph
    # This prevents base URI pollution when re-running the activity
    removed_count = cleanup_previous_result(g, result_qv)
    if removed_count > 0:
        print(f"[INFO] Removed {removed_count} triples from previous result {result_qv}")
    
    # Now add the fresh result
    g.add((result_qv, RDF.type, QUDT.QuantityValue))
    g.add((result_qv, QUDT.numericValue, Literal(total, datatype=XSD.decimal)))
    g.add((result_qv, QUDT.unit, unit_iri))
    g.add((result_qv, PROV.wasGeneratedBy, activity))

    for qv in inputs:
        g.add((result_qv, PROV.wasDerivedFrom, qv))

    # Serialize and return
    result = g.serialize(format="turtle")
    return result
