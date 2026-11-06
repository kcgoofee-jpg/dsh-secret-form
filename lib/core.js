export const DEFAULT_TIMEOUT_MS = 120000
export const MAX_TIMEOUT_MS = 600000
export const MAX_BODY_BYTES = 16 * 1024
export const MAX_SECRET_CHARS = 4096
export const MAX_EXTRA_PATTERNS = 16
export const SHORT_SECRET_CHARS = 4

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]/g

// Only the two short nouns (`pin`, `otp`) take a leading word boundary, because they
// are the only ones that hide inside ordinary words (`spin:`, `hotspot:`). Long nouns
// keep matching even when a log prefix runs straight into them.
const EN_PROMPT_WORDS = String.raw`(?:password|pass[-\s]?phrase|passcode|\bpin(?:\s+code)?|\botp|2fa\s+code|auth(?:entication)?\s+code|one[-\s]?time\s+(?:password|code)|verification\s+code|security\s+code|access\s+code|unlock\s+code)`

// CJK prompt nouns need no word boundary.
const CN_PROMPT_WORDS = String.raw`(?:密码|验证码|认证码|动态码|口令)`

// Optional decorations that real CLIs insert between the noun and the colon:
// `password for root@host:`, `passphrase (empty for no passphrase):`,
// `password (again):`, `passphrase again:`.
const PROMPT_MODIFIERS = String.raw`(?:\s+for\s+[^:\n]{1,100}?)?(?:\s*\([^)\n]{0,60}\))?(?:\s+again)?`

const PASSWORD_PROMPT = new RegExp(
  String.raw`(?:${EN_PROMPT_WORDS}|${CN_PROMPT_WORDS})${PROMPT_MODIFIERS}\s*[:：]\s*$`,
  'i',
)

export function normalizePromptText(value) {
  return String(value ?? '').replace(ANSI, '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(-300)
}

// The prompt a user should see is the one line the CLI is waiting on, not the tail of
// everything the terminal printed (SSH port-forward warnings, motd, banner noise).
export function promptLine(value, extraPatterns = []) {
  const text = String(value ?? '').replace(ANSI, '')
  const lines = text.split(/[\r\n]+/).map((line) => line.trim()).filter((line) => line.length > 0)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (isSecretPrompt(lines[index], extraPatterns)) return lines[index].slice(-160)
  }
  return normalizePromptText(text).slice(-160)
}

export function compilePromptPatterns(values) {
  if (!Array.isArray(values)) return []
  const patterns = []
  for (const value of values.slice(0, MAX_EXTRA_PATTERNS)) {
    if (typeof value !== 'string') continue
    const source = value.trim()
    if (source.length === 0 || source.length > 400) continue
    try { patterns.push(new RegExp(source, 'i')) } catch { /* an unusable pattern is skipped, never fatal */ }
  }
  return patterns
}

export function isSecretPrompt(value, extraPatterns = []) {
  const text = normalizePromptText(value)
  if (text.length === 0) return false
  if (PASSWORD_PROMPT.test(text)) return true
  for (const pattern of extraPatterns) {
    pattern.lastIndex = 0
    if (pattern.test(text)) return true
  }
  return false
}

const REDACT_MARK = '\u0000'

export function redactSecrets(value, secrets) {
  const text = String(value ?? '')
  // Longest first, and through a placeholder that contains no letters. Replacing a short
  // value first splits a longer value that contains it, so the longer one no longer
  // matches and half of it survives -- which is exactly how a password escaped once.
  const list = [...new Set((secrets ?? []).filter((secret) => typeof secret === 'string' && secret.length > 0))]
  list.sort((left, right) => right.length - left.length)
  let redacted = text
  let shortHits = 0
  for (const secret of list) {
    if (!redacted.includes(secret)) continue
    redacted = redacted.split(secret).join(REDACT_MARK)
    if (secret.length < SHORT_SECRET_CHARS) shortHits += 1
  }
  redacted = redacted.split(REDACT_MARK).join('[REDACTED]')
  if (shortHits > 0) {
    redacted += `\n[note: ${shortHits} secret${shortHits === 1 ? '' : 's'} under ${SHORT_SECRET_CHARS} characters were redacted by substring match, so unrelated output may be masked too]`
  }
  return redacted
}

// Everything printed between the previous injection and the new prompt, minus the
// prompt line itself. Lets the card show why the CLI asked again (e.g. `Sorry, try again.`).
export function extractFeedback(value, secrets = []) {
  const text = redactSecrets(String(value ?? ''), secrets).replace(ANSI, '')
  const lines = text.split(/[\r\n]+/).map((line) => line.trim()).filter((line) => line.length > 0)
  lines.pop()
  return lines.slice(-3).join('\n').slice(0, 400)
}

