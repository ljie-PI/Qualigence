/**
 * Builds the de-identified, trace-safe token stored in a ResolvedAction's
 * `selector` field. It intentionally carries no CSS/XPath — only the graph and
 * node identity the model already knows — so selectors never leak downstream.
 */
export function actionToken(graphId: string, nodeId: string): string {
  return `pw:${graphId}:${nodeId}`;
}

export function isActionToken(
  token: string,
  graphId: string,
  nodeId: string,
): boolean {
  return token === actionToken(graphId, nodeId);
}
