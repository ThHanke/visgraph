import { create } from 'zustand';
import { DataFactory } from 'n3';
const { namedNode, literal, quad } = DataFactory;
import { WELL_KNOWN } from '../utils/wellKnownOntologies';
import { fallback } from '../utils/startupDebug';
import { shortLocalName } from '../utils/termUtils';

// Helper used by inline debug wrappers to safely stringify arguments that may be
// strings or objects with a .message property.
const __vg_safe = (a: any) => (a && (a as any).message) ? (a as any).message : String(a);

interface ReasoningResult {
  id: string;
  timestamp: number;
  status: 'running' | 'completed' | 'error';
  duration?: number;
  errors: ReasoningError[];
  warnings: ReasoningWarning[];
  inferences: Inference[];
}

interface ReasoningError {
  nodeId?: string;
  edgeId?: string;
  message: string;
  rule: string;
  severity: 'critical' | 'error';
}

interface ReasoningWarning {
  nodeId?: string;
  edgeId?: string;
  message: string;
  rule: string;
}

interface Inference {
  type: 'property' | 'class' | 'relationship';
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

interface ReasoningStore {
  currentReasoning: ReasoningResult | null;
  reasoningHistory: ReasoningResult[];
  isReasoning: boolean;
  startReasoning: (nodes: any[], edges: any[], rdfStore?: any) => Promise<ReasoningResult>;
  abortReasoning: () => void;
  clearHistory: () => void;
  getLastResult: () => ReasoningResult | null;
}

export const useReasoningStore = create<ReasoningStore>((set, get) => ({
  currentReasoning: null,
  reasoningHistory: [],
  isReasoning: false,

  startReasoning: async (nodes, edges, rdfStore) => {
    const reasoningId = `reasoning-${Date.now()}`;
    const startTime = Date.now();

    set({ isReasoning: true });

    const reasoning: ReasoningResult = {
      id: reasoningId,
      timestamp: startTime,
      status: 'running',
      errors: [],
      warnings: [],
      inferences: []
    };

    set({ currentReasoning: reasoning });

    try {
      // If RDF store is provided, it will be used in the reasoning steps below.
      // Simulate reasoning process
      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));

      // Mock reasoning results based on RDF store if available
      const errors: ReasoningError[] = [];
      const warnings: ReasoningWarning[] = [];
      const inferences: Inference[] = [];

      // Helper: robustly resolve edge/source/target keys and display labels
      function resolveEdgeKey(edge: any) {
        const fromKey = edge.from || edge.source || edge.sourceId || edge.sourceKey || edge.id || edge.key || '';
        const toKey = edge.to || edge.target || edge.targetId || edge.targetKey || edge.id || edge.key || '';
        const edgeId = edge.key || edge.id || `${fromKey}-${toKey}`;
        return { fromKey, toKey, edgeId };
      }

      function findNodeByKey(nodesArr: any[], key: string) {
        if (!key) return undefined;
        return nodesArr.find((n: any) => {
          try {
            return (
              n.key === key ||
              n.id === key ||
              n.iri === key ||
              (n.data && (n.data.key === key || n.data.iri === key)) ||
              (n.data && (n.data.iri === key))
            );
          } catch (_) {
            return false;
          }
        });
      }

      function displayLabelForNode(n: any, fallbackKey: string) {
        try {
          if (!n && fallbackKey) return shortLocalName(String(fallbackKey));
          const indiv = n && (n.individualName || (n.data && n.data.individualName));
          const lab = n && (n.label || (n.data && n.data.label));
          const uri = n && (n.iri || (n.data && n.data.iri) || (n.data && n.data.iri)) || fallbackKey;
          if (typeof indiv === 'string' && indiv.trim()) return String(indiv);
          if (typeof lab === 'string' && lab.trim()) return String(lab);
          if (typeof uri === 'string' && uri.trim()) return shortLocalName(String(uri));
          return String(fallbackKey || 'unknown');
        } catch (_) {
          return String(fallbackKey || 'unknown');
        }
      }

      // Check for domain/range violations and missing labels
      edges.forEach(edge => {
        const { fromKey, toKey, edgeId } = resolveEdgeKey(edge);
        const sourceNode = findNodeByKey(nodes, fromKey);
        const targetNode = findNodeByKey(nodes, toKey);

        // Example domain/range check for foaf:memberOf kept from original logic
        if (edge.propertyType === 'foaf:memberOf') {
          if (sourceNode?.classType !== 'Person') {
            errors.push({
              edgeId,
              message: `Property foaf:memberOf requires domain of type Person, but found ${sourceNode?.classType || 'Unknown'}. Solution: Change source node to Person type or use different property.`,
              rule: 'domain-restriction',
              severity: 'error'
            });
          }

          if (targetNode?.classType !== 'Organization') {
            errors.push({
              edgeId,
              message: `Property foaf:memberOf requires range of type Organization, but found ${targetNode?.classType || 'Unknown'}. Solution: Change target node to Organization type or use different property.`,
              rule: 'range-restriction',
              severity: 'error'
            });
          }
        }

        // Check for missing property labels
        if (!edge.label || (typeof edge.label === 'string' && edge.label.trim() === '')) {
          const srcLabel = displayLabelForNode(sourceNode, fromKey);
          const tgtLabel = displayLabelForNode(targetNode, toKey);
          warnings.push({
            edgeId,
            message: `Edge between ${srcLabel} and ${tgtLabel} is missing a property label. Solution: Double-click the edge to add a label.`,
            rule: 'missing-property-label'
          });
        }
      });

      // Check for missing properties
      nodes.forEach(node => {
        // Helper to get a friendly display label for node (individualName, label, shortened URI, key)
        const nodeDisplayLabel = displayLabelForNode(node, node && (node.key || node.id || node.iri));

        if (node.classType === 'Person') {
          const hasName = node.literalProperties?.some(prop => prop.key && String(prop.key).includes('name'));
          if (!hasName) {
            warnings.push({
              nodeId: node.key || node.id,
              message: `Person instance "${nodeDisplayLabel}" should have a name property. Solution: Double-click the node to add foaf:name property.`,
              rule: 'recommended-property'
            });
          }
        }

        // Check for nodes without proper individual names
        const indivName = (node && (node.individualName || (node.data && node.data.individualName))) || '';
        if (!indivName || (typeof indivName === 'string' && indivName.trim() === '')) {
          warnings.push({
            nodeId: node.key || node.id,
            message: `Node of type ${node.classType || 'Unknown'} (${nodeDisplayLabel}) is missing an individual name. Solution: Double-click the node to set an individual name.`,
            rule: 'missing-individual-name'
          });
        }
      });

      // Generate inferences from RDF store if available
      if (rdfStore) {
        // Gather quads excluding any already-written inferences (urn:vg:inferred)
        const allQuads = rdfStore.getQuads(null, null, null, null);
        const quads = Array.isArray(allQuads) ? allQuads.filter(q => {
          try { return !(q.graph && (q.graph.value === 'urn:vg:inferred')); } catch (_) { return true; }
        }) : [];

        // Extract actual inferences from RDF store (excluding previously inferred quads)
        const inferredQuads = [];
        
        // Apply RDFS inference rules
        quads.forEach(quad => {
          // Rule: rdfs:subClassOf transitivity
          if (quad.predicate && quad.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#subClassOf') {
            // Find transitive subclass relationships within the filtered quads
            const subClasses = quads.filter(q => 
              q.predicate && q.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#subClassOf' && 
              q.subject && q.subject.value === quad.object.value
            );
            subClasses.forEach(subClass => {
              inferredQuads.push({
                type: 'class',
                subject: quad.subject.value,
                predicate: 'rdfs:subClassOf',
                object: subClass.object.value,
                confidence: 0.9
              });
            });
          }
          
          // Rule: rdfs:domain inference
          if (quad.predicate && quad.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#domain') {
            const propertyInstances = quads.filter(q => q.predicate && q.predicate.value === quad.subject.value);
            propertyInstances.forEach(instance => {
              inferredQuads.push({
                type: 'class',
                subject: instance.subject.value,
                predicate: 'rdf:type',
                object: quad.object.value,
                confidence: 0.85
              });
            });
          }
          
          // Rule: rdfs:range inference
          if (quad.predicate && quad.predicate.value === 'http://www.w3.org/2000/01/rdf-schema#range') {
            const propertyInstances = quads.filter(q => q.predicate && q.predicate.value === quad.subject.value);
            propertyInstances.forEach(instance => {
              if (instance.object && instance.object.termType === 'NamedNode') {
                inferredQuads.push({
                  type: 'class',
                  subject: instance.object.value,
                  predicate: 'rdf:type',
                  object: quad.object.value,
                  confidence: 0.85
                });
              }
            });
          }
        });
        
        // Add unique inferences to results
        const uniqueInferences = new Map();
        inferredQuads.forEach(inf => {
          const key = `${inf.subject}|${inf.predicate}|${inf.object}`;
          if (!uniqueInferences.has(key)) {
            uniqueInferences.set(key, inf);
          }
        });
        
        inferences.push(...Array.from(uniqueInferences.values()));
        
        // Apply inferences back to RDF store (robust handling for N3.Store or RDFManager.getStore())
        if (inferences.length > 0 && rdfStore) {
          try {
            const isN3Store = typeof rdfStore.getQuads === 'function' && typeof rdfStore.addQuad === 'function';
            const g = namedNode('urn:vg:inferred');

            for (const inf of inferences) {
              try {
                const predRaw = inf.predicate && inf.predicate.includes(':') ? expandPredicate(inf.predicate) : inf.predicate;
                const subjTerm = namedNode(String(inf.subject));
                const predTerm = namedNode(String(predRaw));
                const objTerm = (typeof inf.object === 'string' && (/^https?:\/\//i.test(inf.object) || inf.object.includes(':')))
                  ? namedNode(String(inf.object))
                  : literal(String(inf.object));

                const exists = isN3Store
                  ? ((rdfStore.getQuads(subjTerm, predTerm, objTerm, g) || []).length > 0)
                  : ((typeof (rdfStore as any).getQuads === 'function') ? ((rdfStore as any).getQuads(subjTerm, predTerm, objTerm, g) || []).length > 0 : false);

                if (!exists) {
                  if (isN3Store) {
                    rdfStore.addQuad(quad(subjTerm, predTerm, objTerm, g));
                  } else if (typeof (rdfStore as any).addQuad === 'function') {
                    (rdfStore as any).addQuad(quad(subjTerm, predTerm, objTerm, g));
                  } else if (typeof (rdfStore as any).add === 'function' && typeof (rdfStore as any).quad === 'function') {
                    (rdfStore as any).add((rdfStore as any).quad(subjTerm, predTerm, objTerm, g));
                  } else {
                    console.warn('Cannot persist inferred triple, unsupported rdfStore API:', inf);
                  }
                }
              } catch (e) {
                console.warn('Failed to process inferred item:', inf, e);
              }
            }
          } catch (e) {
            console.warn('Failed to apply inferences to RDF store:', e);
          }
        }
      } else {
        // Fallback to basic graph analysis when no RDF store is available
        if (nodes.length > 1) {
          // Only add meaningful inferences based on actual graph structure
          nodes.forEach(node => {
            if (node.classType && node.individualName) {
              inferences.push({
                type: 'class',
                subject: node.iri || node.key,
                predicate: 'rdf:type',
                object: node.classType,
                confidence: 1.0
              });
            }
          });
        }
      }
      
      // Helper function to expand prefixed names using the centralized well-known prefixes.
      // Falls back to the original value if no matching prefix is found.
      function expandPredicate(prefixed: string) {
        try {
          if (!prefixed || typeof prefixed !== 'string') return prefixed;
          // WELL_KNOWN.prefixes has shape { rdf: 'http://...#', rdfs: 'http://...#', ... }
          const prefixes = (WELL_KNOWN && (WELL_KNOWN as any).prefixes) || {};
          // Find matching prefix + colon (e.g. 'rdf:')
          const match = Object.keys(prefixes).find((p) => prefixed.startsWith(p + ':'));
          if (match) {
            return prefixed.replace(new RegExp(`^${match}:`), prefixes[match]);
          }
          // No known prefix found — return original
          return prefixed;
        } catch (_) {
          return prefixed;
        }
      }

      const completedReasoning: ReasoningResult = {
        ...reasoning,
        status: 'completed',
        duration: Date.now() - startTime,
        errors,
        warnings,
        inferences
      };

      set((state) => ({
        currentReasoning: completedReasoning,
        isReasoning: false,
        reasoningHistory: [completedReasoning, ...state.reasoningHistory.slice(0, 9)]
      }));

      return completedReasoning;
    } catch (error) {
      const errorReasoning: ReasoningResult = {
        ...reasoning,
        status: 'error',
        duration: Date.now() - startTime,
        errors: [{
          message: 'Reasoning process failed',
          rule: 'system-error',
          severity: 'critical'
        }],
        warnings: [],
        inferences: []
      };

      set((state) => ({
        currentReasoning: errorReasoning,
        isReasoning: false,
        reasoningHistory: [errorReasoning, ...state.reasoningHistory.slice(0, 9)]
      }));

      return errorReasoning;
    }
  },

  abortReasoning: () => {
    set({ isReasoning: false, currentReasoning: null });
  },

  clearHistory: () => {
    set({ reasoningHistory: [] });
  },

  getLastResult: () => {
    const { reasoningHistory } = get();
    return reasoningHistory[0] || null;
  }
}));