export function validateRules(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('rules must be an object')
  const rules = {}
  for (const key of ['minLength', 'maxLength']) {
    if (value[key] === undefined) continue
    if (!Number.isInteger(value[key]) || value[key] < 0 || value[key] > 4096) {
      throw new TypeError(`rules.${key} must be an integer between 0 and 4096`)
    }
    rules[key] = value[key]
  }
  for (const key of ['requireLower', 'requireUpper', 'requireDigit', 'requireSymbol']) {
    if (value[key] === undefined) continue
    if (typeof value[key] !== 'boolean') throw new TypeError(`rules.${key} must be a boolean`)
    rules[key] = value[key]
  }
  return Object.keys(rules).length > 0 ? rules : undefined
}

export function validateSubmit(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError('invalid request body')
  if (typeof body.callId !== 'string' || body.callId.length < 1 || body.callId.length > 256) throw new TypeError('invalid callId')
  if (typeof body.challenge !== 'string' || body.challenge.length < 16 || body.challenge.length > 128) throw new TypeError('invalid challenge')
  if (typeof body.value !== 'string' || body.value.length === 0 || body.value.length > MAX_SECRET_CHARS) throw new TypeError('secret must be a non-empty string of at most 4096 characters')
  if (typeof body.save !== 'boolean') throw new TypeError('save must be a boolean')
  return body
}

export function clampTimeout(value, fallback = DEFAULT_TIMEOUT_MS) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1000) throw new TypeError('timeout_ms must be an integer of at least 1000')
  return Math.min(value, MAX_TIMEOUT_MS)
}

export function clampPromptCount(value, fallback = 8) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) throw new TypeError('max_prompt_count must be a positive integer')
  return Math.min(value, 20)
}

export function clampOutputChars(value, fallback = 6000) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 500) throw new TypeError('max_output_chars must be an integer of at least 500')
  return Math.min(value, 20000)
}

export function randomOpaqueId(randomBytes, bytes = 24) {
  return randomBytes(bytes).toString('base64url')
}

export function credentialReference(randomBytes) {
  return `DSH_SECRET_${randomBytes(6).toString('hex').toUpperCase()}`
}

export function takeTail(value, maxChars) {
  const text = String(value ?? '')
  return text.length <= maxChars ? text : `[earlier output omitted]\n${text.slice(-maxChars)}`
}

// ---------------------------------------------------------------------------
// Reveal: turn stdout that already contains secrets into key/value entries the
// card can render. The parsing happens host-side, on the way from the PTY to
// the client, so the model only ever receives the key names and a redacted copy
// of the same output.
// ---------------------------------------------------------------------------

export const MAX_REVEAL_ENTRIES = 80
export const MAX_REVEAL_KEY_CHARS = 80
export const MAX_REVEAL_VALUE_CHARS = 8192
// The card polls for state, so the payload rides along on every poll. A cap keeps a
// pathological file from turning the poll into a bulk transfer.
export const MAX_REVEAL_TOTAL_CHARS = 64 * 1024
export const DEFAULT_REVEAL_TIMEOUT_MS = 300000
export const MAX_REVEAL_TIMEOUT_MS = 900000
export const REVEAL_FORMATS = ['auto', 'dotenv', 'json', 'lines']

const DOTENV_LINE = /^[ \t]*(?:export[ \t]+)?[A-Za-z_][A-Za-z0-9_.-]*[ \t]*=/m
const DOTENV = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)[ \t]*=[ \t]*(.*)$/
const LINE_PAIR = /^([A-Za-z_][A-Za-z0-9_.\- ]{0,48}?)\s*[=:]\s*(.+)$/

// Fail closed: a name that merely *might* hold a secret is masked. Masking a
// public value costs a click; leaving a secret visible costs the secret.
const SECRET_NAME = /(?:pass(?:word|wd|phrase)?|pwd|secret|token|key|cred|auth|private|salt|signature|dsn|cookie|session|bearer|license|webhook|encrypt|jwt|hmac|hash|pin|otp|dsn|account|admin)/i

function looksSecretValue(value) {
  const text = String(value ?? '').trim()
  if (text.length < 8) return false
  // Credentials embedded in a URL are the commonest accidental leak: `proto://user:pass@host`.
  if (/:\/\/[^\s/@:]+:[^\s/@]+@/.test(text)) return true
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) return true
  if (/^[A-Fa-f0-9]{32,}$/.test(text)) return true
  // Long opaque runs (base64/hex/url-safe), but not a sentence: a real one is high-entropy.
  if (/^[A-Za-z0-9+/_=-]{32,}$/.test(text)) {
    const distinct = new Set(text).size
    if (distinct >= 10) return true
  }
  return false
}

