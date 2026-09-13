import { type BridgeConfig, loadConfig } from './config.ts'
import { connect, grantReader, migrate } from './db.ts'
import { createBridgeServer } from './http.ts'
import { SessionManager } from './sessions.ts'

let config: BridgeConfig
try {
  config = loadConfig()
}
catch (error) {
  console.error((error as Error).message)
  process.exit(1)
}

const sql = connect(config.databaseUrl)

const applied = await migrate(sql)
if (applied.length > 0) console.info(`[db] applied ${applied.join(', ')}`)

if (!(await grantReader(sql, config.readerRole))) {
  console.warn(
    `[db] reader role "${config.readerRole}" does not exist. The app cannot read synced Telegram data until it does; `
    + 'see apps/telegram-bridge/db-init.sh.',
  )
}

const manager = new SessionManager(sql, config)
const server = createBridgeServer(manager, config)

// :: accepts IPv6 and IPv4. Legacy Railway private networking is IPv6-only.
await new Promise<void>(resolve => server.listen(config.port, '::', resolve))
console.info(`[bridge] listening on :${config.port}${config.testServers ? ' — Telegram TEST servers' : ''}`)

await manager.start()

let stopping = false
async function stop(signal: string): Promise<void> {
  if (stopping) return
  stopping = true
  console.info(`[bridge] ${signal}: disconnecting sessions (they stay linked)`)
  server.close()
  await manager.shutdown()
  await sql.end({ timeout: 5 })
  process.exit(0)
}

process.on('SIGTERM', () => { void stop('SIGTERM') })
process.on('SIGINT', () => { void stop('SIGINT') })
