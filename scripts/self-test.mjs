import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { apply } from '../lib/index.js'
import { clampTimeout, compilePromptPatterns, extractFeedback, isSecretPrompt, promptLine, redactSecrets, validateRules, validateSubmit } from '../lib/core.js'
import { buildEgoScript, clampBrowserTimeout, clampVerifyDelay, validateBrowserFill } from '../lib/browser.js'

class FakeTerminal {
  output = new PassThrough()
  done
  writes = []
  terminated = false
  #resolve

  constructor() {
    this.done = new Promise((resolve) => { this.#resolve = resolve })
  }

  async write(text) {
    if (this.terminated) throw new Error('terminal closed')
    this.writes.push(text)
    this.output.write(`${text.trim()}\r\n`)
    this.output.write('Password changed successfully.\r\n')
    this.output.end()
    this.#resolve({ exitCode: 0, signal: undefined })
  }

  async terminate() {
    if (!this.terminated) {
      this.terminated = true
      this.output.end()
      this.#resolve({ exitCode: 130, signal: 'SIGTERM' })
    }
  }
}

assert.equal(isSecretPrompt("root@host's password: "), true)
assert.equal(isSecretPrompt('[sudo] password for david: '), true)
assert.equal(isSecretPrompt('Retype new password: '), true)
assert.equal(isSecretPrompt('Continue connecting (yes/no)? '), false)
assert.equal(redactSecrets('heard hunter2 then done', ['hunter2']), 'heard [REDACTED] then done')
assert.equal(clampTimeout(900000), 600000)
assert.throws(() => validateSubmit({ callId: 'x', challenge: '1234567890123456', value: '', save: false }))

// Coverage of the prompt nouns real CLIs actually print.
assert.equal(isSecretPrompt('Enter passphrase (empty for no passphrase): '), true, 'ssh-keygen first prompt')
assert.equal(isSecretPrompt('Enter same passphrase again: '), true, 'ssh-keygen confirmation')
assert.equal(isSecretPrompt('Enter PEM pass phrase: '), true, 'openssl PEM wording')
assert.equal(isSecretPrompt('Password (again): '), true, 'parenthesised variant')
assert.equal(isSecretPrompt('PIN code: '), true)
assert.equal(isSecretPrompt('OTP: '), true)
assert.equal(isSecretPrompt('2FA code: '), true)
assert.equal(isSecretPrompt('Auth code: '), true)
assert.equal(isSecretPrompt('One-time password: '), true)
assert.equal(isSecretPrompt('[sudo] password for root@db-primary: '), true)
assert.equal(isSecretPrompt('请输入密码：'), true)
assert.equal(isSecretPrompt('验证码：'), true)

// Nouns that hide inside ordinary words must not spawn a card.
assert.equal(isSecretPrompt('loading spinner: '), false, 'spinner is not pin')
assert.equal(isSecretPrompt('hotspot: '), false, 'hotspot is not otp')
assert.equal(isSecretPrompt('pinned: '), false)
assert.equal(isSecretPrompt('Password: Welcome to Ubuntu'), false, 'trailing output means the CLI is not waiting')

// Operator-supplied patterns extend the built-in set and invalid ones are dropped.
const extraPatterns = compilePromptPatterns(['unlock\\s+phrase', '(', 42, ''])
assert.equal(extraPatterns.length, 1)
assert.equal(isSecretPrompt('Unlock phrase: ', extraPatterns), true)
assert.equal(isSecretPrompt('Unlock phrase: '), false)

// Feedback shown for a retry is whatever printed between the two prompts, minus the prompt.
assert.equal(extractFeedback('Sorry, try again.\nPassword: ', []), 'Sorry, try again.')
assert.equal(extractFeedback('[sudo] Password: ', []), '')
assert.equal(extractFeedback('rejected hunter2\nPassword: ', ['hunter2']), 'rejected [REDACTED]')

// A secret short enough to appear by accident is redacted anyway, and the result says so.
assert.match(redactSecrets('abc then done', ['abc']), /\[REDACTED\][\s\S]*under 4 characters/)
assert.doesNotMatch(redactSecrets('heard hunter2 then done', ['hunter2']), /under 4 characters/)

// A short secret must not be replaced before a longer one that contains it: doing so splits
// the longer value, it stops matching, and half a password survives. This exact ordering
// leak once put `demo-owl-[REDACTED]-PASS-2026` in a reveal result.
assert.equal(
  redactSecrets('ADMIN_USER=admin\nADMIN_PASSWORD=demo-owl-admin-PASS-2026', ['admin', 'demo-owl-admin-PASS-2026']),
  'ADMIN_USER=[REDACTED]\nADMIN_PASSWORD=[REDACTED]',
  'redaction is longest-first',
)

const terminal = new FakeTerminal()
const credentials = new Map()
let registeredRoute
const registeredTools = new Map()
const cleanups = []
const ctx = {
  webServer: { register: (route) => { registeredRoute = route.handler; return () => { registeredRoute = undefined } } },
  tools: { register: (tool) => { registeredTools.set(tool.name, tool); return () => { registeredTools.delete(tool.name) } } },
  subprocess: {
    terminalEnvironment: async () => ({ platform: 'posix', defaultShell: '/bin/sh' }),
    spawnTerminal: async () => {
      setTimeout(() => terminal.output.write("root@host's password: "), 5)
      return terminal
    },
  },
  sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) },
  workingDirectory: { ensure: async () => '/tmp' },
  credentials: { set: async (key, value) => credentials.set(key, value) },
  get: () => undefined,
  effect: (effect) => {
    const cleanup = effect()
    if (typeof cleanup === 'function') cleanups.push(cleanup)
    return { dispose: async () => cleanup?.() }
  },
}

