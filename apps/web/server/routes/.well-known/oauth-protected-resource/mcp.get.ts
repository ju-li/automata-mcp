/**
 * RFC 9728 metadata for the `/mcp` resource, at its path-suffixed address —
 * the URL the MCP 401's `resource_metadata` names. A static route, so it wins
 * over the toolkit's `/.well-known/oauth-protected-resource/**` 404.
 */
export default defineEventHandler((event) => {
  return metadataOr404(event, protectedResourceMetadata)
})
