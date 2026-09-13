import { z } from 'zod'
import { parseKey } from './crypto.ts'

/**
 * Everything the bridge reads from its environment, validated once at boot.
 *
 * A bridge that started without its Telegram credentials or its encryption key
 * would come up healthy and then fail every pairing, so it refuses to start
 * instead. The error names each variable and never echoes a value.
 */
const schema = z.object({
  TELEGRAM_API_ID: z.coerce.number().int().positive(),
  TELEGRAM_API_HASH: z.string().regex(/^[0-9a-f]{32}$/i, 'expected the 32-character hex api_hash from my.telegram.org'),
  TELEGRAM_BRIDGE_ADMIN_KEY: z.string().min(24, 'use at least 24 characters (openssl rand -hex 24)'),
  TELEGRAM_SESSION_ENCRYPTION_KEY: z.string().min(1),
  TELEGRAM_BRIDGE_DATABASE_URL: z.string().min(1),
  TELEGRAM_READER_ROLE: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).default('telegram_reader'),
  TELEGRAM_TEST_SERVERS: z.enum(['true', 'false']).default('false'),
  TELEGRAM_BRIDGE_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  // Railway injects PORT into every service; following it is what makes the
  // bridge listen where the platform routes to.
  PORT: z.coerce.number().int().min(1).max(65535).optional(),
})

export interface BridgeConfig {
  apiId: number
  apiHash: string
  adminKey: string
  /** 32 bytes. Seals stored sessions and webhook headers. */
  sealKey: Buffer
  databaseUrl: string
  /** The SELECT-only role the app reads synced data with. */
  readerRole: string
  testServers: boolean
  port: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BridgeConfig {
  const parsed = schema.safeParse(env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map(issue => `  ${issue.path.join('.')}: ${issue.message}`)
    throw new Error(`telegram-bridge cannot start. Fix these environment variables:\n${lines.join('\n')}`)
  }

  const e = parsed.data
  let sealKey: Buffer
  try {
    sealKey = parseKey(e.TELEGRAM_SESSION_ENCRYPTION_KEY)
  }
  catch (error) {
    throw new Error(`telegram-bridge cannot start. TELEGRAM_SESSION_ENCRYPTION_KEY: ${(error as Error).message}`)
  }

  return {
    apiId: e.TELEGRAM_API_ID,
    apiHash: e.TELEGRAM_API_HASH,
    adminKey: e.TELEGRAM_BRIDGE_ADMIN_KEY,
    sealKey,
    databaseUrl: e.TELEGRAM_BRIDGE_DATABASE_URL,
    readerRole: e.TELEGRAM_READER_ROLE,
    testServers: e.TELEGRAM_TEST_SERVERS === 'true',
    port: e.TELEGRAM_BRIDGE_PORT ?? e.PORT ?? 8095,
  }
}
