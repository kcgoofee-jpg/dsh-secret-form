#!/usr/bin/env node
// Keeps the README honest: every ```json block must parse and must match the tool schema
// it is an example of. A doc example that cannot be pasted into a tool call is worse than
// no example, so this fails loudly instead of drifting.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { apply } from '../lib/index.js'

const here = dirname(fileURLToPath(import.meta.url))
const DOCS = ['README.md', 'ACCEPTANCE.md']
const blocks = []
for (const doc of DOCS) {
  let md
  try { md = readFileSync(resolve(here, '..', doc), 'utf8') } catch { continue }
  for (const match of md.matchAll(/```json\n([\s\S]*?)```/g)) blocks.push({ doc, raw: match[1] })
}

const registered = new Map()
apply({
  tools: { register: (tool) => { registered.set(tool.name, tool); return () => {} } },
  webServer: { register: () => () => {} },
  subprocess: {},
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
  workingDirectory: {},
  credentials: {},
  effect: (effect) => { effect(); return { dispose: async () => {} } },
  get: () => undefined,
}, {})

const schemas = {
  secret_exec: registered.get('secret_exec').parameters,
  secret_browser: registered.get('secret_browser').parameters,
  secret_reveal: registered.get('secret_reveal').parameters,
}

let failures = 0
blocks.forEach(({ doc, raw }, index) => {
  const label = `${doc} #${index + 1}`
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    console.error(`${label}: invalid JSON — ${error.message}`)
    failures += 1
    return
  }
  const keys = Object.keys(parsed)
  // A fragment (a `rules` object, say) has none of the tool-specific keys. Recognise a whole
  // call by any of them -- checking only for `prompt` would silently skip a block that
  // forgot `prompt`, which is exactly the mistake worth catching.
  const TOOL_KEYS = ['command', 'prompt', 'selector', 'fields', 'engine', 'submit_selector', 'verify_selector', 'format', 'reveal_timeout_ms']
  if (!TOOL_KEYS.some((key) => key in parsed)) {
    console.log(`${label}: skipped (parameter fragment, not a whole call)`)
    return
  }
  // `secret_reveal` also takes `command`, so it has to be recognised before the
  // command-means-exec shortcut, or its examples would be checked against the wrong schema.
  const owner = keys.includes('format') || keys.includes('reveal_timeout_ms')
    ? 'secret_reveal'
    : keys.includes('command')
      ? 'secret_exec'
      : 'secret_browser'
  const schema = schemas[owner]
  const rejected = keys.filter((key) => !schema.properties[key])
  const missing = (schema.required ?? []).filter((key) => !keys.includes(key))
  if (rejected.length > 0) {
    console.error(`${label}: ${owner} does not accept ${rejected.join(', ')}`)
    failures += 1
  }
  if (missing.length > 0) {
    console.error(`${label}: ${owner} requires ${missing.join(', ')}`)
    failures += 1
  }
  if (rejected.length === 0 && missing.length === 0) console.log(`${label}: ok (${owner})`)
})

if (failures > 0) {
  console.error(`\ncheck-readme: ${failures} problem(s)`)
  process.exit(1)
}
console.log(`check-readme: ${blocks.length} example(s) match the shipped schemas`)
