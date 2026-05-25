// ---------------------------------------------------------------------------
// Knowledge graph stub — entity/relationship extraction from chunks.
// Declared for the route seam; actual extraction is a future UI task.
// ---------------------------------------------------------------------------

export interface KnowledgeNode {
  id: string;
  label: string;
  type: string;
}

export interface KnowledgeEdge {
  source: string;
  target: string;
  relation: string;
}

export interface KnowledgeGraph {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
}

export async function buildKnowledgeGraph(
  _knowledgeBaseId: string,
  _orgId: string
): Promise<KnowledgeGraph> {
  return { nodes: [], edges: [] };
}
