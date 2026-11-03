/**
 * RFC 8414 authorization server metadata. The issuer has no path, so this root
 * form is the only one clients look for. `.get` for the reason
 * oauth-protected-resource.get.ts gives.
 */
export default defineEventHandler((event) => {
  return metadataOr404(event, authorizationServerMetadata)
})
