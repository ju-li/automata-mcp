import type { H3Event } from 'h3'
import type { ZodType } from 'zod'

/**
 * Validate a request body, answering 400 with a message a person can act on.
 *
 * Calling `schema.parse()` directly throws a ZodError, which Nitro reports as a
 * 500 — the caller is told the server broke when in fact they sent the wrong
 * thing. h3's `readValidatedBody` gets the status right but surfaces zod's raw
 * dump; this flattens the issues into something the UI can put next to a field.
 *
 * A missing or unparseable body validates as `{}`, so schemas with defaults
 * still work for optional-body routes.
 */
export async function parseBody<T>(event: H3Event, schema: ZodType<T>): Promise<T> {
  const raw = await readBody(event).catch(() => ({}))
  const result = schema.safeParse(raw ?? {})

  if (!result.success) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Validation Error',
      message: result.error.issues
        .map(issue => `${issue.path.join('.') || 'body'}: ${issue.message}`)
        .join('; '),
    })
  }

  return result.data
}