apply(ctx, {})
const secretExec = registeredTools.get('secret_exec')
const secretBrowser = registeredTools.get('secret_browser')
assert.equal(secretExec?.name, 'secret_exec')
assert.equal(secretBrowser?.name, 'secret_browser', 'the browser target registers its own keyed view')
assert.equal(typeof registeredRoute, 'function')
assert.deepEqual(secretExec.output.schema.required, ['status', 'output'])
assert.equal(Object.values(secretExec.output.schema.properties).some((property) => Object.hasOwn(property, 'required')), false)

function responseCapture() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[key] = value },
    end(body) { this.body = body },
  }
}

async function callApi(body, handler = registeredRoute) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
  req.socket = { remoteAddress: '127.0.0.1' }
  req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify(body)) }
  const res = responseCapture()
  await handler(req, res)
  return { ...res, json: JSON.parse(res.body) }
}

const controller = new AbortController()
const running = secretExec.execute({ command: 'ssh root@example.test passwd', prompt: 'Enter the SSH password', label: 'SSH password' }, {
  agent: { session: {} },
  callId: 'self-test-call',
  signal: controller.signal,
})

let state
for (let i = 0; i < 100; i += 1) {
  await new Promise((resolve) => setTimeout(resolve, 5))
  state = (await callApi({ op: 'status', callId: 'self-test-call' })).json
  if (state.state === 'awaiting') break
}
assert.equal(state.state, 'awaiting')
assert.match(state.prompt, /password:/i)

const secret = 'self-test-secret-DO-NOT-LEAK'
const accepted = await callApi({ op: 'submit', callId: 'self-test-call', challenge: state.challenge, value: secret, save: true })
assert.equal(accepted.json.ok, true)
const result = await running
assert.equal(result.status, 'completed')
assert.equal(result.output.includes(secret), false)
assert.equal(terminal.writes.includes(`${secret}\r`), true)
assert.equal(credentials.get(result.vault_ref), secret)
assert.equal(secretExec.output.render({}, result).map((part) => part.text).join('').includes(secret), false)

// A CLI that rejects the first secret and asks again, the way sudo and passwd do.
class RetryTerminal {
  output = new PassThrough()
  writes = []
  terminated = false
  #resolve
  #step = 0

