/**
 * Read tool, and the parity of `get-connection-status`: something cheap for a
 * model to call before it starts guessing. Takes no arguments, because the token
 * is bound to one connection.
 */
export default defineMcpTool({
  name: 'get-database-info',
  group: 'postgres',
  enabled: event => isToolAllowed(event, 'get-database-info', 'postgres'),
  title: 'Check the database connection',
  description:
    'Report whether this connector can reach its database, which server version '
    + 'and database it is, which role it connects as, and what this token is '
    + 'scoped to. Call this first when a query fails in a way that might be the '
    + 'connection rather than the SQL. `tablesInScope` lists the tables this token '
    + 'may reach when it is scoped to an allowlist; when it is not, every table '
    + 'the role can read is reachable and list-tables is the way to see them.',
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {},
  handler: async () => {
    const { instance, scope } = useMcpAuth()

    const sql = await pgFor(instance)
    const [row] = await sql<Array<{ version: string, current_user: string, database: string }>>`
      SELECT current_setting('server_version') AS version,
             current_user,
             current_database() AS database`

    return {
      connected: true,
      serverVersion: row?.version ?? 'unknown',
      database: row?.database ?? instance.pg_database ?? 'unknown',
      role: row?.current_user ?? 'unknown',
      host: instance.pg_host,
      port: instance.pg_port,
      allTables: scope.allTables,
      ...(!scope.allTables && { tablesInScope: scope.tableNames }),
      canWrite: scope.allTools || scope.toolNames.includes('run-statement'),
    }
  },
})
