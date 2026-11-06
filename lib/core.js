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

export function redactSecrets(value, secrets) {
  let text = String(value ?? '')
  let shortHits = 0
  for (const secret of secrets ?? []) {
    if (typeof secret !== 'string' || secret.length === 0) continue
    if (!text.includes(secret)) continue
    text = text.split(secret).join('[REDACTED]')
    if (secret.length < SHORT_SECRET_CHARS) shortHits += 1
  }
  if (shortHits > 0) {
    text += `\n[note: ${shortHits} secret${shortHits === 1 ? '' : 's'} under ${SHORT_SECRET_CHARS} characters were redacted by substring match, so unrelated output may be masked too]`
  }
  return text
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