  constructor() {
    this.done = new Promise((resolve) => { this.#resolve = resolve })
  }

  async write(text) {
    if (this.terminated) throw new Error('terminal closed')
    this.writes.push(text)
    this.#step += 1
    if (this.#step === 1) {
      this.output.write('Sorry, try again.\r\n')
      this.output.write('[sudo] Password: ')
      return
    }
    this.output.write('Welcome to staging-01.\r\n')
    this.output.end()
    this.#resolve({ exitCode: 0, signal: undefined })
  }

  async terminate() {
    this.output.end()
    this.#resolve({ exitCode: 130, signal: 'SIGTERM' })
  }
}

const retryTerminal = new RetryTerminal()
let retryRoute
let retryTool
apply({
  ...ctx,
  webServer: { register: (route) => { retryRoute = route.handler; return () => { retryRoute = undefined } } },
  tools: { register: (tool) => { if (tool.name === 'secret_exec') retryTool = tool; return () => {} } },
  subprocess: {
    ...ctx.subprocess,
    spawnTerminal: async () => {
      setTimeout(() => retryTerminal.output.write('[sudo] Password: '), 5)
      return retryTerminal
    },
  },
}, { extraPromptPatterns: ['unlock\\s+phrase'] })

const retryController = new AbortController()
const retryRun = retryTool.execute({ command: 'sudo -v', prompt: 'Authorize sudo', label: 'sudo' }, {
  agent: { session: {} },
  callId: 'retry-call',
  signal: retryController.signal,
})

async function awaitState(callId, handler, predicate) {
  let state
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    state = (await callApi({ op: 'status', callId }, handler)).json
    if (predicate(state)) return state
  }
  return state
}

const first = await awaitState('retry-call', retryRoute, (next) => next.state === 'awaiting')
assert.equal(first.promptNumber, 1)
assert.equal(first.feedback, undefined, 'the first prompt has nothing to report')

await callApi({ op: 'submit', callId: 'retry-call', challenge: first.challenge, value: 'wrong-one', save: false }, retryRoute)

const second = await awaitState('retry-call', retryRoute, (next) => next.state === 'awaiting' && next.promptNumber === 2)
assert.equal(second.state, 'awaiting', 'a rejected secret produces a fresh prompt')
assert.equal(second.promptNumber, 2)
assert.equal(second.feedback, 'Sorry, try again.', 'the CLI rejection reason reaches the card')
assert.notEqual(second.challenge, first.challenge, 'every prompt gets its own challenge')

await callApi({ op: 'submit', callId: 'retry-call', challenge: second.challenge, value: 'right-one', save: false }, retryRoute)
const retryResult = await retryRun
assert.equal(retryResult.status, 'completed')
assert.equal(retryResult.output.includes('wrong-one'), false)
assert.equal(retryResult.output.includes('right-one'), false)
assert.deepEqual(retryTerminal.writes, ['wrong-one\r', 'right-one\r'])

// A CLI that abandons its own prompt, the way sudo does after its internal timeout.
// The card must not outlive the terminal: settling has to follow the exit code, not
// wait out timeout_ms with a dead PTY behind it.
class ExitDuringPromptTerminal {
  output = new PassThrough()
  writes = []
  #resolve

