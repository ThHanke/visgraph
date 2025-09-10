import { create } from 'zustand';
import { DataFactory } from 'n3';
const { namedNode, literal, quad } = DataFactory;

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

      // Check for domain/range violations
      edges.forEach(edge => {
        const sourceNode = nodes.find(n => n.key === edge.from);
        const targetNode = nodes.find(n => n.key === edge.to);
        
        if (edge.propertyType === 'foaf:memberOf') {
          if (sourceNode?.classType !== 'Person') {
            errors.push({
              edgeId: edge.key || `${edge.from}-${edge.to}`,
              message: `Property foaf:memberOf requires domain of type Person, but found ${sourceNode?.classType || 'Unknown'}. Solution: Change source node to Person type or use different property.`,
              rule: 'domain-restriction',
              severity: 'error'
            });
          }
          
          if (targetNode?.classType !== 'Organization') {
            errors.push({
              edgeId: edge.key || `${edge.from}-${edge.to}`,
              message: `Property foaf:memberOf requires range of type Organization, but found ${targetNode?.classType || 'Unknown'}. Solution: Change target node to Organization type or use different property.`,
              rule: 'range-restriction',
              severity: 'error'
            });
          }
        }
        
        // Check for missing property labels
        if (!edge.label || edge.label.trim() === '') {
          warnings.push({
            edgeId: edge.key || `${edge.from}-${edge.to}`,
            message: `Edge between ${sourceNode?.individualName || sourceNode?.key} and ${targetNode?.individualName || targetNode?.key} is missing a property label. Solution: Double-click the edge to add a label.`,
            rule: 'missing-property-label'
          });
        }
      });

      // Check for missing properties
      nodes.forEach(node => {
        if (node.classType === 'Person') {
          const hasName = node.literalProperties?.some(prop => prop.key.includes('name'));
          if (!hasName) {
            warnings.push({
              nodeId: node.key,
              message: `Person instance "${node.individualName || node.key}" should have a name property. Solution: Double-click the node to add foaf:name property.`,
              rule: 'recommended-property'
            });
          }
        }
        
        // Check for nodes without proper individual names
        if (!node.individualName || node.individualName.trim() === '') {
          warnings.push({
            nodeId: node.key,
            message: `Node of type ${node.classType} is missing an individual name. Solution: Double-click the node to set an individual name.`,
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
                    ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('Cannot persist inferred triple, unsupported rdfStore API:', inf);
                  }
                }
              } catch (e) {
                ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('Failed to process inferred item:', inf, e);
              }
            }
          } catch (e) {
            ((...__vg_args)=>{try{fallback('console.warn',{args:__vg_args.map(a=> (a && a.message)? a.message : String(a))},{level:'warn'})}catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { try { if (typeof fallback === "function") { fallback("emptyCatch", { error: String(_) }); } } catch (_) { /* empty */ } } } console.warn(...__vg_args);})('Failed to apply inferences to RDF store:', e);
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
                subject: node.uri || node.key,
                predicate: 'rdf:type',
                object: node.classType,
                confidence: 1.0
              });
            }
          });
        }
      }
      
      // Helper function to expand common prefixes
      function expandPredicate(prefixed) {
        const prefixMap = {
          'rdf:': 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
          'rdfs:': 'http://www.w3.org/2000/01/rdf-schema#',
          'owl:': 'http://www.w3.org/2002/07/owl#',
          'foaf:': 'http://xmlns.com/foaf/0.1/',
          'skos:': 'http://www.w3.org/2004/02/skos/core#'
        };
        
        const prefix = Object.keys(prefixMap).find(p => prefixed.startsWith(p));
        return prefix ? prefixed.replace(prefix, prefixMap[prefix]) : prefixed;
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
