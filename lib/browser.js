import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Ego Lite's Node sandbox exposes node:fs but not outbound sockets: global fetch and
// node:http both hang, so a localhost claim endpoint is not reachable from the script.
// Secrets therefore cross into the browser through 0600 files that the script reads and
// unlinks as its first action. They never appear in argv, in the script text, or in the
// tool result.
export const EGO_BIN = 'ego-browser'
export const MAX_BROWSER_TIMEOUT_MS = 120000
export const MAX_FIELDS = 12

export function clampBrowserTimeout(value, fallback = 45000) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1000) throw new TypeError('timeout_ms must be an integer of at least 1000')
  return Math.min(value, MAX_BROWSER_TIMEOUT_MS)
}

function assertString(value, name, maxLength) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maxLength) {
    throw new TypeError(`${name} must be a non-empty string of at most ${maxLength} characters`)
  }
  return value
}

function optionalString(value, name, maxLength) {
  return typeof value === 'string' && value.trim().length > 0 ? value.slice(0, maxLength) : undefined
}

// A form can need several secrets at once: current password, new password, confirmation.
// Each entry becomes one card, filled into one target field in declaration order.
const PASSWORD_HINT = /(?:password|passwd|passphrase|passcode|pwd|otp|2fa|\bpin\b|secret|token|verification|one[-\s]?time|\bcode\b)/i
const PASSWORD_AUTOCOMPLETE = ['current-password', 'new-password', 'one-time-code']

