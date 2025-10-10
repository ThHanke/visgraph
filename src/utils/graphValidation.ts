/**
 * Lightweight graph validation helper used by tests.
 *
 * Validations performed:
 * - Node class existence: verifies that a node's declared class (namespace:classType or classType)
 *   can be found in availableClasses (by namespace+label, iri, or local name).
 * - Edge domain/range: when availableProperties contains a matching property (by iri or key),
 *   checks that the property's domain includes the source node class and the property's range
 *   includes the target node class. If domain/range are empty, it's considered permissive.
 *
 * This function is intentionally conservative and defensive: it returns an array of
 * { nodeId, message, severity } objects. It does not throw.
 */

type ValidationError = {
  nodeId: string;
  message: string;
  severity: "error" | "warning";
};

export function validateGraph(
  nodes: Array<any> = [],
  edges: Array<any> = [],
  options?: {
    availableClasses?: Array<any>;
    availableProperties?: Array<any>;
  }
): ValidationError[] {
  const errors: ValidationError[] = [];
  {
    const classes = Array.isArray(options?.availableClasses) ? options!.availableClasses : [];
    const props = Array.isArray(options?.availableProperties) ? options!.availableProperties : [];

    // Build helper sets for fast lookups.
    const classByIri = new Map<string, any>();
    const classByNsLabel = new Map<string, any>();
    const classLocalNames = new Set<string>();

    try {
      for (const c of classes) {
        try {
          const iri = (c && (c.iri || c.id)) ? String(c.iri || c.id) : "";
          const label = (c && (c.label || c.name)) ? String(c.label || c.name) : "";
          const ns = (c && c.namespace) ? String(c.namespace) : "";
          if (iri) classByIri.set(iri, c);
          if (label && ns) classByNsLabel.set(`${ns}:${label}`, c);
          if (label) classLocalNames.add(label);
          // also add last path segment of IRI
          try {
            const idx = Math.max(iri.lastIndexOf("/"), iri.lastIndexOf("#"));
            if (idx > -1) classLocalNames.add(iri.substring(idx + 1));
          } catch (_) { void 0; }
        } catch (_) { /* ignore per-class */ }
      }
    } catch (_) { /* ignore build errors */ }

    // Helper to determine whether a node's declared class exists
    const hasClass = (node: any) => {
      try {
        const dt = node && node.data ? node.data : node;
        const ns = dt && dt.namespace ? String(dt.namespace) : "";
        const ct = dt && dt.classType ? String(dt.classType) : "";
        const rdfTypes = Array.isArray(dt.rdfTypes) ? dt.rdfTypes : [];
        // 1) check ns:classType
        if (ns && ct && classByNsLabel.has(`${ns}:${ct}`)) return true;
        // 2) check any rdfType iri matches known class iri
        for (const t of rdfTypes) {
          try {
            if (!t) continue;
            if (classByIri.has(String(t))) return true;
            // also check local name
            const tt = String(t);
            const idx = Math.max(tt.lastIndexOf("/"), tt.lastIndexOf("#"));
            if (idx > -1 && classLocalNames.has(tt.substring(idx + 1))) return true;
          } catch (_) { void 0; }
        }
        // 3) check by local name
        if (ct && classLocalNames.has(ct)) return true;
        return false;
      } catch (_) {
        return false;
      }
    };

    // Validate nodes
    for (const n of nodes || []) {
      try {
        const id = String(n && (n.id || n.key) ? (n.id || n.key) : "");
        if (!id) continue;
        if (!hasClass(n)) {
          errors.push({
            nodeId: id,
            message: `${(n && n.data && n.data.classType) || "UnknownClass"} not found for node ${id}`,
            severity: "error",
          });
        }
      } catch (_) { /* ignore per-node */ }
    }

    // Build quick property lookup
    const propByIri = new Map<string, any>();
    try {
      for (const p of props) {
        try {
          const iri = String(p && (p.iri || p.key || p.propertyUri) ? (p.iri || p.key || p.propertyUri) : "");
          if (iri) propByIri.set(iri, p);
        } catch (_) { void 0; }
      }
    } catch (_) { void 0; }

    // Helper to normalize class id for comparison similar to hasClass logic
    const nodePrimaryClass = (node: any) => {
      try {
        const dt = node && node.data ? node.data : node;
        const ns = dt && dt.namespace ? String(dt.namespace) : "";
        const ct = dt && dt.classType ? String(dt.classType) : "";
        if (ns && ct) return `${ns}:${ct}`;
        if (ct) return ct;
        // fallback to first rdfType local name
        const rdfTypes = Array.isArray(dt.rdfTypes) ? dt.rdfTypes : [];
        if (rdfTypes.length > 0) {
          try {
            const t = String(rdfTypes[0]);
            const idx = Math.max(t.lastIndexOf("/"), t.lastIndexOf("#"));
            return idx > -1 ? t.substring(idx + 1) : t;
          } catch (_) { void 0; }
        }
        return "";
      } catch (_) { return ""; }
    };

    // Validate edges domain/range when property metadata is available
    for (const e of edges || []) {
      try {
        const id = String(e && (e.id || e.key) ? (e.id || e.key) : "");
        const propRaw = e && e.data ? (e.data.propertyType || e.data.propertyUri || e.data.property || "") : "";
        const prop = String(propRaw || "");
        if (!prop) continue;
        const pmeta = propByIri.get(prop) || propByIri.get(String(prop));
        if (!pmeta) continue; // no metadata -> cannot validate
        // domain/range may be arrays of prefixed names or IRIs
        const domain = Array.isArray(pmeta.domain) ? pmeta.domain.map(String) : [];
        const range = Array.isArray(pmeta.range) ? pmeta.range.map(String) : [];
        // find source/target node classes
        const srcId = String(e.source || e.from || "");
        const tgtId = String(e.target || e.to || "");
        const srcNode = (nodes || []).find((n: any) => String(n.id) === srcId || String(n.key) === srcId);
        const tgtNode = (nodes || []).find((n: any) => String(n.id) === tgtId || String(n.key) === tgtId);
        const srcClass = srcNode ? nodePrimaryClass(srcNode) : "";
        const tgtClass = tgtNode ? nodePrimaryClass(tgtNode) : "";
        // If domain is non-empty, ensure srcClass matches at least one domain entry
        if (domain.length > 0 && srcClass) {
          const match = domain.some((d) => {
            try {
              if (!d) return false;
              if (d === srcClass) return true;
              // accept local-name matches
              const idx = Math.max(String(d).lastIndexOf("/"), String(d).lastIndexOf("#"));
              const local = idx > -1 ? String(d).substring(idx + 1) : String(d);
              return local === srcClass || local === (srcClass.split(":").pop() || "");
            } catch (_) { return false; }
          });
          if (!match) {
            errors.push({
              nodeId: id,
              message: `Edge ${id} domain mismatch: expected domain ${domain.join(", ")}, got ${srcClass}`,
              severity: "error",
            });
          }
        }
        if (range.length > 0 && tgtClass) {
          const match = range.some((r) => {
            try {
              if (!r) return false;
              if (r === tgtClass) return true;
              const idx = Math.max(String(r).lastIndexOf("/"), String(r).lastIndexOf("#"));
              const local = idx > -1 ? String(r).substring(idx + 1) : String(r);
              return local === tgtClass || local === (tgtClass.split(":").pop() || "");
            } catch (_) { return false; }
          });
          if (!match) {
            errors.push({
              nodeId: id,
              message: `Edge ${id} range mismatch: expected range ${range.join(", ")}, got ${tgtClass}`,
              severity: "error",
            });
          }
        }
      } catch (_) { /* ignore per-edge */ }
    }
  }
  return errors;
}

export default validateGraph;
