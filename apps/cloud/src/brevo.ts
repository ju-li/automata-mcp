import type { BrevoSettings } from './config.ts'

/**
 * The few Brevo API v3 calls the CRM sync makes, and nothing else. Shapes
 * follow Brevo's own SDK (@getbrevo/brevo, generated from their OpenAPI
 * definition):
 *
 *   POST   /contacts                          create, or update by email (updateEnabled)
 *   PUT    /contacts/{id}?identifierType=…    update one contact
 *   GET    /contacts/{id}?identifierType=…    find a contact's numeric id
 *   POST   /contacts/attributes/normal/{NAME} create a contact attribute
 *   POST   /companies, PATCH/DELETE /companies/{id}
 *   POST   /events                            a lifecycle event on a contact
 *
 * Authenticated with the `api-key` header. Nothing here logs a request or
 * response body: they carry people's names and addresses.
 */

export class BrevoError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type AttributeValue = string | number | boolean

export interface BrevoClient {
  createContact(body: {
    email: string
    ext_id: string
    attributes: Record<string, AttributeValue>
    listIds?: number[]
  }): Promise<number | undefined>
  updateContact(id: number, body: {
    attributes: Record<string, AttributeValue>
    ext_id?: string
    listIds?: number[]
  }): Promise<void>
  contactId(identifier: string, type: 'ext_id' | 'email_id'): Promise<number | undefined>
  createContactAttribute(name: string, type: 'text' | 'date' | 'float' | 'boolean'): Promise<'created' | 'exists'>
  createCompany(body: { name: string, linkedContactsIds: number[] }): Promise<string>
  updateCompany(id: string, body: { name: string, linkedContactsIds: number[] }): Promise<void>
  deleteCompany(id: string): Promise<void>
  sendEvent(body: {
    event_name: string
    event_date?: string
    identifiers: { ext_id: string }
    event_properties?: Record<string, AttributeValue>
  }): Promise<void>
}

const TIMEOUT_MS = 15_000

export function createBrevoClient(settings: BrevoSettings): BrevoClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number, data?: T }> {
    let response: Response
    try {
      response = await fetch(`${settings.baseUrl}${path}`, {
        method,
        headers: {
          'api-key': settings.apiKey,
          'accept': 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    }
    catch (error) {
      throw new BrevoError(0, `Brevo could not be reached: ${(error as Error).message}`)
    }

    const text = await response.text()
    let data: unknown
    try {
      data = text ? JSON.parse(text) : undefined
    }
    catch {
      data = undefined
    }
    if (!response.ok) {
      // Brevo answers { code, message }; the message names the problem
      // ("Contact already exist", "Invalid attribute") without echoing values.
      const message = (data as { message?: unknown } | undefined)?.message
      throw new BrevoError(response.status, `${method} ${path.replace(/\/contacts\/[^/?]+/, '/contacts/:id').replace(/\/companies\/[^/?]+/, '/companies/:id')} → ${response.status}${typeof message === 'string' ? `: ${message.slice(0, 200)}` : ''}`)
    }
    return { status: response.status, data: data as T }
  }

  return {
    async createContact(body) {
      const { data } = await call<{ id?: number }>('POST', '/contacts', { ...body, updateEnabled: true })
      return typeof data?.id === 'number' ? data.id : undefined
    },
    async updateContact(id, body) {
      await call('PUT', `/contacts/${id}?identifierType=contact_id`, body)
    },
    async contactId(identifier, type) {
      try {
        const { data } = await call<{ id?: number }>('GET', `/contacts/${encodeURIComponent(identifier)}?identifierType=${type}`)
        return typeof data?.id === 'number' ? data.id : undefined
      }
      catch (error) {
        if (error instanceof BrevoError && error.status === 404) return undefined
        throw error
      }
    },
    async createContactAttribute(name, type) {
      try {
        await call('POST', `/contacts/attributes/normal/${encodeURIComponent(name)}`, { type })
        return 'created'
      }
      catch (error) {
        // An attribute that already exists is the ordinary case after the
        // first boot.
        if (error instanceof BrevoError && error.status === 400 && /exist/i.test(error.message)) return 'exists'
        throw error
      }
    },
    async createCompany(body) {
      const { data } = await call<{ id?: string }>('POST', '/companies', body)
      if (!data?.id) throw new BrevoError(500, 'POST /companies answered without an id')
      return data.id
    },
    async updateCompany(id, body) {
      await call('PATCH', `/companies/${encodeURIComponent(id)}`, body)
    },
    async deleteCompany(id) {
      try {
        await call('DELETE', `/companies/${encodeURIComponent(id)}`)
      }
      catch (error) {
        if (error instanceof BrevoError && error.status === 404) return
        throw error
      }
    },
    async sendEvent(body) {
      await call('POST', '/events', body)
    },
  }
}