// Not every field in a login form is a secret: the account name is not. Deciding this from
// the selector is the difference between a masked field with a strength meter and a normal
// text field -- showing "password strength" for an email address is just wrong.
function inferSecretField({ selector, rules, explicit, single, autocomplete }) {
  if (typeof explicit === 'boolean') return explicit
  if (rules !== undefined && rules !== null) return true
  const spec = String(selector ?? '')
  if (/type\s*=\s*["']?password/i.test(spec)) return true
  if (/autocomplete\s*=\s*["']?(?:current-password|new-password|one-time-code)/i.test(spec)) return true
  if (/autocomplete\s*=\s*["']?(?:username|email)/i.test(spec)) return false
  if (PASSWORD_HINT.test(spec)) return true
  // Nothing in the selector to go on: a lone field in a form the caller declared as a
  // password form is treated as one, which is the safe direction.
  return Boolean(single) && PASSWORD_AUTOCOMPLETE.includes(autocomplete)
}

function normalizeFields(args) {
  const single = !Array.isArray(args.fields)
  const autocomplete = typeof args.autocomplete === 'string' ? args.autocomplete : undefined
  if (Array.isArray(args.fields)) {
    if (args.fields.length === 0) throw new TypeError('fields must not be empty')
    if (args.fields.length > MAX_FIELDS) throw new TypeError(`fields accepts at most ${MAX_FIELDS} entries`)
    return args.fields.map((field, index) => {
      if (!field || typeof field !== 'object' || Array.isArray(field)) throw new TypeError(`fields[${index}] must be an object`)
      const selector = assertString(field.selector, `fields[${index}].selector`, 500)
      return {
        selector,
        label: optionalString(field.label, `fields[${index}].label`, 80),
        prompt: optionalString(field.prompt, `fields[${index}].prompt`, 500),
        rules: field.rules,
        // A field backed by a stored credential is filled without a card at all.
        credential: optionalString(field.credential, `fields[${index}].credential`, 200),
        secret: inferSecretField({ selector, rules: field.rules, explicit: field.secret, single: false, autocomplete }),
      }
    })
  }
  const selector = assertString(args.selector, 'selector', 500)
  return [{
    selector,
    label: undefined,
    prompt: undefined,
    rules: undefined,
    credential: undefined,
    secret: inferSecretField({ selector, rules: undefined, explicit: undefined, single: true, autocomplete }),
  }]
}

// How long to wait between clicking submit and reading the page back. Too short and a toast
// has not rendered yet; too long and every call feels stuck.
export function clampVerifyDelay(value, fallback = 1200) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 0) throw new TypeError('verify_delay_ms must be a non-negative integer')
  return Math.min(value, 15000)
}

export function validateBrowserFill(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new TypeError('invalid arguments')
  const fields = normalizeFields(args)
  const prompt = assertString(args.prompt, 'prompt', 1000)
  const url = optionalString(args.url, 'url', 2000)
  const submitSelector = optionalString(args.submit_selector, 'submit_selector', 500)
  const verifySelector = optionalString(args.verify_selector, 'verify_selector', 500)
  const verifyDelayMs = args.verify_delay_ms === undefined ? 1200 : clampVerifyDelay(args.verify_delay_ms)
  const space = optionalString(args.space, 'space', 120) ?? 'dsh-secret-form'
  const engine = args.engine === undefined ? 'dsh' : assertString(args.engine, 'engine', 20)
  if (!['ego', 'dsh'].includes(engine)) throw new TypeError('engine must be "ego" or "dsh"')
  if (url !== undefined && !/^https?:\/\//i.test(url)) throw new TypeError('url must start with http:// or https://')
  return { fields, prompt, url, submitSelector, verifySelector, verifyDelayMs, space, engine }
}

function spaceExpression(space) {
  // A numeric string resumes an existing TaskSpace by id; anything else is a name.
  return /^\d+$/.test(space) ? `await taskSpace(${space})` : `await taskSpace(${JSON.stringify(space)})`
}

export function buildEgoScript({ space, url, fields, submitSelector, verifySelector, verifyDelayMs, secretPaths, timeoutMs }) {
  const resume = spaceExpression(space)
  const navigate = url
    ? `await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded", timeout: ${timeoutMs} })`
    : ''

  const reads = secretPaths.map((path, index) => `let secret${index} = ""
try {
  secret${index} = await fs.readFile(${JSON.stringify(path)}, "utf8")
  await fs.unlink(${JSON.stringify(path)})
} catch (error) {
  console.log("SECRET_UNREADABLE", ${index}, error.code ?? error.message)
  throw error
}`).join('\n')

  const fills = fields.map((field, index) => `await page.waitForSelector(${JSON.stringify(field.selector)}, { timeout: ${timeoutMs} })
await page.fill(${JSON.stringify(field.selector)}, secret${index})
secret${index} = ""
console.log("FILLED", ${index}, ${JSON.stringify(field.selector)})`).join('\n')

  const submit = submitSelector
    ? `\nawait page.click(${JSON.stringify(submitSelector)}, { label: "submit secret form" })\nconsole.log("SUBMITTED", ${JSON.stringify(submitSelector)})`
    : ''

  // Same contract as the sidebar engine: after the click, wait, then report what the page
  // itself says so the caller can tell success from a validation error.
  const verify = verifySelector
    ? `\nawait new Promise((done) => setTimeout(done, ${Number.isInteger(verifyDelayMs) ? verifyDelayMs : 1200}))
const verifyText = await page.evaluate((sel) => {
  const el = document.querySelector(sel)
  return el ? (el.textContent || '').trim().slice(0, 600) : null
}, ${JSON.stringify(verifySelector)})
console.log("VERIFIED", JSON.stringify(verifyText))`
    : ''

  return `
const fs = await import("node:fs/promises")
${reads}
const task = ${resume}
const page = task.page("p1")
${navigate}
${fills}
${submit}
${verify}
console.log("SECRET_FILLED", ${fields.length}, "field(s); space", task.spaceId, "page", page.label)
`
}

export function runEgoScript(script, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(EGO_BIN, ['nodejs'], { stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, output: `Could not start ${EGO_BIN}: ${error.message}` })
      return
    }

    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      finish({ ok: false, output: `Browser automation timed out after ${timeoutMs}ms.\n${stderr.slice(-2000)}` })
    }, timeoutMs + 10000)

    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk.toString('utf8')).slice(-8000) })
    // ego-browser writes console.log output to stderr, so it is the primary channel.
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-8000) })
    child.on('error', (error) => finish({ ok: false, output: `Could not start ${EGO_BIN}: ${error.message}` }))
    child.on('close', (code) => {
      const combined = `${stderr}${stdout}`.trim()
      finish({
        ok: code === 0 && /SECRET_FILLED/.test(combined),
        output: combined || `ego-browser exited with code ${code} and no output`,
      })
    })

    child.stdin.on('error', () => { /* the child may exit before reading stdin */ })
    child.stdin.end(script, 'utf8')
  })
}

export async function fillInBrowser({ space, url, fields, submitSelector, verifySelector, verifyDelayMs, values, timeoutMs }) {
  const secretPaths = []
  try {
    for (let index = 0; index < fields.length; index += 1) {
      const path = join(tmpdir(), `.dsh-secret-browser-${randomBytes(16).toString('hex')}`)
      await writeFile(path, values[index], { mode: 0o600, flag: 'wx' })
      await chmod(path, 0o600).catch(() => {})
      secretPaths.push(path)
    }
    const script = buildEgoScript({ space, url, fields, submitSelector, verifySelector, verifyDelayMs, secretPaths, timeoutMs })
    return await runEgoScript(script, timeoutMs)
  } finally {
    for (const path of secretPaths) await unlink(path).catch(() => {})
  }
}
