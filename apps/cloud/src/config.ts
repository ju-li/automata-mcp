import { z } from 'zod'

/**
 * Everything the cloud service reads from its environment, validated once at
 * boot. A service missing its admin key, database or app URL would come up
 * healthy and fail every request, so it refuses to start instead. The error
 * names each variable and never echoes a value.
 *
 * **Stripe is all or nothing.** With none of the four Stripe variables set the
 * service still starts — it still owns plan definitions and entitlements — and
 * every billing route answers 503 `billing_not_configured`. One set without the
 * others refuses to start: a typo must fail loudly, not pass for "billing off".
 */
const schema = z.object({
  CLOUD_ADMIN_KEY: z.string().min(24, 'use at least 24 characters (openssl rand -hex 24)'),
  CLOUD_DATABASE_URL: z.string().min(1),
  // The web app's public address. Checkout and the Customer Portal send the
  // browser back to it; it is never taken from a request.
  APP_URL: z.string().url().refine(url => /^https?:\/\//i.test(url), 'must be http or https'),
  STRIPE_SECRET_KEY: z.string().min(1).optional(),
  STRIPE_WEBHOOK_SECRET: z.string().min(1).optional(),
  STRIPE_PRICE_BASE: z.string().min(1).optional(),
  STRIPE_PRICE_SEAT: z.string().min(1).optional(),
  // The Brevo CRM sync. Without a key it is off; everything else runs.
  BREVO_API_KEY: z.string().min(1).optional(),
  // A contact list every synced contact is added to. Leave unset unless the
  // people on it agreed to what that list is used for.
  BREVO_LIST_ID: z.coerce.number().int().positive().optional(),
  // For tests against a stand-in server; production never sets it.
  BREVO_API_URL: z.string().url().optional(),
  CLOUD_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  // Railway injects PORT into every service; following it is what makes the
  // service listen where the platform routes to.
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
})

export interface StripeSettings {
  secretKey: string
  webhookSecret: string
  /** The flat monthly base price. */
  priceBase: string
  /** The per-seat price, charged for each member beyond the included ones. */
  priceSeat: string
}

export interface BrevoSettings {
  apiKey: string
  /** A list every synced contact joins; none when unset. */
  listId?: number
  baseUrl: string
}

export interface CloudConfig {
  adminKey: string
  databaseUrl: string
  appUrl: string
  /** Absent when the service runs without Stripe. */
  stripe?: StripeSettings
  /** Absent when the service runs without the CRM sync. */
  brevo?: BrevoSettings
  port: number
}

const STRIPE_VARS = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'STRIPE_PRICE_BASE', 'STRIPE_PRICE_SEAT'] as const

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  // An empty value in a compose file or .env means "unset", not zero.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ''))
  const parsed = schema.safeParse(present)
  if (!parsed.success) {
    const lines = parsed.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`cloud cannot start. Fix these environment variables:\n${lines.join('\n')}`)
  }

  const e = parsed.data
  const set = STRIPE_VARS.filter(name => e[name] !== undefined)
  if (set.length > 0 && set.length < STRIPE_VARS.length) {
    const missing = STRIPE_VARS.filter(name => e[name] === undefined)
    throw new Error(
      'cloud cannot start. Fix these environment variables:\n'
      + missing.map(name => `  ${name}: set it too — the four STRIPE_* variables go together (leave all empty to run without billing)`).join('\n'),
    )
  }

  return {
    adminKey: e.CLOUD_ADMIN_KEY,
    databaseUrl: e.CLOUD_DATABASE_URL,
    appUrl: e.APP_URL.replace(/\/+$/, ''),
    stripe: set.length === STRIPE_VARS.length
      ? {
          secretKey: e.STRIPE_SECRET_KEY!,
          webhookSecret: e.STRIPE_WEBHOOK_SECRET!,
          priceBase: e.STRIPE_PRICE_BASE!,
          priceSeat: e.STRIPE_PRICE_SEAT!,
        }
      : undefined,
    brevo: e.BREVO_API_KEY
      ? {
          apiKey: e.BREVO_API_KEY,
          listId: e.BREVO_LIST_ID,
          baseUrl: (e.BREVO_API_URL ?? 'https://api.brevo.com/v3').replace(/\/+$/, ''),
        }
      : undefined,
    port: e.CLOUD_PORT ?? e.PORT ?? 8096,
  }
}