  constructor() {
    this.done = new Promise((resolve) => { this.#resolve = resolve })
  }

  async write(text) {
    this.writes.push(text)
  }

  async terminate() {
    this.output.end()
    this.#resolve({ exitCode: 130, signal: 'SIGTERM' })
  }

  exitWith(code) {
    this.output.end()
    this.#resolve({ exitCode: code, signal: undefined })
  }
}

const abandoningTerminal = new ExitDuringPromptTerminal()
let abandoningRoute
let abandoningTool
apply({
  ...ctx,
  webServer: { register: (route) => { abandoningRoute = route.handler; return () => { abandoningRoute = undefined } } },
  tools: { register: (tool) => { if (tool.name === 'secret_exec') abandoningTool = tool; return () => {} } },
  subprocess: {
    ...ctx.subprocess,
    spawnTerminal: async () => {
      setTimeout(() => {
        abandoningTerminal.output.write('[sudo] Password: ')
        setTimeout(() => abandoningTerminal.exitWith(1), 40)
      }, 5)
      return abandoningTerminal
    },
  },
}, {})

const abandonStarted = Date.now()
const abandonResult = await abandoningTool.execute({ command: 'sudo -v', prompt: 'Authorize sudo', timeout_ms: 60000 }, {
  agent: { session: {} },
  callId: 'abandon-call',
  signal: new AbortController().signal,
})
const abandonElapsed = Date.now() - abandonStarted
assert.equal(abandonResult.status, 'failed', 'the CLI exit code wins over the missing answer')
assert.match(abandonResult.output, /password:/i)
assert.equal(abandoningTerminal.writes.length, 0, 'nothing is injected into a dead terminal')
assert.ok(abandonElapsed < 3000, `settled in ${abandonElapsed}ms instead of waiting out the 60s timeout`)

// --- browser target: several secrets cross through 0600 handoff files ---
const single = validateBrowserFill({ selector: '#password', prompt: 'sign in', url: 'https://example.test/login' })
assert.equal(single.fields.length, 1)
assert.equal(single.fields[0].selector, '#password')
assert.equal(single.space, 'dsh-secret-form')
assert.equal(single.submitSelector, undefined)
assert.throws(() => validateBrowserFill({ prompt: 'x' }), /selector/)
assert.throws(() => validateBrowserFill({ selector: '#p', prompt: 'x', url: 'file:///etc/passwd' }), /http/)

// A password-rename form needs three secrets in one pass.
const multi = validateBrowserFill({
  prompt: 'rename password',
  fields: [
    { selector: 'input[autocomplete="current-password"]', label: 'current' },
    { selector: 'input[autocomplete="new-password"] >> nth=0', label: 'new' },
    { selector: 'input[autocomplete="new-password"] >> nth=1', label: 'confirm' },
  ],
  submit_selector: 'button:has-text("修改密码")',
})
assert.equal(multi.fields.length, 3, 'one card per field')
const perField = validateBrowserFill({
  prompt: 'x',
  fields: [{ selector: '#current' }, { selector: '#next', rules: { minLength: 12 } }],
})
assert.equal(perField.fields[0].rules, undefined, 'a field without rules carries none')
assert.deepEqual(perField.fields[1].rules, { minLength: 12 }, 'a field keeps its own policy')
assert.equal(multi.fields[1].selector, 'input[autocomplete="new-password"] >> nth=0')
assert.equal(multi.fields[2].label, 'confirm')
assert.equal(multi.submitSelector, 'button:has-text("修改密码")')
assert.throws(() => validateBrowserFill({ prompt: 'x', fields: [] }), /fields/)
assert.throws(() => validateBrowserFill({ prompt: 'x', fields: [{ selector: '' }] }), /selector/)

assert.equal(clampBrowserTimeout(999999), 120000)
assert.equal(clampBrowserTimeout(undefined), 45000)
assert.equal(clampVerifyDelay(undefined), 1200, 'default read-back wait')
assert.equal(clampVerifyDelay(0), 0, 'a zero wait is legal')
assert.equal(clampVerifyDelay(99999), 15000, 'capped')
assert.throws(() => clampVerifyDelay(-1), /verify_delay_ms/)

const script = buildEgoScript({
  space: '42',
  url: 'https://example.test/login',
  fields: multi.fields,
  submitSelector: 'button:has-text("修改密码")',
  secretPaths: ['/tmp/.dsh-a', '/tmp/.dsh-b', '/tmp/.dsh-c'],
  timeoutMs: 30000,
})
assert.match(script, /taskSpace\(42\)/, 'a numeric space resumes by id')
assert.match(script, /\.dsh-a/)
assert.match(script, /\.dsh-c/, 'every field has its own handoff file')
assert.match(script, /fs\.unlink/, 'the script deletes each handoff file itself')
assert.match(script, /SUBMITTED/, 'the submit step is scripted')
assert.doesNotMatch(script, /hunter2/, 'no secret is embedded in the generated script')
assert.equal((script.match(/SECRET_UNREADABLE/g) || []).length, 3, 'each read is guarded')

// verify_selector must mean the same thing on both engines
const withVerify = buildEgoScript({
  space: '42',
  fields: [{ selector: '#cur' }],
  submitSelector: '#go',
  verifySelector: '#result',
  verifyDelayMs: 400,
  secretPaths: ['/tmp/a'],
  timeoutMs: 8000,
})
assert.match(withVerify, /VERIFIED/, 'ego reports the page back')
assert.match(withVerify, /#result/)
assert.match(withVerify, /400/, 'the configured delay lands in the script')

const withoutVerify = buildEgoScript({ space: '42', fields: [{ selector: '#cur' }], secretPaths: ['/tmp/a'], timeoutMs: 8000 })
assert.doesNotMatch(withoutVerify, /VERIFIED/, 'no verify selector means no read-back')

const named = buildEgoScript({ space: 'my space', fields: [{ selector: '#pin' }], secretPaths: ['/tmp/x'], timeoutMs: 5000 })
assert.match(named, /taskSpace\("my space"\)/, 'a named space resumes by name')
assert.doesNotMatch(named, /page\.goto/, 'omitting url keeps the current page')
assert.doesNotMatch(named, /page\.click/, 'omitting submit_selector never clicks')

// --- rules, prompt extraction, and the autocomplete contract ---
assert.deepEqual(validateRules({ minLength: 12, requireDigit: true }), { minLength: 12, requireDigit: true })
assert.deepEqual(validateRules({ requireSymbol: false }), { requireSymbol: false }, 'explicit false is a rule, not an omission')
assert.equal(validateRules({}), undefined, 'an empty rule set means no policy')
assert.equal(validateRules(undefined), undefined)
assert.throws(() => validateRules({ minLength: -1 }), /minLength/)
assert.throws(() => validateRules({ requireDigit: 'yes' }), /requireDigit/)
assert.throws(() => validateRules([]), /rules must be an object/)

// the card must show the one line the CLI waits on, not the tail of its noise
assert.equal(promptLine('bind [127.0.0.1]:3000: Address already in use\nNew password: '), 'New password:')
assert.equal(promptLine('\u001b[1;33m[sudo] password for davidzhao:\u001b[0m '), '[sudo] password for davidzhao:')
assert.match(promptLine('nothing prompt-like here'), /nothing prompt-like here/, 'fall back to normalized tail')

const acSchema = secretExec.parameters.properties.autocomplete
assert.ok(acSchema, 'secret_exec advertises autocomplete')
assert.deepEqual(acSchema.enum, ['current-password', 'new-password', 'one-time-code', 'off'])
const acSchema2 = secretBrowser.parameters.properties.autocomplete
assert.ok(acSchema2, 'secret_browser advertises autocomplete too')
assert.ok(secretExec.parameters.properties.rules, 'secret_exec advertises rules')
assert.ok(secretBrowser.parameters.properties.rules, 'secret_browser advertises rules')

// --- carrier admission: the shape of the call is part of the contract ---
// ConnectionTrustRequest is `{ headers }` and the answer is a bare 401|403|undefined.
// Getting either wrong throws inside the handler's try/catch, which silently turns the
// check into a no-op — exactly the bug this test exists to prevent.
async function probeCarrier(connection) {
  let seen
  const routes = []
  apply({
    ...ctx,
    webServer: { register: (route) => { routes.push(route.handler); return () => {} } },
    tools: { register: () => () => {} },
    get: (key) => (key === 'connection' ? connection : undefined),
  }, {})
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
  req.socket = { remoteAddress: '127.0.0.1' }
  req[Symbol.asyncIterator] = async function* () { yield Buffer.from(JSON.stringify({ op: 'status', callId: 'nope' })) }
  const res = responseCapture()
  await routes[0](req, res)
  return { status: res.statusCode, seen }
}
const carrierAbsent = await probeCarrier(undefined)
assert.equal(carrierAbsent.status, 404, 'no connection means the route still works')
const carrierAccept = await probeCarrier({ requestRejection: () => undefined })
assert.equal(carrierAccept.status, 404, 'an accepting carrier lets the request through')
const carrierReject = await probeCarrier({ requestRejection: () => 401 })
assert.equal(carrierReject.status, 401, 'a rejecting carrier blocks the request')
const carrierThrow = await probeCarrier({ requestRejection: () => { throw new Error('boom') } })
assert.equal(carrierThrow.status, 404, 'a throwing carrier must not break the route')
let carrierArg
await probeCarrier({ requestRejection: (arg) => { carrierArg = arg; return undefined } })
assert.deepEqual(Object.keys(carrierArg ?? {}), ['headers'], 'the carrier receives { headers }, not raw headers')

// --- failure modes stay distinguishable ---
async function rawCall(payload) {
  const req = new EventEmitter()
  req.method = 'POST'
  req.headers = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
  req.socket = { remoteAddress: '127.0.0.1' }
  req[Symbol.asyncIterator] = async function* () { yield Buffer.from(payload) }
  const res = responseCapture()
  await registeredRoute(req, res)
  return res
}
const badJson = await rawCall('{not json')
assert.equal(badJson.statusCode, 400, 'malformed JSON is a client error')
const oversized = await rawCall('{"pad":"' + 'x'.repeat(20000) + '"}')
assert.equal(oversized.statusCode, 413, 'an oversized body is its own status, not a generic 400')

// --- hard limits stay hard ---
assert.doesNotThrow(() => validateBrowserFill({ prompt: 'x', fields: Array.from({ length: 12 }, (_, i) => ({ selector: `#f${i}` })) }))
assert.throws(() => validateBrowserFill({ prompt: 'x', fields: Array.from({ length: 13 }, (_, i) => ({ selector: `#f${i}` })) }), /at most 12/)
assert.throws(() => validateBrowserFill({ prompt: 'x', selector: 'a'.repeat(501) }), /selector/)
for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'ftp://a.test']) {
  assert.throws(() => validateBrowserFill({ prompt: 'x', selector: '#p', url: bad }), /http/i, `${bad} must be refused`)
}
assert.ok(validateBrowserFill({ prompt: 'x', selector: '#p', url: 'https://a.test/x' }), 'http(s) urls pass')

// A login form has a credential field and an account field. Showing password strength for
// the account name was a real bug; the inference decides from the selector, and an explicit
// flag always wins.
const loginPlan = validateBrowserFill({
  prompt: 'x',
  fields: [{ selector: '#login_field', label: '账号' }, { selector: '#password', label: '密码' }],
})
assert.equal(loginPlan.fields[0].secret, false, 'an account field is not a credential')
assert.equal(loginPlan.fields[1].secret, true, 'a password field is')
assert.equal(validateBrowserFill({ prompt: 'x', fields: [{ selector: '#f', secret: false, rules: { minLength: 8 } }] }).fields[0].secret, false, 'an explicit flag beats a rule')
assert.equal(validateBrowserFill({ prompt: 'x', fields: [{ selector: 'input[autocomplete="username"]' }] }).fields[0].secret, false)
assert.equal(validateBrowserFill({ prompt: 'x', fields: [{ selector: 'input[name="otp"]' }] }).fields[0].secret, true)
assert.equal(validateBrowserFill({ prompt: 'x', selector: 'input[name="password"]' }).fields[0].secret, true)


// --- secret_reveal: the value reaches the card, never the tool result ---
const revealTool = registeredTools.get('secret_reveal')
assert.equal(revealTool?.name, 'secret_reveal')

class RevealTerminal {
  output = new PassThrough()
  writes = []
  terminated = false
  done
  finish

