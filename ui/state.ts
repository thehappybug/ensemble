import type { GraphNode } from './types.js';
/** Manual steps need an explicit node selection, matching scheduler policy. */
export function automaticStaleNodes(nodes:GraphNode[]):GraphNode[] {
  return nodes.filter(node=>node.status==='stale'&&node.kind!=='fanout'&&(node.kind==='action'?node.fm.plan!=='manual':node.fm.mode!=='manual'));
}
