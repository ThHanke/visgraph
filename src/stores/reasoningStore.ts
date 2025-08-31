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
        if (edge.data?.propertyType === 'foaf:memberOf') {
          const sourceNode = nodes.find(n => n.id === edge.source);
          const targetNode = nodes.find(n => n.id === edge.target);
          
          if (sourceNode?.data.classType !== 'Person') {
            errors.push({
              edgeId: edge.id,
              message: `Property foaf:memberOf requires domain of type Person, but found ${sourceNode?.data.classType}`,
              rule: 'domain-restriction',
              severity: 'error'
            });
          }
          
          if (targetNode?.data.classType !== 'Organization') {
            errors.push({
              edgeId: edge.id,
              message: `Property foaf:memberOf requires range of type Organization, but found ${targetNode?.data.classType}`,
              rule: 'range-restriction',
              severity: 'error'
            });
          }
        }
      });

      // Check for missing properties
      nodes.forEach(node => {
        if (node.data.classType === 'Person' && !node.data.properties['foaf:name']) {
          warnings.push({
            nodeId: node.id,
            message: 'Person instances should have a foaf:name property',
            rule: 'recommended-property'
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