  constructor() {
    this.done = new Promise((resolve) => { this.finish = resolve })
  }

  async write(text) { this.writes.push(text) }

  async terminate() { this.terminated = true }
}

const REVEAL_ENV = [
  'NODE_ENV=production',
  'PORT=3000',
  'ADMIN_PASSWORD=owl-admin-DO-NOT-LEAK',
  `JWT_SECRET=${'a1b2c3d4'.repeat(8)}`,
].join('\n') + '\n'

const defaultSpawn = ctx.subprocess.spawnTerminal
ctx.subprocess.spawnTerminal = async () => {
  const fake = new RevealTerminal()
  setTimeout(() => {
    fake.output.write(REVEAL_ENV)
    fake.output.end()
    fake.finish({ exitCode: 0, signal: undefined })
  }, 5)
  return fake
}

async function waitForReveal(callId) {
  for (let i = 0; i < 100; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5))
    const state = (await callApi({ op: 'status', callId })).json
    if (state.state === 'awaiting' && state.reveal?.entries) return state
  }
  return undefined
}

const revealRun = revealTool.execute({ command: 'cat /opt/app/.env', prompt: 'owl env file', label: 'owl secrets', format: 'dotenv' }, {
  agent: { session: {} },
  callId: 'self-test-reveal',
  signal: new AbortController().signal,
})
const revealed = await waitForReveal('self-test-reveal')
assert.equal(revealed?.state, 'awaiting', 'the card waits for the user instead of collapsing')
assert.equal(revealed.reveal.entries.length, 4)
const adminEntry = revealed.reveal.entries.find((entry) => entry.key === 'ADMIN_PASSWORD')
assert.equal(adminEntry.value, 'owl-admin-DO-NOT-LEAK', 'the card receives the real value')
assert.equal(adminEntry.secret, true, 'a password is masked by name')
assert.equal(revealed.reveal.entries.find((entry) => entry.key === 'PORT').secret, false, 'a port number is not a credential')

