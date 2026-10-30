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
 *
 * **Brevo is all or nothing too**, for the same reason and one more: a key
 * without the marketing list would quietly drop consent people gave.
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
  BREVO_API_KEY: z.string().min(1).optional(),
  BREVO_PRODUCT_LIST: z.string().regex(/^\d+$/, 'must be a numeric Brevo list id').optional(),
  BREVO_MARKETING_LIST: z.string().regex(/^\d+$/, 'must be a numeric Brevo list id').optional(),
  // Only for pointing the sync at a local stub while testing failure handling.
  BREVO_API_URL: z.string().url().refine(url => /^https?:\/\//i.test(url), 'must be http or https').optional(),
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
  apiUrl: string
  /** Every contact is added to it when created. */
  productList: number
  /** A contact whose user gave marketing consent at signup is added to it when created. */
  marketingList: number
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
const BREVO_VARS = ['BREVO_API_KEY', 'BREVO_PRODUCT_LIST', 'BREVO_MARKETING_LIST'] as const

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
  const brevoSet = BREVO_VARS.filter(name => e[name] !== undefined)
  const incomplete = [
    ...(set.length > 0 && set.length < STRIPE_VARS.length
      ? STRIPE_VARS.filter(name => e[name] === undefined)
          .map(name => `  ${name}: set it too — the four STRIPE_* variables go together (leave all empty to run without billing)`)
      : []),
    ...(brevoSet.length > 0 && brevoSet.length < BREVO_VARS.length
      ? BREVO_VARS.filter(name => e[name] === undefined)
          .map(name => `  ${name}: set it too — the three BREVO_* variables go together (leave all empty to run without the CRM sync)`)
      : []),
  ]
  if (brevoSet.length === BREVO_VARS.length && e.BREVO_PRODUCT_LIST === e.BREVO_MARKETING_LIST) {
    incomplete.push('  BREVO_MARKETING_LIST: must differ from BREVO_PRODUCT_LIST — everyone goes on the product list, only those who consented on the marketing one')
  }
  if (incomplete.length > 0) {
    throw new Error(`cloud cannot start. Fix these environment variables:\n${incomplete.join('\n')}`)
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
    brevo: brevoSet.length === BREVO_VARS.length
      ? {
          apiKey: e.BREVO_API_KEY!,
          apiUrl: (e.BREVO_API_URL ?? 'https://api.brevo.com/v3').replace(/\/+$/, ''),
          productList: Number(e.BREVO_PRODUCT_LIST),
          marketingList: Number(e.BREVO_MARKETING_LIST),
        }
      : undefined,
    port: e.CLOUD_PORT ?? e.PORT ?? 8096,
  }
}
