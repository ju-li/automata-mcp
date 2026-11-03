/**
 * RFC 9728 protected resource metadata, at the root form.
 *
 * `.get` is load-bearing: @nuxtjs/mcp-toolkit registers a method-less 404
 * handler on this same path, and h3 picks a method-specific handler over a
 * method-less one on the same route. A method-less file here would be
 * overwritten by the toolkit's, which Nitro adds after scanned routes. OPTIONS
 * is answered by server/middleware/oauth-cors.ts before routing.
 */
export default defineEventHandler((event) => {
  return metadataOr404(event, protectedResourceMetadata)
})
