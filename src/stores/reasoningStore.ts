import { create } from 'zustand';

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
  startReasoning: (nodes: any[], edges: any[]) => Promise<ReasoningResult>;
  abortReasoning: () => void;
  clearHistory: () => void;
  getLastResult: () => ReasoningResult | null;
}

export const useReasoningStore = create<ReasoningStore>((set, get) => ({
  currentReasoning: null,
  reasoningHistory: [],
  isReasoning: false,

  startReasoning: async (nodes, edges) => {
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
      // Simulate reasoning process
      await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));

      // Mock reasoning results
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

      // Generate inferences
      if (nodes.length > 1) {
        inferences.push({
          type: 'relationship',
          subject: 'john_doe',
          predicate: 'rdf:type',
          object: 'foaf:Agent',
          confidence: 0.95
        });
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