# PocketBase service

Pinned PocketBase release on Alpine. Admin UI: <http://localhost:8090/_/>

- **`pb_migrations/`** — committed. Schema source of truth. PocketBase applies
  every file here on boot, and writes a new file whenever you change schema in
  the admin UI (the directory is bind-mounted, so those land in the repo).
  Commit them.
- **`pb_hooks/`** — committed. Drop `*.pb.js` files here for server-side hooks.
- **`pb_data/`** — gitignored. Runtime state: the SQLite database, uploaded
  files, logs. Deleting it resets everything including the superuser account.

Bump the version with the `PB_VERSION` build arg in the Dockerfile, then
`docker compose -f docker-compose.dev.yml build pocketbase`.
