// Checks for the builtin-function gate in server/utils/pg-guard.ts: builtins
// that read whole tables, or run SQL text, inside the function, so the plan
// names no relation and the table scope check has nothing to refuse.
//
//   pnpm test:pg-guard
//
// Node loads the .ts modules directly (type stripping, Node >= 22.18). pg-guard
// imports only types and ./sql-refs.ts; `createError` (a Nitro auto-import) is
// reached only on a refusal path these checks do not take.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reachesOutside, readPlan } from '../server/utils/pg-guard.ts'
import { sqlRefs } from '../server/utils/sql-refs.ts'

const functionNamesInText = sql => sqlRefs(sql).calls
const statementRefs = sqlRefs

// Every pg_catalog function in the SQL/XML export family on PostgreSQL 16,
// read from pg_proc. Each reads a table, schema, database or query result.
const XML_EXPORTS = [
  'table_to_xml', 'table_to_xml_and_xmlschema', 'table_to_xmlschema',
  'schema_to_xml', 'schema_to_xml_and_xmlschema', 'schema_to_xmlschema',
  'database_to_xml', 'database_to_xml_and_xmlschema', 'database_to_xmlschema',
  'query_to_xml', 'query_to_xml_and_xmlschema', 'query_to_xmlschema',
  'cursor_to_xml', 'cursor_to_xmlschema',
]

test('every SQL/XML export function is refused', () => {
  for (const name of XML_EXPORTS) assert.equal(reachesOutside(name), true, name)
})

test('builtins that run the SQL text they are given are refused', () => {
  for (const name of ['ts_stat', 'ts_rewrite', 'query_to_xml', 'dblink']) {
    assert.equal(reachesOutside(name), true, name)
  }
})

test('ordinary builtins stay allowed', () => {
  // nextval appears in the plan of any INSERT into a serial column (its
  // default), so refusing it would refuse ordinary writes.
  const ordinary = [
    'count', 'lower', 'to_tsvector', 'jsonb_build_object', 'xmlelement',
    'xmlagg', 'pg_relation_size', 'nextval', 'now', 'coalesce',
  ]
  for (const name of ordinary) assert.equal(reachesOutside(name), false, name)
})

test('the text gate names the call in every unquoted spelling', () => {
  for (const sql of [
    "SELECT table_to_xml('public.users'::regclass, true, false, '')",
    "SELECT pg_catalog.table_to_xml('public.users'::regclass, true, false, '')",
    "select TABLE_TO_XML ('public.users', true, false, '')",
    "SELECT * FROM ts_stat('SELECT to_tsvector(body) FROM public.secret')",
  ]) {
    const names = functionNamesInText(sql)
    assert.ok(names.some(reachesOutside), sql)
  }
})

test('a quoted call is caught in the text and in the plan', () => {
  // EXPLAIN (FORMAT JSON, VERBOSE) of
  //   SELECT "table_to_xml"('public.users'::regclass, true, false, '')
  // The table is a regclass constant, not a scan: no relation in the plan.
  const sql = `SELECT "table_to_xml"('public.users'::regclass, true, false, '')`
  assert.equal(functionNamesInText(sql).some(reachesOutside), true)

  const facts = readPlan([{
    Plan: {
      'Node Type': 'Result',
      'Output': [`table_to_xml('users'::regclass, true, false, ''::text)`],
    },
  }])
  assert.deepEqual(facts.relations, [])
  assert.ok(facts.refs.calls.some(reachesOutside))
})

test('a pg_catalog-qualified call in the plan is caught', () => {
  // A same-named function earlier on search_path makes EXPLAIN print the
  // builtin qualified; the statement may have quoted it past the text gate.
  const sql = `SELECT "pg_catalog"."table_to_xml"('public.users'::regclass, true, false, '')`
  assert.equal(functionNamesInText(sql).some(reachesOutside), true)

  const facts = readPlan([{
    Plan: {
      'Node Type': 'Result',
      'Output': [`pg_catalog.table_to_xml('users'::regclass, true, false, ''::text)`],
    },
  }])
  assert.ok(facts.refs.calls.includes('table_to_xml'))
})

