/**
 * ELK Layout Algorithm Configurations
 * 
 * This file contains all configuration for ELK.js layouting algorithms.
 * Modify algorithm-specific parameters here to tune layout behavior.
 * 
 * Reference: https://eclipse.dev/elk/reference/algorithms.html
 */

export interface ElkAlgorithmConfig {
  /** ELK algorithm identifier */
  algorithm: string;
  /** Display label for UI */
  label: string;
  /** Description/tooltip for UI */
  description: string;
  /** Icon name for UI (Lucide icon name) */
  icon: string;
  /** Default ELK options for this algorithm (user spacing will be merged in) */
  defaultOptions: Record<string, any>;
}

/**
 * ELK Algorithm Configurations
 * 
 * Selected algorithms optimized for:
 * - Fast performance
 * - Layered/hierarchical graphs (not tree-specific)
 * - Knowledge graphs and ontologies
 */
export const ELK_ALGORITHMS: Record<string, ElkAlgorithmConfig> = {
  layered: {
    algorithm: 'org.eclipse.elk.layered',
    label: 'ELK Layered',
    description: 'Layered layout - Optimized for directed graphs with clear hierarchies',
    icon: 'Layers',
    defaultOptions: {
      'elk.algorithm': 'org.eclipse.elk.layered',
      'elk.direction': 'RIGHT', // Horizontal layout (LEFT-TO-RIGHT)
      // Spacing will be set dynamically from user preference
      // Additional layered-specific optimizations:
      'elk.layered.nodePlacement.strategy': 'SIMPLE',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.cycleBreaking.strategy': 'GREEDY',
    }
  },

  force: {
    algorithm: 'org.eclipse.elk.force',
    label: 'ELK Force',
    description: 'Force-directed layout - Best for general graphs with complex connections',
    icon: 'GitBranch',
    defaultOptions: {
      'elk.algorithm': 'org.eclipse.elk.force',
      'elk.direction': 'RIGHT',
      // Force-directed parameters:
      'elk.force.repulsion': 100,
      'elk.force.temperature': 0.001,
      'elk.force.iterations': 300,
    }
  },

  stress: {
    algorithm: 'org.eclipse.elk.stress',
    label: 'ELK Stress',
    description: 'Stress layout - Fast algorithm for large, densely connected graphs',
    icon: 'Network',
    defaultOptions: {
      'elk.algorithm': 'org.eclipse.elk.stress',
      'elk.direction': 'RIGHT',
      // Stress minimization parameters:
      'elk.stress.desiredEdgeLength': 100,
      'elk.stress.epsilon': 0.0001,
    }
  }
};

/**
 * Get list of all available ELK algorithm keys
 */
export function getAvailableElkAlgorithms(): string[] {
  return Object.keys(ELK_ALGORITHMS);
}

/**
 * Get configuration for a specific ELK algorithm
 */
export function getElkAlgorithmConfig(algorithmKey: string): ElkAlgorithmConfig | undefined {
  return ELK_ALGORITHMS[algorithmKey];
}