// Once the card names the token it already holds, the values stop riding along on the poll.
const seen = (await callApi({ op: 'status', callId: 'self-test-reveal', seenReveal: revealed.reveal.token })).json
assert.equal(seen.reveal.entries, undefined, 'a large reveal is not retransmitted every tick')
assert.equal(seen.reveal.entryCount, 4)

const ack = await callApi({ op: 'reveal-ack', callId: 'self-test-reveal', save: true })
assert.equal(ack.json.ok, true)
const revealResult = await revealRun
assert.equal(revealResult.status, 'completed')
assert.equal(revealResult.revealed, 4)
assert.ok(revealResult.keys.includes('ADMIN_PASSWORD'))
assert.equal(revealResult.output.includes('owl-admin-DO-NOT-LEAK'), false, 'the value must never reach the result')
assert.match(revealResult.output, /ADMIN_PASSWORD=\[REDACTED\]/, 'the model sees the key, not the value')
assert.equal(revealResult.output.includes('PORT=3000'), true, 'a non-secret value stays legible')
assert.equal(revealTool.output.render({}, revealResult).map((part) => part.text).join('').includes('owl-admin-DO-NOT-LEAK'), false)
const savedRefs = [...credentials.entries()].filter(([key]) => key.includes('ADMIN_PASSWORD'))
assert.equal(savedRefs.length, 1, 'only the secret entry is written to the vault')
assert.equal(savedRefs[0][1], 'owl-admin-DO-NOT-LEAK')