function unquote(raw) {
  const text = raw.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  // `KEY=value # note` drops the note; a `#` glued to the value is kept (it is part of the secret).
  const comment = text.search(/\s#/)
  return (comment > 0 ? text.slice(0, comment) : text).trim()
}

function parseDotenvEntries(text) {
  const entries = []
  for (const line of text.split('\n')) {
    const match = DOTENV.exec(line)
    if (!match) continue
    entries.push({ key: match[1], value: unquote(match[2]) })
  }
  return entries
}

function flattenJson(value, prefix, out) {
  if (value === null || value === undefined) return
  if (Array.isArray(value)) {
    value.forEach((item, index) => flattenJson(item, `${prefix}[${index}]`, out))
    return
  }
  if (typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) flattenJson(item, prefix ? `${prefix}.${key}` : key, out)
    return
  }
  out.push({ key: prefix || 'value', value: typeof value === 'string' ? value : JSON.stringify(value) })
}

function parseJsonEntries(text) {
  const entries = []
  let parsed
  try { parsed = JSON.parse(text.trim()) } catch { return entries }
  flattenJson(parsed, '', entries)
  return entries
}

function parseLineEntries(text) {
  const entries = []
  const lines = text.split('\n')
  lines.forEach((raw, index) => {
    const line = raw.trim()
    if (line.length === 0) return
    if (line.startsWith('#') || line.startsWith('//') || line.startsWith(';')) return
    const pair = LINE_PAIR.exec(line)
    if (pair) entries.push({ key: pair[1].trim(), value: pair[2].trim() })
    else entries.push({ key: `line ${index + 1}`, value: line })
  })
  return entries
}

function detectFormat(text) {
  const trimmed = text.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { JSON.parse(trimmed); return 'json' } catch { /* not JSON after all */ }
  }
  if (DOTENV_LINE.test(text)) return 'dotenv'
  return 'lines'
}

export function validateRevealKeys(values) {
  if (values === undefined || values === null) return undefined
  if (!Array.isArray(values)) throw new TypeError('keys must be an array of key names')
  const keys = []
  for (const value of values.slice(0, 60)) {
    if (typeof value !== 'string') throw new TypeError('keys must be an array of key names')
    const key = value.trim()
    if (key.length === 0 || key.length > MAX_REVEAL_KEY_CHARS) continue
    keys.push(key)
  }
  return keys.length > 0 ? keys : undefined
}

export function clampRevealTimeout(value, fallback = DEFAULT_REVEAL_TIMEOUT_MS) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 5000) throw new TypeError('reveal_timeout_ms must be an integer of at least 5000')
  return Math.min(value, MAX_REVEAL_TIMEOUT_MS)
}

// Returns `{ entries, truncated, format }`. Every entry carries `secret` so the
// card knows what to mask, and so the tool result knows what to redact.
export function parseSecretEntries(text, format = 'auto', keyFilter) {
  if (!REVEAL_FORMATS.includes(format)) throw new TypeError(`format must be one of ${REVEAL_FORMATS.join(', ')}`)
  const clean = String(text ?? '').replace(ANSI, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const chosen = format === 'auto' ? detectFormat(clean) : format

  let raw
  if (chosen === 'json') raw = parseJsonEntries(clean)
  else if (chosen === 'dotenv') raw = parseDotenvEntries(clean)
  else raw = parseLineEntries(clean)
  // An empty result is the useful signal, not a reason to guess again: only `auto`
  // gets a second attempt, and only once.
  if (raw.length === 0 && format === 'auto' && chosen !== 'lines') raw = parseLineEntries(clean)

  const wanted = Array.isArray(keyFilter) ? keyFilter.map((key) => key.toLowerCase()) : []
  const seen = new Set()
  const entries = []
  let matched = 0
  let total = 0
  for (const item of raw) {
    const key = String(item.key).slice(0, MAX_REVEAL_KEY_CHARS)
    if (wanted.length > 0 && !wanted.includes(key.toLowerCase())) continue
    const dedupe = key.toLowerCase()
    if (seen.has(dedupe)) continue
    seen.add(dedupe)
    matched += 1
    if (entries.length >= MAX_REVEAL_ENTRIES) continue
    const value = String(item.value ?? '').slice(0, MAX_REVEAL_VALUE_CHARS)
    if (total + value.length > MAX_REVEAL_TOTAL_CHARS) continue
    total += value.length
    entries.push({ key, value, secret: SECRET_NAME.test(key) || looksSecretValue(value) })
  }
  return { entries, truncated: matched > entries.length, format: chosen }
}
