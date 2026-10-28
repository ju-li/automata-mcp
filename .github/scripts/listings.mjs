#!/usr/bin/env node
// Keeps the directory listings in step with the code they describe.
//
//   node .github/scripts/listings.mjs check
//   node .github/scripts/listings.mjs version X.Y.Z
//   node .github/scripts/listings.mjs tools <server-card-url>
//
// Two files outside the app describe it to directories: server.json (the
// official MCP Registry, published by release.yml) and lhm.plugin.json (the
// LobeHub Marketplace, published by hand — its CLI has no non-interactive login).
// Each carries a version and lhm.plugin.json carries the tool list, and either
// can drift silently: a stale version on LobeHub merges a release's tools into
// the previous version's entry, and a stale tool list advertises tools that no
// longer exist.
//
// `check` runs from release-version.sh, so both release workflows refuse a
// release whose listings disagree with package.json or with the tool files.
// `version` writes one version into all three files. `tools` regenerates
// lhm.plugin.json's tool list from a running server's
// /.well-known/mcp/server-card.json — after deploy, since that is the only place
// the JSON Schemas exist; the check compares names only for that reason.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VERSIONED = ['package.json', 'server.json', 'lhm.plugin.json']
const TOOLS_DIR = 'apps/web/server/mcp/tools'
const KIND_LABEL = { whatsapp: 'WhatsApp', telegram: 'Telegram', imap: 'Email', postgres: 'PostgreSQL' }

// The first "version" key in each file is its top-level one: none of the three
// nests another. Replaced in the text so the files keep their formatting.
const VERSION_KEY = /("version"\s*:\s*")([^"]*)(")/

function fail(file, message) {
  console.log(`::error file=${file}::${message}`)
  process.exitCode = 1
}

function toolFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? toolFiles(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [join(dir, entry.name)] : [])
}

// Every tool sets `name` explicitly as its first property (CLAUDE.md, "Adding a
// tool"), so the first `name: '…'` in a tool file is that tool's name.
function codeToolNames() {
  return toolFiles(TOOLS_DIR).map((file) => {
    const match = /^\s*name:\s*'([^']+)'/m.exec(readFileSync(file, 'utf8'))
    if (!match) fail(file, 'No `name:` found; every tool must set its name explicitly.')
    return match?.[1]
  }).filter(Boolean).sort()
}

function check() {
  const expected = JSON.parse(readFileSync('package.json', 'utf8')).version
  for (const file of VERSIONED.slice(1)) {
    const version = JSON.parse(readFileSync(file, 'utf8')).version
    if (version !== expected) {
      fail(file, `"version" is "${version}" but package.json is "${expected}". Run: node .github/scripts/listings.mjs version ${expected}`)
    }
  }

  const code = codeToolNames()
  const listed = JSON.parse(readFileSync('lhm.plugin.json', 'utf8')).tools.map(t => t.name).sort()
  const missing = code.filter(n => !listed.includes(n))
  const stale = listed.filter(n => !code.includes(n))
  if (missing.length || stale.length) {
    fail('lhm.plugin.json', `Tool list out of date (missing: ${missing.join(', ') || 'none'}; no longer exist: ${stale.join(', ') || 'none'}). `
      + 'Run: node .github/scripts/listings.mjs tools <url>/.well-known/mcp/server-card.json')
  }

  if (!process.exitCode) console.log(`Listings agree: version ${expected}, ${code.length} tools.`)
}

function setVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    fail('package.json', `Usage: listings.mjs version X.Y.Z (got "${version ?? ''}")`)
    return
  }
  for (const file of VERSIONED) {
    const text = readFileSync(file, 'utf8')
    if (!VERSION_KEY.test(text)) fail(file, 'No "version" key to update.')
    else writeFileSync(file, text.replace(VERSION_KEY, `$1${version}$3`))
  }
  if (!process.exitCode) console.log(`Set version ${version} in ${VERSIONED.join(', ')}.`)
}

async function setTools(url) {
  if (!url) {
    fail('lhm.plugin.json', 'Usage: listings.mjs tools <server-card-url>')
    return
  }
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  const card = await response.json()

  const manifest = JSON.parse(readFileSync('lhm.plugin.json', 'utf8'))
  manifest.tools = card.tools.map((tool) => {
    const { $schema: _, ...inputSchema } = tool.inputSchema
    // A token sees one kind's tools only; say which, since the listing shows all.
    const kinds = (tool._meta?.kinds ?? []).map(k => KIND_LABEL[k] ?? k).join(', ')
    return {
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: kinds ? `[${kinds}] ${tool.description}` : tool.description,
      inputSchema,
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
    }
  })
  writeFileSync('lhm.plugin.json', `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`Wrote ${manifest.tools.length} tools to lhm.plugin.json.`)
}

const [command, arg] = process.argv.slice(2)
switch (command) {
  case 'check': check(); break
  case 'version': setVersion(arg); break
  case 'tools': await setTools(arg); break
  default:
    console.error('Usage: listings.mjs check | version X.Y.Z | tools <server-card-url>')
    process.exitCode = 2
}
