export interface ReasoningError {
  nodeId?: string;
  edgeId?: string;
  message: string;
  rule: string;
  severity: "critical" | "error";
}

export interface ReasoningWarning {
  nodeId?: string;
  edgeId?: string;
  message: string;
  rule: string;
  severity?: "critical" | "warning" | "info";
}

export interface ReasoningInference {
  type: "property" | "class" | "relationship";
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

export interface ReasoningResult {
  id: string;
  timestamp: number;
  status: "running" | "completed" | "error";
  duration?: number;
  errors: ReasoningError[];
  warnings: ReasoningWarning[];
  inferences: ReasoningInference[];
  inferredQuads?: { subject: string; predicate: string; object: string; graph?: string }[];
  meta?: { usedReasoner?: boolean };
}