// Dismissing the card without confirming cancels the call; the values still never surface.
const cancelRun = revealTool.execute({ command: 'cat /opt/app/.env', prompt: 'owl env file', keys: ['ADMIN_PASSWORD'] }, {
  agent: { session: {} },
  callId: 'self-test-reveal-cancel',
  signal: new AbortController().signal,
})
const cancelState = await waitForReveal('self-test-reveal-cancel')
assert.equal(cancelState.reveal.entries.length, 1, 'the keys filter narrows the card')
assert.equal(cancelState.reveal.entries[0].key, 'ADMIN_PASSWORD')
const cancelled = await callApi({ op: 'reveal-cancel', callId: 'self-test-reveal-cancel' })
assert.equal(cancelled.json.ok, true)
const cancelResult = await cancelRun
assert.equal(cancelResult.status, 'cancelled')
assert.equal(cancelResult.output.includes('owl-admin-DO-NOT-LEAK'), false, 'a cancelled reveal still never leaks')

// An empty result is reported, not guessed at.
ctx.subprocess.spawnTerminal = async () => {
  const fake = new RevealTerminal()
  setTimeout(() => {
    fake.output.write('nothing useful here\n')
    fake.output.end()
    fake.finish({ exitCode: 0, signal: undefined })
  }, 5)
  return fake
}
const emptyResult = await revealTool.execute({ command: 'echo nothing useful here', prompt: 'x', format: 'dotenv' }, {
  agent: { session: {} },
  callId: 'self-test-reveal-empty',
  signal: new AbortController().signal,
})
assert.equal(emptyResult.status, 'completed')
assert.match(emptyResult.output, /found nothing to show/)
ctx.subprocess.spawnTerminal = defaultSpawn

for (const cleanup of cleanups.reverse()) cleanup()
console.log('self-test passed: host receives secret in memory, injects via PTY, redacts output, stores only after opt-in, reports a rejection reason on retry, stops waiting when the CLI exits, and reveals stored secrets without putting a value in the tool result')
