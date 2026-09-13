import { createHash } from 'node:crypto'
import postgres from 'postgres'

/**
 * One process per Telegram session, enforced by Postgres advisory locks.
 *
 * Two processes using the same auth key at once make Telegram answer
 * AUTH_KEY_DUPLICATED and invalidate the key — the account has to be scanned
 * again. A rolling deploy that briefly runs the old and new bridge side by side
 * is exactly that, so "only one replica" is not something to leave to
 * configuration.
 *
 * Every lock lives on **one dedicated connection**. A session-level advisory
 * lock belongs to the backend that took it, so if that connection is replaced
 * every lock is silently gone. `verify()` notices by comparing the backend pid,
 * and treats a failed check the same way: a client that might no longer hold
 * its lock is stopped, because a disconnect costs a reconnect and a duplicate
 * costs a QR scan.
 */

const VERIFY_MS = 5_000

export class SessionLocks {
  private readonly sql: postgres.Sql
  private readonly held = new Set<string>()
  private readonly onLost: (ids: string[]) => void
  private pid: number | undefined
  private timer: NodeJS.Timeout | undefined

  constructor(databaseUrl: string, onLost: (ids: string[]) => void) {
    this.onLost = onLost
    this.sql = postgres(databaseUrl, {
      max: 1,
      // Neither timeout may rotate this connection: rotating it releases every lock.
      idle_timeout: 0,
      max_lifetime: null,
      connect_timeout: 10,
      onnotice: () => {},
      connection: { application_name: 'telegram-bridge-locks' },
    })
  }

  start(): void {
    this.timer = setInterval(() => { void this.verify() }, VERIFY_MS)
    this.timer.unref()
  }

  /** Take the lock for a session, or answer false if another process has it. */
  async acquire(id: string): Promise<boolean> {
    await this.verify()
    if (this.held.has(id)) return true
    const [row] = await this.sql<{ locked: boolean }[]>`SELECT pg_try_advisory_lock(${lockKey(id)}::bigint) AS locked`
    if (row?.locked) this.held.add(id)
    return row?.locked === true
  }

  async release(id: string): Promise<void> {
    if (!this.held.delete(id)) return
    await this.sql`SELECT pg_advisory_unlock(${lockKey(id)}::bigint)`.catch(() => {})
  }

  async close(): Promise<void> {
    clearInterval(this.timer)
    for (const id of [...this.held]) await this.release(id)
    await this.sql.end({ timeout: 5 })
  }

  private async verify(): Promise<void> {
    let pid: number | undefined
    try {
      const [row] = await this.sql<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
      pid = row?.pid
    }
    catch (error) {
      console.error(`[locks] could not verify session locks (${(error as Error).message}); stopping every session that held one`)
    }

    if (pid !== undefined && (this.pid === undefined || pid === this.pid)) {
      this.pid = pid
      return
    }

    this.pid = pid
    if (this.held.size === 0) return
    const lost = [...this.held]
    this.held.clear()
    this.onLost(lost)
  }
}

/**
 * 64 bits of a sha256, rather than `hashtext`'s 32, so two sessions never share a
 * lock and silently keep each other from running.
 */
function lockKey(id: string): string {
  const hex = createHash('sha256').update(`telegram-bridge:session:${id}`).digest('hex').slice(0, 16)
  return BigInt.asIntN(64, BigInt(`0x${hex}`)).toString()
}
