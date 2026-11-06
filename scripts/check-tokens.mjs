#!/usr/bin/env node
// Guards the client stylesheet against design-token drift.
//
// Every custom property the client uses must be defined by the installed DSH build.
// A typo or a removed token silently falls back to the hard-coded default, which is
// exactly how a component stops matching the DSH look, so this check fails loudly instead.
//
// Usage: node scripts/check-tokens.mjs [path/to/app.asar]

import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = resolve(here, '../client.js')
const asarPath = process.argv[2] ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'

// `--dsw-` (design system) and `--dsh-` (host/app) both appear in the shipped stylesheet.
const TOKEN_USE = /var\((--ds[hw]-[a-z0-9-]+)/g

const client = readFileSync(clientPath, 'utf8')
const used = [...new Set([...client.matchAll(TOKEN_USE)].map((match) => match[1]))].sort()

let definitions
try {
  definitions = execFileSync('grep', ['-a', '-oE', '-e', '--ds[hw]-[a-z0-9-]+:', '--', asarPath], {
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
  })
} catch (error) {
  if (error.status === 1) definitions = ''
  else throw error
}

const known = new Set(definitions.split('\n').map((line) => line.replace(/:$/, '')).filter(Boolean))
if (known.size === 0) {
  console.error(`check-tokens: no DSH tokens found in ${asarPath}`)
  process.exit(2)
}

const missing = used.filter((token) => !known.has(token))
const unused = [...known].filter((token) => token.startsWith('--dsw-') && !used.includes(token))

console.log(`check-tokens: ${used.length} used, ${known.size} defined in the installed build`)
if (missing.length > 0) {
  console.error('\nMissing definitions:')
  for (const token of missing) console.error(`  ${token}`)
  console.error('\nThese would fall back to the hard-coded default and drift from the DSH theme.')
  process.exit(1)
}
console.log('check-tokens: every used token is defined ✓')
console.log(`(available but unused: ${unused.length} --dsw-* tokens)`)