test('ts_stat as a Function Scan is caught in the plan', () => {
  const facts = readPlan([{
    Plan: {
      'Node Type': 'Function Scan',
      'Function Name': 'ts_stat',
      'Schema': 'pg_catalog',
      'Function Call': `ts_stat('SELECT to_tsvector(body) FROM public.secret'::text)`,
      'Output': ['word', 'ndoc', 'nentry'],
    },
  }])
  assert.ok(facts.refs.calls.includes('ts_stat'))
  assert.ok(facts.refs.calls.some(reachesOutside))
})

// ---- Tokenizer: every spelling PostgreSQL accepts for a call, operator or cast.

const calls = sql => sqlRefs(sql).calls

test('quoted and schema-qualified quoted calls are collected', () => {
  assert.deepEqual(calls('SELECT "peek"(1)'), ['peek'])
  assert.deepEqual(calls('SELECT zz."peek"(1)'), ['peek'])
  assert.deepEqual(calls('SELECT "zz"."peek" (1)'), ['peek'])
})

test('a quoted mixed-case name keeps its case; an unquoted one folds', () => {
  assert.deepEqual(calls('SELECT "Peek"()'), ['Peek'])
  assert.deepEqual(calls('SELECT PEEK()'), ['peek'])
})

test('a comment between the name and the parenthesis does not hide the call', () => {
  assert.deepEqual(calls('SELECT peek/**/(1)'), ['peek'])
  assert.deepEqual(calls('SELECT peek /* a /* nested */ comment */ (1)'), ['peek'])
  assert.deepEqual(calls('SELECT peek -- line comment\n(1)'), ['peek'])
})

test('names inside strings, dollar quotes and comments are not calls', () => {
  assert.deepEqual(calls("SELECT 'peek(1)', E'it\\'s peek(1)', $$peek(1)$$, $q$peek(1)$q$ -- peek(1)"), [])
  assert.deepEqual(calls('SELECT 1 /* peek(1) */'), [])
})

test('a Unicode-escaped identifier is decoded, and UESCAPE is opaque', () => {
  assert.deepEqual(calls('SELECT U&"\\0070eek"(1)'), ['peek'])
  assert.equal(statementRefs('SELECT U&"!0070eek" UESCAPE \'!\' (1)').opaque, true)
})

test('operators are collected, including OPERATOR(schema.op)', () => {
  assert.deepEqual(statementRefs('SELECT 1 === 2').operators, ['==='])
  assert.ok(statementRefs('SELECT 1 OPERATOR(zz.===) 2').operators.includes('==='))
  // A comment start ends an operator; "--" is not one.
  assert.deepEqual(statementRefs('SELECT 1 +-- c\n 2').operators, ['+'])
})

test('cast target type names are collected as identifiers', () => {
  assert.ok(statementRefs('SELECT 1::mytype').identifiers.includes('mytype'))
  assert.ok(statementRefs('SELECT CAST(1 AS "MyType")').identifiers.includes('MyType'))
})

test('the plan side: a dotted user call in Output is collected', () => {
  // EXPLAIN VERBOSE prints a VOLATILE call outside search_path as zz.peek(1).
  const facts = readPlan([{ Plan: { 'Node Type': 'Result', 'Output': ['zz.peek(1)'] } }])
  assert.ok(facts.refs.calls.includes('peek'))
  const quoted = readPlan([{ Plan: { 'Node Type': 'Result', 'Output': ['zz."Peek"(1)'] } }])
  assert.ok(quoted.refs.calls.includes('Peek'))
})

test('keywords followed by a parenthesis are not calls', () => {
  assert.deepEqual(calls('SELECT * FROM t WHERE a IN (1) AND EXISTS (SELECT 1) AND CAST(x AS int) = 1'), [])
})
