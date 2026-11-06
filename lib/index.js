import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_TIMEOUT_MS,
  MAX_BODY_BYTES,
  REVEAL_FORMATS,
  clampOutputChars,
  clampPromptCount,
  clampRevealTimeout,
  clampTimeout,
  compilePromptPatterns,
  credentialReference,
  extractFeedback,
  isSecretPrompt,
  normalizePromptText,
  parseSecretEntries,
  promptLine,
  randomOpaqueId,
  redactSecrets,
  takeTail,
  validateRevealKeys,
  validateRules,
  validateSubmit,
} from './core.js'
import { clampBrowserTimeout, fillInBrowser, validateBrowserFill } from './browser.js'

export const name = 'dsh-secret-form'
export const inject = ['tools', 'webServer', 'subprocess', 'sandboxPolicy', 'workingDirectory', 'credentials']
// `connection` is optional: when the composition mounts it, its Host/Origin and browser-session
// checks run on top of this plugin's own loopback test.

const API_PATH = '/secret-terminal/api'

// The Web GUI only loads a client bundle at page load, and this build ships no reload
// shortcut, so a changed client.js would otherwise sit unused until the app restarts.
// The host hashes the file it serves and the running client compares: a mismatch means
// the browser half is stale and reloads itself once.
function clientBuild() {
  try {
    return createHash('sha256').update(readFileSync(new URL('../client.js', import.meta.url))).digest('hex').slice(0, 12)
  } catch {
    return undefined
  }
}
const EXECUTION_LIMIT_MS = 10 * 60 * 1000
const SECRET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'output'],
  properties: {
    status: { type: 'string', enum: ['completed', 'cancelled', 'failed'] },
    output: { type: 'string' },
    vault_ref: { type: 'string' },
    // `secret_reveal` reports what it showed by NAME only. The values live in the
    // card and in host memory; they are never part of a tool result.
    keys: { type: 'array', items: { type: 'string' } },
    revealed: { type: 'integer' },
    // `secret_ask` with `deliver: "file"` deliberately hands the model a path so tools
    // like askpass can read the value themselves; the value itself still never appears.
    path: { type: 'string' },
  },
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store, max-age=0')
  res.setHeader('pragma', 'no-cache')
  res.end(JSON.stringify(value))
}

async function readJson(req) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request too large')
    chunks.push(Buffer.from(chunk))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
}

function originAllowed(req) {
  const remote = String(req.socket?.remoteAddress ?? '')
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const host = typeof req.headers.host === 'string' ? req.headers.host : ''
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)
  const origin = req.headers.origin
  if (localHost && (origin === undefined || origin === '' || origin === 'null' || /^app:/i.test(String(origin)))) return loopback
  if (typeof origin !== 'string' || origin.length === 0) return false
  try { return new URL(origin).host === host } catch { return false }
}

function publicState(request) {
  return {
    state: request.state,
    prompt: request.prompt,
    context: request.context,
    label: request.label,
    challenge: request.challenge?.id,
    promptNumber: request.promptNumber,
    attempt: request.attempt,
    maxPromptCount: request.maxPromptCount,
    feedback: request.feedback,
    rules: request.rules,
    autocomplete: request.autocomplete,
    // `false` means this card is not a credential (an email or account name), so the
    // client must not mask it and must not show password-strength feedback for it.
    // Terminal and reveal cards never set it: they are always credentials.
    secret: request.secret,
    // `'vault'` / `'file'` come from `secret_ask`, where the destination is the whole point
    // of the call and is therefore not the user's checkbox to decide.
    ask: request.ask,
    dshFill: request.dshFill,
    reveal: request.reveal,
    message: request.state === 'failed' ? request.publicError : undefined,
  }
}

function createPromptWaiter(request, prompt, feedback, timeoutMs) {
  const challenge = {
    id: randomOpaqueId(randomBytes),
    processing: false,
    resolve: undefined,
    timer: undefined,
  }
  request.challenge = challenge
  request.prompt = prompt
  request.feedback = feedback || undefined
  request.state = 'awaiting'

  return new Promise((resolve) => {
    challenge.resolve = resolve
    challenge.timer = setTimeout(() => {
      if (request.challenge !== challenge) return
      request.challenge = undefined
      request.state = 'cancelled'
      resolve({ cancelled: true, reason: 'timeout' })
    }, timeoutMs)
  })
}

function settledPromise() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

// The reveal card has nothing to type: it waits until the user is done looking.
// Same shape as the prompt waiter so `op: 'cancel'` and an aborted tool call can
// settle either one through `request.challenge` / `request.revealWaiter`.
function createRevealWaiter(request, timeoutMs) {
  const waiter = { resolve: undefined, timer: undefined }
  request.revealWaiter = waiter
  request.state = 'awaiting'
  return new Promise((resolve) => {
    waiter.resolve = (outcome) => {
      clearTimeout(waiter.timer)
      if (request.revealWaiter === waiter) request.revealWaiter = undefined
      resolve(outcome)
    }
    waiter.timer = setTimeout(() => waiter.resolve({ cancelled: true, reason: 'timeout' }), timeoutMs)
  })
}

async function spawnCommand(ctx, owner, command, signal) {
  if (typeof command !== 'string' || command.trim().length === 0 || command.length > 12000 || command.includes('\0')) {
    throw new TypeError('command must be a non-empty command string without NUL bytes (max 12000 characters)')
  }
  const shell = await ctx.subprocess.terminalEnvironment(signal)
  if (!shell?.defaultShell) throw new Error('DSH did not provide a default terminal shell')

  let argv
  if (shell.platform === 'windows') argv = [shell.defaultShell, '/d', '/s', '/c', command]
  else argv = [shell.defaultShell, '-lc', command]

  const policy = ctx.sandboxPolicy.resolve({ session: owner.session })
  if (policy.mode !== 'danger-full-access') {
    const sandbox = ctx.get('sandbox')
    if (!sandbox) throw new Error(`Sandbox provider is unavailable for mode "${policy.mode}"`)
    argv = (await sandbox.confine(argv, { ...policy, mode: policy.mode }, signal)).argv
  }

  const cwd = await ctx.workingDirectory.ensure(owner, signal)
  return await ctx.subprocess.spawnTerminal({
    argv,
    cwd,
    env: { NO_COLOR: '1' },
    rows: 24,
    cols: 100,
    terminalType: 'xterm-256color',
    graceMs: 1500,
    signal,
  })
}

// `secret_ask{deliver:"file"}` exists for tools that insist on reading a file themselves
// (an askpass helper, a client that greps its own config). The directory and file are
// private, and the file is removed on a timer so a forgotten path stops being a secret.
const HANDOFF_DIR = join(tmpdir(), 'dsh-secret-form-handoff')
const HANDOFF_TTL_MS = 20 * 60 * 1000

function waitForOutputOrExit(request, terminal, timeoutMs, signal) {
  if (request.revision !== request.scannedRevision) return Promise.resolve('data')
  if (request.exit !== undefined) return Promise.resolve('exit')
  if (signal?.aborted) return Promise.resolve('abort')

  const gate = settledPromise()
  const finish = (kind) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    terminal.output.off('data', onData)
    terminal.output.off('end', onEnd)
    signal?.removeEventListener('abort', onAbort)
    if (request.wakeWait === wake) request.wakeWait = undefined
    gate.resolve(kind)
  }
  // `end` can be emitted between two registrations, which used to make the loop wait out
  // its full second even though the process was long gone. The exit promise wakes it.
  const wake = () => finish('exit')
  const onData = () => finish('data')
  const onEnd = () => finish('exit')
  const onAbort = () => finish('abort')
  let settled = false
  request.wakeWait = wake
  const timer = setTimeout(() => finish('timeout'), timeoutMs)
  terminal.output.once('data', onData)
  terminal.output.once('end', onEnd)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (request.revision !== request.scannedRevision) finish('data')
  else if (request.exit !== undefined) finish('exit')
  else if (signal?.aborted) finish('abort')
  return gate.promise
}

async function writeHandoffFile(value) {
  await mkdir(HANDOFF_DIR, { recursive: true, mode: 0o700 })
  await chmod(HANDOFF_DIR, 0o700).catch(() => { /* best effort on exotic filesystems */ })
  const path = join(HANDOFF_DIR, `secret-${randomBytes(16).toString('hex')}`)
  await writeFile(path, value, { mode: 0o600, flag: 'wx' })
  await chmod(path, 0o600).catch(() => { /* the mode is already 0600 from create */ })
  const timer = setTimeout(() => { void unlink(path).catch(() => {}) }, HANDOFF_TTL_MS)
  timer.unref?.()
  return path
}

export function apply(ctx, config = {}) {
  const timeoutDefault = clampTimeout(config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const maxPromptCount = clampPromptCount(config.maxPromptCount)
  const maxOutputChars = clampOutputChars(config.maxOutputChars)
  const extraPromptPatterns = compilePromptPatterns(config.extraPromptPatterns)
  const build = clientBuild()
  const requests = new Map()
  const activeTerminals = new Set()
  let disposing = false
  let latestProbe = null

  // The DSH sidebar browser is an Electron <webview>. Its window is not reachable over CDP,
  // but this plugin's client half shares the page with it, so the value travels host -> client
  // through the same no-store status response the card already polls, and the client calls
  // webview.executeJavaScript itself. Resolution comes back through `op: 'dsh-result'`.
  // SIGTERM reaches the foreground child, not the shell that launched it, so a cancelled
  // command can still run the next statement of its sequence. Ctrl+C goes to the whole
  // foreground process group, which is what actually stops the sequence.
  function interruptTerminal(terminal, alreadyExited = false) {
    if (!terminal) return
    // Ctrl+C only matters while the shell is still alive; writing to a closed pty is noise.
    if (!alreadyExited) {
      try { terminal.write('\u0003') } catch { /* the pty may already be gone */ }
    }
    try { terminal.terminate() } catch { /* already exited */ }
  }

  function hostOf(url) {
    try { return new URL(url).host } catch { return undefined }
  }

  // A stored credential is resolved host-side and written straight into the target. The
  // value is returned to the caller only so it can be pushed into the redaction list.
  async function readCredential(ref) {
    if (typeof ref !== 'string' || ref.length === 0) return undefined
    const service = ctx.get('credentials') ?? ctx.credentials
    if (!service || typeof service.resolve !== 'function') return undefined
    try {
      const resolved = await service.resolve(ref)
      const value = resolved && typeof resolved.value === 'string' ? resolved.value : undefined
      return value && value.length > 0 ? value : undefined
    } catch {
      return undefined
    }
  }

  function fillInSidebar(request, plan, values, timeoutMs) {
    return new Promise((resolve) => {
      const token = randomOpaqueId(randomBytes)
      const timer = setTimeout(() => {
        request.dshFill = undefined
        request.dshResolve = undefined
        resolve({ ok: false, output: `The DSH sidebar browser did not report back within ${timeoutMs}ms.` })
      }, timeoutMs)
      request.dshResolve = (outcome) => {
        clearTimeout(timer)
        const verified = outcome.verifyText ? `\n[page says] ${outcome.verifyText}` : ''
        const diagnostic = outcome.ok || !latestProbe
          ? ''
          : `\n[sidebar] ${latestProbe.views?.length ?? 0} webview(s) open: ${(latestProbe.views ?? []).map((view) => view.src || 'about:blank').slice(0, 4).join(' | ')}`
        resolve({
          ok: outcome.ok,
          output: outcome.ok
            ? `Filled ${plan.fields.length} field(s) in the DSH sidebar browser${plan.submitSelector ? ' and clicked submit' : ''}.${verified}`
            : `DSH sidebar fill failed: ${outcome.detail || 'unknown reason'}${verified}${diagnostic}`,
        })
      }
      request.dshFill = {
        token,
        fields: plan.fields.map((field) => ({ selector: field.selector })),
        values: [...values],
        // Bind to the panel showing this HOST, not this exact route: an SPA navigation inside
        // the same site must not silently widen the target to every open tab.
        match: plan.url ? hostOf(plan.url) : undefined,
        submitSelector: plan.submitSelector,
        verifySelector: plan.verifySelector,
        verifyDelayMs: plan.verifyDelayMs,
      }
    })
  }

  const handleRequest = async (req, res) => {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' })
    if (!originAllowed(req)) return sendJson(res, 403, { ok: false, error: 'origin rejected' })
    // Defence in depth: also ask the carrier, which additionally verifies the signed browser
    // credential. Absent in compositions that do not mount `connection`.
    const connection = ctx.get('connection')
    if (connection && typeof connection.requestRejection === 'function') {
      // ConnectionTrustRequest is `{ headers }`, and the answer is a bare 401 | 403 | undefined.
      let rejection
      try { rejection = connection.requestRejection({ headers: req.headers }) } catch { rejection = undefined }
      if (rejection) return sendJson(res, rejection, { ok: false, error: 'origin rejected' })
    }

    let body
    try {
      body = await readJson(req)
    } catch (error) {
      // Size and syntax are different failures for the caller: one is retryable with a smaller
      // body, the other never is. Collapsing them lost that distinction.
      const tooLarge = /too large/i.test(String(error?.message ?? ''))
      return sendJson(res, tooLarge ? 413 : 400, { ok: false, error: tooLarge ? 'request too large' : 'invalid request' })
    }

    // The client reports what the sidebar browser element is. No secret is involved, so
    // this needs no call id: it is a pure capability report kept for the next tool result.
    if (body.op === 'probe') {
      latestProbe = body.payload && typeof body.payload === 'object' ? { ...body.payload, receivedAt: Date.now() } : null
      // Answering the probe is the cheapest way to tell the page which client.js this host
      // is serving; no extra request, no extra timer.
      return sendJson(res, 200, { ok: true, build })
    }

    const callId = typeof body.callId === 'string' ? body.callId : ''
    const request = requests.get(callId)
    if (!request) return sendJson(res, 404, { ok: false, error: 'request unavailable' })

    if (body.op === 'status') {
      const state = publicState(request)
      // The card needs the values once. Later polls name the token they already hold, so
      // a full reveal is not retransmitted on every tick.
      if (request.reveal && state.reveal && body.seenReveal === request.reveal.token) {
        state.reveal = { ...state.reveal, entries: undefined, entryCount: request.reveal.entries.length }
      }
      return sendJson(res, 200, { ok: true, ...state })
    }

    // The sidebar browser is an Electron <webview>, and this plugin's client half runs in
    // the same page. The client performs the injection and reports back here, which is the
    // only way a secret reaches that panel without a CDP endpoint existing.
    if (body.op === 'dsh-result') {
      const settle = request.dshResolve
      request.dshFill = undefined
      request.dshResolve = undefined
      if (settle) {
        settle({
          ok: body.ok === true,
          detail: typeof body.detail === 'string' ? body.detail.slice(0, 500) : '',
          verifyText: typeof body.verifyText === 'string' ? body.verifyText.slice(0, 600) : '',
        })
      }
      return sendJson(res, 200, { ok: true })
    }
    if (body.op === 'cancel') {
      request.userCancelled = true
      if (request.challenge) {
        const challenge = request.challenge
        clearTimeout(challenge.timer)
        request.challenge = undefined
        request.state = 'cancelled'
        challenge.resolve({ cancelled: true, reason: 'user' })
      }
      // Closing the reveal card is a cancellation only when the user dismisses it
      // without confirming; the explicit `reveal-ack` below is the confirming path.
      if (request.revealWaiter) {
        request.state = 'cancelled'
        request.revealWaiter.resolve({ cancelled: true, reason: 'user' })
      }
      return sendJson(res, 200, { ok: true })
    }
    // The user closed the reveal card. `save` means "also write these into the DSH
    // credential vault", exactly like the checkbox on the input card.
    if (body.op === 'reveal-ack' || body.op === 'reveal-cancel') {
      const waiter = request.revealWaiter
      if (!waiter || !request.reveal) return sendJson(res, 409, { ok: false, error: 'reveal card is no longer active' })
      if (body.save !== undefined && typeof body.save !== 'boolean') return sendJson(res, 400, { ok: false, error: 'save must be a boolean' })
      request.reveal = undefined
      if (body.op === 'reveal-cancel') {
        request.state = 'cancelled'
        waiter.resolve({ cancelled: true, reason: 'user' })
      } else {
        request.state = 'completed'
        waiter.resolve({ closed: true, save: body.save === true })
      }
      return sendJson(res, 200, { ok: true })
    }
    if (body.op !== 'submit') return sendJson(res, 400, { ok: false, error: 'unknown operation' })

    try {
      validateSubmit(body)
    } catch (error) {
      return sendJson(res, 400, { ok: false, error: String(error?.message ?? 'invalid secret submission').slice(0, 200) })
    }
    const challenge = request.challenge
    if (!challenge || challenge.id !== body.challenge || challenge.processing || request.state !== 'awaiting') {
      return sendJson(res, 409, { ok: false, error: 'input request is no longer active' })
    }
    challenge.processing = true

    let vaultRef
    // `secret_ask` fixes the destination up front: the checkbox is hidden there, so the
    // host enforces it instead of trusting a flag the card did not render.
    const mustSave = request.ask === undefined ? body.save : request.ask === 'vault'
    if (mustSave) {
      try {
        // A multi-field form stores one reference per field; a single field keeps the plain name.
        const base = request.vaultRef ?? credentialReference(randomBytes)
        vaultRef = request.totalFields > 1 ? `${base}_${request.promptNumber}` : base
        await ctx.credentials.set(vaultRef, body.value)
        request.vaultRef = base
      } catch {
        challenge.processing = false
        return sendJson(res, 500, { ok: false, error: 'Could not save to the DSH credential vault. The value was not submitted.' })
      }
    }

    request.secrets.push(body.value)
    clearTimeout(challenge.timer)
    request.challenge = undefined
    request.feedback = undefined
    request.state = 'running'
    challenge.resolve({ value: body.value, vaultRef })
    return sendJson(res, 200, { ok: true, saved: Boolean(vaultRef), vaultRef })
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API_PATH, handler: handleRequest }))

  // One loop serves every tool that parks a secret in a live target: it watches the PTY,
  // turns a recognized prompt into a card, and writes the answer back. `secret_exec` and
  // `secret_reveal` differ only in what they do with the output once the command is done.
  async function runPtyProcess(request, command, timeoutMs, exec) {
    if (disposing) return { status: 'cancelled', output: '插件正在卸载。' }
    request.state = 'running'
    const terminal = await spawnCommand(ctx, request.owner, command, exec.signal)
    request.terminal = terminal
    activeTerminals.add(terminal)
    terminal.output.on('error', () => { /* a closed pty must not crash the plugin */ })
    terminal.output.on('data', (chunk) => {
      const text = Buffer.from(chunk).toString('utf8')
      request.rawOutput = takeTail(request.rawOutput + text, 100000)
      request.scanOutput = takeTail(request.scanOutput + text, 2000)
      request.revision += 1
    })
    // A CLI can give up on its own password prompt before the user types: sudo does
    // exactly this after its own timeout. Once the PTY is gone nobody will ever read
    // the answer, so settle the pending card immediately instead of waiting out
    // timeout_ms and leaving the user staring at a form with no live terminal behind it.
    const settlePendingPrompt = () => {
      const pending = request.challenge
      if (!pending) return
      clearTimeout(pending.timer)
      request.challenge = undefined
      request.state = 'cancelled'
      pending.resolve({ cancelled: true, reason: 'exit' })
    }
    terminal.done.then((result) => {
      request.exit = result
      settlePendingPrompt()
      request.wakeWait?.()
    }, (error) => {
      request.exit = { error }
      settlePendingPrompt()
      request.wakeWait?.()
    })

    const runDeadline = Date.now() + EXECUTION_LIMIT_MS
    for (;;) {
      if (exec.signal?.aborted || request.userCancelled) {
        request.state = 'cancelled'
        await Promise.resolve(interruptTerminal(terminal))
        return { status: 'cancelled', output: redactSecrets(request.rawOutput, request.secrets).slice(-maxOutputChars) }
      }
      if (request.exit !== undefined) break

      const promptText = normalizePromptText(request.scanOutput)
      request.scannedRevision = request.revision
      if (isSecretPrompt(promptText, extraPromptPatterns)) {
        const shown = promptLine(request.scanOutput, extraPromptPatterns)
        const feedback = request.promptNumber === 0 ? '' : extractFeedback(request.scanOutput, request.secrets)
        request.scanOutput = ''
        if (request.promptNumber >= maxPromptCount) {
          request.publicError = '密码提示次数过多，已停止。'
          request.state = 'failed'
          await Promise.resolve(interruptTerminal(terminal))
          return { status: 'failed', output: `${redactSecrets(request.rawOutput, request.secrets).slice(-maxOutputChars)}\n${request.publicError}` }
        }

        request.promptNumber += 1
        // A terminal prompt is a retry of the same thing; a browser field is a different
        // thing. The card needs to tell them apart, so the two counters stay separate.
        request.attempt = request.promptNumber
        // A stored credential is tried exactly once: if the CLI rejects it, the next prompt
        // has to reach the user rather than replaying the same value.
        if (request.credential && !request.credentialUsed) {
          request.credentialUsed = true
          const stored = await readCredential(request.credential)
          if (stored !== undefined) {
            request.secrets.push(stored)
            try {
              await terminal.write(`${stored}\r`)
            } catch {
              request.state = 'failed'
              await Promise.resolve(interruptTerminal(terminal))
              return { status: 'failed', output: '终端在写入前已关闭。' }
            }
            continue
          }
        }
        const submitted = await createPromptWaiter(request, shown, feedback, timeoutMs)
        if (submitted.cancelled) {
          // The CLI closed its own prompt: fall through to the normal exit-code
          // handling so the result reflects what the command actually returned.
          if (submitted.reason === 'exit') continue
          request.state = 'cancelled'
          await Promise.resolve(interruptTerminal(terminal))
          const reason = submitted.reason === 'timeout' ? '等待输入超时。' : '已取消输入。'
          return { status: 'cancelled', output: `${redactSecrets(request.rawOutput, request.secrets).slice(-maxOutputChars)}\n${reason}` }
        }

        request.secrets.push(submitted.value)
        try {
          await terminal.write(`${submitted.value}\r`)
          submitted.value = ''
        } catch {
          request.state = 'failed'
          await Promise.resolve(interruptTerminal(terminal))
          return { status: 'failed', output: '终端在写入前已关闭。' }
        }
        continue
      }

      const remaining = runDeadline - Date.now()
      if (remaining <= 0) {
        request.publicError = '执行超过 10 分钟，已终止。'
        request.state = 'failed'
        await Promise.resolve(interruptTerminal(terminal))
        return { status: 'failed', output: `${redactSecrets(request.rawOutput, request.secrets).slice(-maxOutputChars)}\n${request.publicError}` }
      }
      const signal = await waitForOutputOrExit(request, terminal, Math.min(remaining, 1000), exec.signal)
      if (signal === 'timeout') continue
    }

    const exitCode = request.exit?.exitCode
    const status = request.exit?.error || exitCode !== 0 ? 'failed' : 'completed'
    request.state = status
    const exit = request.exit?.error ? '[terminal failed]' : `[exit code: ${exitCode ?? 'unknown'}${request.exit?.signal ? `, signal: ${request.exit.signal}` : ''}]`
    const body = redactSecrets(request.rawOutput, request.secrets).slice(-maxOutputChars)
    return { status, output: `${body ? `${body}${body.endsWith('\n') ? '' : '\n'}` : ''}${exit}` }
  }

  ctx.tools.register({
    name: 'secret_exec',
    description: 'Run one command in a private PTY. A recognizable password, passphrase, or verification-code prompt becomes a secure card for the user, and the result never contains the value. Never put a secret in `command`. Covers ssh, sudo, passwd, ssh-keygen, openssl, htpasswd, zip, and database clients asking for a password.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'prompt'],
      properties: {
        command: { type: 'string', description: 'Command to execute. Must not contain passwords, tokens, or any other secret.' },
        prompt: { type: 'string', description: 'Short context shown to the user before each recognized secret prompt.' },
        autocomplete: {
          type: 'string',
          enum: ['current-password', 'new-password', 'one-time-code', 'off'],
          description: 'What password managers should assume: current-password for a login, new-password for a form that creates one, one-time-code for an OTP.',
        },
        rules: {
          type: 'object',
          additionalProperties: false,
          description: 'Password policy the card checks live while the user types. Read it off the page when the form states one.',
          properties: {
            minLength: { type: 'integer', description: 'Minimum character count.' },
            maxLength: { type: 'integer', description: 'Maximum character count.' },
            requireLower: { type: 'boolean', description: 'Require at least one lowercase letter.' },
            requireUpper: { type: 'boolean', description: 'Require at least one uppercase letter.' },
            requireDigit: { type: 'boolean', description: 'Require at least one digit.' },
            requireSymbol: { type: 'boolean', description: 'Require at least one non-alphanumeric character.' },
          },
        },
        label: { type: 'string', description: 'Card title, for example "SSH password".' },
        credential: { type: 'string', description: 'Reference of an already stored credential, for example "TAVILY_API_KEY" or a DSH_SECRET_… reference. When the command asks for a password, the stored value is written instead of opening a card; if it is rejected, the next prompt goes to the user.' },
        timeout_ms: { type: 'integer', description: 'How long to wait for each user entry, default 120000 and capped at 600000.' },
      },
    },
    output: {
      schema: SECRET_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `secret_exec ${value.status}\n${value.output}${value.vault_ref ? `\nSaved in DSH Vault as ${value.vault_ref}` : ''}` }],
    },
    async execute(args, exec) {
      const owner = exec.agent
      if (!owner || typeof owner !== 'object') throw new Error('secret_exec must run from a live agent')
      const callId = String(exec.callId ?? '')
      if (!callId) throw new Error('DSH did not provide a tool call id')
      if (requests.has(callId)) throw new Error('Duplicate secret_exec call id')
      const timeoutMs = clampTimeout(args.timeout_ms, timeoutDefault)
      const request = {
        callId,
        owner,
        state: 'starting',
        label: String(args.label ?? '安全输入').slice(0, 120),
        context: String(args.prompt ?? '').trim().slice(0, 1000),
        prompt: '',
        challenge: undefined,
        promptNumber: 0,
        maxPromptCount,
        totalFields: 1,
        rules: validateRules(args.rules),
        autocomplete: typeof args.autocomplete === 'string' ? args.autocomplete : undefined,
        feedback: undefined,
        rawOutput: '',
        scanOutput: '',
        revision: 0,
        scannedRevision: 0,
        exit: undefined,
        secrets: [],
        vaultRef: undefined,
        userCancelled: false,
        publicError: undefined,
        terminal: undefined,
        attempt: 0,
        credential: typeof args.credential === 'string' && args.credential.trim().length > 0 ? args.credential.trim() : undefined,
        credentialUsed: false,
      }
      requests.set(callId, request)

      const abort = () => {
        request.userCancelled = true
        if (request.challenge) {
          const challenge = request.challenge
          clearTimeout(challenge.timer)
          request.challenge = undefined
          request.state = 'cancelled'
          challenge.resolve({ cancelled: true, reason: 'aborted' })
        }
        try { request.terminal?.terminate() } catch { /* best effort */ }
      }
      exec.signal?.addEventListener('abort', abort, { once: true })

      try {
        const run = await runPtyProcess(request, args.command, timeoutMs, exec)
        return { status: run.status, output: run.output, ...(request.vaultRef ? { vault_ref: request.vaultRef } : {}) }
      } catch (error) {
        const message = redactSecrets(error?.message ?? 'Terminal operation failed.', request.secrets)
        request.publicError = message.slice(0, 300)
        request.state = exec.signal?.aborted ? 'cancelled' : 'failed'
        return { status: request.state, output: request.publicError }
      } finally {
        exec.signal?.removeEventListener('abort', abort)
        if (request.challenge) {
          clearTimeout(request.challenge.timer)
          request.challenge.resolve({ cancelled: true, reason: 'finished' })
        }
        if (request.terminal) {
          activeTerminals.delete(request.terminal)
          interruptTerminal(request.terminal, request.exit !== undefined)
        }
        request.challenge = undefined
        request.prompt = ''
        request.feedback = undefined
        request.rawOutput = ''
        request.scanOutput = ''
        request.secrets.fill('')
        requests.delete(callId)
      }
    },
  })

  ctx.tools.register({
    name: 'secret_reveal',
    description: 'Show the user secrets that already exist somewhere — an env file, a config file, a vault dump, a database row — without the value ever reaching the model. Runs `command` in a private PTY, parses its stdout into key/value entries, and renders them in a card only the user sees; each entry can be revealed and copied individually. The tool result contains key names and a redacted copy of the same output, never a value. Use when the user asks to see credentials that are already stored. Never put a secret in `command`.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command', 'prompt'],
      properties: {
        command: { type: 'string', description: 'Command whose stdout holds the secrets, for example `ssh host "cat /opt/app/.env"`. Must not contain a secret itself.' },
        prompt: { type: 'string', description: 'Context shown above the values in the card.' },
        label: { type: 'string', description: 'Card title, for example "owl server secrets".' },
        format: {
          type: 'string',
          enum: [...REVEAL_FORMATS],
          description: 'How to parse stdout. auto (default) tries JSON, then dotenv, then plain lines; dotenv is KEY=VALUE; json is a flat object; lines is one value per line.',
        },
        keys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only show these key names (case-insensitive). Omit to show everything that parsed.',
        },
        timeout_ms: { type: 'integer', description: 'How long to wait for each terminal password prompt, default 120000 and capped at 600000.' },
        reveal_timeout_ms: { type: 'integer', description: 'How long the card stays open waiting for the user, default 300000 and capped at 900000.' },
      },
    },
    output: {
      schema: SECRET_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `secret_reveal ${value.status}\n${value.output}${value.keys?.length ? `\nShown in the card, by name only: ${value.keys.join(', ')}` : ''}` }],
    },
    async execute(args, exec) {
      const owner = exec.agent
      if (!owner || typeof owner !== 'object') throw new Error('secret_reveal must run from a live agent')
      const callId = String(exec.callId ?? '')
      if (!callId) throw new Error('DSH did not provide a tool call id')
      if (requests.has(callId)) throw new Error('Duplicate secret_reveal call id')
      const timeoutMs = clampTimeout(args.timeout_ms, timeoutDefault)
      const revealTimeoutMs = clampRevealTimeout(args.reveal_timeout_ms)
      const keys = validateRevealKeys(args.keys)
      const format = typeof args.format === 'string' ? args.format : 'auto'
      const request = {
        callId,
        owner,
        state: 'starting',
        label: String(args.label ?? '密钥').slice(0, 120),
        context: String(args.prompt ?? '').trim().slice(0, 1000),
        prompt: '',
        challenge: undefined,
        promptNumber: 0,
        maxPromptCount,
        totalFields: 1,
        rules: undefined,
        autocomplete: undefined,
        feedback: undefined,
        rawOutput: '',
        scanOutput: '',
        revision: 0,
        scannedRevision: 0,
        exit: undefined,
        secrets: [],
        vaultRef: undefined,
        userCancelled: false,
        publicError: undefined,
        terminal: undefined,
        reveal: undefined,
        revealWaiter: undefined,
        attempt: 0,
      }
      requests.set(callId, request)

      const abort = () => {
        request.userCancelled = true
        if (request.challenge) {
          const challenge = request.challenge
          clearTimeout(challenge.timer)
          request.challenge = undefined
          request.state = 'cancelled'
          challenge.resolve({ cancelled: true, reason: 'aborted' })
        }
        if (request.revealWaiter) {
          request.state = 'cancelled'
          request.revealWaiter.resolve({ cancelled: true, reason: 'aborted' })
        }
        try { request.terminal?.terminate() } catch { /* best effort */ }
      }
      exec.signal?.addEventListener('abort', abort, { once: true })

      try {
        const run = await runPtyProcess(request, args.command, timeoutMs, exec)
        if (run.status !== 'completed') return { status: run.status, output: run.output }

        // Parse the raw tail, not `run.output`: that copy already has the typed password
        // replaced and an `[exit code: …]` trailer appended, which would break JSON parsing.
        const parsed = parseSecretEntries(takeTail(request.rawOutput, 100000), format, keys)
        if (parsed.entries.length === 0) {
          request.state = 'completed'
          return { status: 'completed', output: `${run.output}\n[reveal] 没有解析到可展示的条目（${parsed.format}）。` }
        }

        // From here on the values are redacted out of everything the model can see.
        for (const entry of parsed.entries) {
          if (entry.secret) request.secrets.push(entry.value)
        }
        const summary = `[reveal] ${parsed.entries.length} entr${parsed.entries.length === 1 ? 'y' : 'ies'} shown in the card only${parsed.truncated ? ' (some entries were dropped by the size limit)' : ''}`
        const redacted = redactSecrets(`${run.output}\n${summary}`, request.secrets)

        request.reveal = {
          token: randomOpaqueId(randomBytes),
          label: request.label,
          context: request.context,
          format: parsed.format,
          truncated: parsed.truncated,
          entries: parsed.entries,
        }
        const ack = await createRevealWaiter(request, revealTimeoutMs)
        request.reveal = undefined
        if (ack.cancelled) {
          request.state = 'cancelled'
          const reason = ack.reason === 'timeout'
            ? `卡片等待 ${Math.round(revealTimeoutMs / 1000)} 秒未确认，已关闭。`
            : '卡片已关闭，未确认。'
          return { status: 'cancelled', output: `${redacted}\n[reveal] ${reason}` }
        }

        // The vault holds only the entries that were classified as secret; a public value
        // like a port number is not a credential and does not belong there.
        const saved = []
        if (ack.save) {
          for (const entry of parsed.entries) {
            if (!entry.secret) continue
            try {
              const ref = `${credentialReference(randomBytes)}_${entry.key.replace(/[^A-Za-z0-9]+/g, '_').slice(0, 40).toUpperCase()}`
              await ctx.credentials.set(ref, entry.value)
              saved.push(ref)
            } catch { /* one failed save must not lose the whole card */ }
          }
        }
        request.state = 'completed'
        return {
          status: 'completed',
          output: `${redacted}${saved.length > 0 ? `\n[reveal] ${saved.length} entr${saved.length === 1 ? 'y' : 'ies'} saved as ${saved.join(', ')}` : ''}`,
          keys: parsed.entries.map((entry) => entry.key).slice(0, 60),
          revealed: parsed.entries.length,
        }
      } catch (error) {
        const message = redactSecrets(error?.message ?? 'Reveal operation failed.', request.secrets)
        request.publicError = message.slice(0, 300)
        request.state = exec.signal?.aborted ? 'cancelled' : 'failed'
        return { status: request.state, output: request.publicError }
      } finally {
        exec.signal?.removeEventListener('abort', abort)
        if (request.challenge) {
          clearTimeout(request.challenge.timer)
          request.challenge.resolve({ cancelled: true, reason: 'finished' })
        }
        if (request.revealWaiter) {
          request.revealWaiter.resolve({ cancelled: true, reason: 'finished' })
        }
        if (request.terminal) {
          activeTerminals.delete(request.terminal)
          interruptTerminal(request.terminal, request.exit !== undefined)
        }
        request.challenge = undefined
        request.reveal = undefined
        request.prompt = ''
        request.feedback = undefined
        request.rawOutput = ''
        request.scanOutput = ''
        request.secrets.fill('')
        requests.delete(callId)
      }
    },
  })

  ctx.tools.register({
    name: 'secret_ask',
    description: 'Ask the user for one secret through a card and hand it over without the value entering model context. deliver "vault" (default) stores it in the DSH credential store under `ref` and returns only that reference; deliver "file" writes it to a private 0600 file and returns the path, which the model can read — use that only for tools that insist on a file (an askpass helper). If the value already exists as a credential, use the `credential` argument of secret_exec/secret_browser instead of asking again. Never put a secret in the arguments.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt', 'label'],
      properties: {
        prompt: { type: 'string', description: 'Context shown to the user in the card: what the secret is for.' },
        label: { type: 'string', description: 'Card title, for example "Tavily API key".' },
        ref: { type: 'string', description: 'Credential reference to store under when deliver is "vault", shell-style (letters, digits, underscore, must not start with a digit), for example "TAVILY_API_KEY". Required for deliver "vault".' },
        deliver: { type: 'string', enum: ['vault', 'file'], description: 'Where the value goes. "vault" (default) stores it in the DSH credential store and returns only the reference; "file" writes a 0600 temp file and returns its path.' },
        autocomplete: {
          type: 'string',
          enum: ['current-password', 'new-password', 'one-time-code', 'off'],
          description: 'What password managers should assume on this card.',
        },
        rules: {
          type: 'object',
          additionalProperties: false,
          description: 'Live validation shown while the user types, for APIs with a known format.',
          properties: {
            minLength: { type: 'integer' },
            maxLength: { type: 'integer' },
            requireLower: { type: 'boolean' },
            requireUpper: { type: 'boolean' },
            requireDigit: { type: 'boolean' },
            requireSymbol: { type: 'boolean' },
          },
        },
        timeout_ms: { type: 'integer', description: 'How long to wait for the user, default 120000 and capped at 600000.' },
      },
    },
    output: {
      schema: SECRET_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `secret_ask ${value.status}\n${value.output}${value.path ? `\nPath: ${value.path}` : ''}` }],
    },
    async execute(args, exec) {
      const owner = exec.agent
      if (!owner || typeof owner !== 'object') throw new Error('secret_ask must run from a live agent')
      const callId = String(exec.callId ?? '')
      if (!callId) throw new Error('DSH did not provide a tool call id')
      if (requests.has(callId)) throw new Error('Duplicate secret_ask call id')
      const deliver = args.deliver === undefined ? 'vault' : args.deliver
      if (deliver !== 'vault' && deliver !== 'file') throw new TypeError('deliver must be "vault" or "file"')
      const ref = deliver === 'vault' ? String(args.ref ?? '').trim() : undefined
      if (deliver === 'vault' && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(ref ?? '')) {
        throw new TypeError('ref must be a shell-style credential name (letters, digits, underscore; must not start with a digit)')
      }
      const timeoutMs = clampTimeout(args.timeout_ms, timeoutDefault)
      const request = {
        callId,
        owner,
        state: 'starting',
        label: String(args.label ?? '安全输入').slice(0, 120),
        context: String(args.prompt ?? '').trim().slice(0, 1000),
        prompt: '',
        challenge: undefined,
        promptNumber: 1,
        maxPromptCount: 1,
        totalFields: 1,
        rules: validateRules(args.rules),
        autocomplete: typeof args.autocomplete === 'string' ? args.autocomplete : undefined,
        secret: true,
        ask: deliver,
        feedback: undefined,
        rawOutput: '',
        scanOutput: '',
        revision: 0,
        scannedRevision: 0,
        exit: undefined,
        secrets: [],
        vaultRef: ref,
        userCancelled: false,
        publicError: undefined,
        terminal: undefined,
        attempt: 0,
      }
      requests.set(callId, request)

      const abort = () => {
        request.userCancelled = true
        if (request.challenge) {
          const challenge = request.challenge
          clearTimeout(challenge.timer)
          request.challenge = undefined
          request.state = 'cancelled'
          challenge.resolve({ cancelled: true, reason: 'aborted' })
        }
      }
      exec.signal?.addEventListener('abort', abort, { once: true })

      try {
        if (disposing) return { status: 'cancelled', output: '插件正在卸载。' }
        const submitted = await createPromptWaiter(request, '', '', timeoutMs)
        if (submitted.cancelled) {
          request.state = 'cancelled'
          const reason = submitted.reason === 'timeout' ? '等待输入超时。' : '已取消输入。'
          return { status: 'cancelled', output: reason }
        }
        if (deliver === 'vault') {
          // The submit handler already wrote it; the reference is the whole payload.
          const vaultRef = submitted.vaultRef ?? ref
          request.state = 'completed'
          return { status: 'completed', output: `已保存到凭据库：${vaultRef}`, vault_ref: vaultRef }
        }
        const path = await writeHandoffFile(submitted.value)
        request.state = 'completed'
        return { status: 'completed', output: `值已写入 0600 文件，20 分钟后自动删除：${path}`, path }
      } catch (error) {
        const message = redactSecrets(error?.message ?? 'Secret handoff failed.', request.secrets)
        request.publicError = message.slice(0, 300)
        request.state = exec.signal?.aborted ? 'cancelled' : 'failed'
        return { status: request.state, output: request.publicError }
      } finally {
        exec.signal?.removeEventListener('abort', abort)
        if (request.challenge) {
          clearTimeout(request.challenge.timer)
          request.challenge.resolve({ cancelled: true, reason: 'finished' })
        }
        request.challenge = undefined
        request.prompt = ''
        request.feedback = undefined
        request.secrets.fill('')
        requests.delete(callId)
      }
    },
  })

  ctx.tools.register({
    name: 'secret_browser',
    description: 'Fill password fields in a browser without the value ever becoming a tool argument or a tool result. Drives the DSH sidebar browser panel by default and falls back to Ego Lite when no sidebar webview is open. Use for web forms: login, registration, password change. One card per field; pass `fields` when a form needs several.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['prompt'],
      properties: {
        prompt: { type: 'string', description: 'Context shown to the user in the secure input card.' },
        label: { type: 'string', description: 'Card title, for example "Gmail password".' },
        autocomplete: {
          type: 'string',
          enum: ['current-password', 'new-password', 'one-time-code', 'off'],
          description: 'What password managers should assume: current-password for a login, new-password for a form that creates one, one-time-code for an OTP.',
        },
        rules: {
          type: 'object',
          additionalProperties: false,
          description: 'Password policy the card checks live while the user types. Read it off the page when the form states one.',
          properties: {
            minLength: { type: 'integer', description: 'Minimum character count.' },
            maxLength: { type: 'integer', description: 'Maximum character count.' },
            requireLower: { type: 'boolean', description: 'Require at least one lowercase letter.' },
            requireUpper: { type: 'boolean', description: 'Require at least one uppercase letter.' },
            requireDigit: { type: 'boolean', description: 'Require at least one digit.' },
            requireSymbol: { type: 'boolean', description: 'Require at least one non-alphanumeric character.' },
          },
        },
        selector: { type: 'string', description: 'CSS selector of a single password input. Use fields instead when the form needs several secrets.' },
        fields: {
          type: 'array',
          description: 'Several secrets for one form, filled in declaration order: current password, new password, confirmation. Each entry becomes one card. Supports Playwright-style selectors such as `input[autocomplete="new-password"] >> nth=1`.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['selector'],
            properties: {
              selector: { type: 'string', description: 'CSS or Playwright-style selector for this field.' },
              label: { type: 'string', description: 'Short field name shown on the card title.' },
              prompt: { type: 'string', description: 'Per-field context that overrides prompt for this card.' },
              secret: { type: 'boolean', description: 'Whether this field holds a credential. Default is inferred from the selector (a password input is, an account or email input is not); set false for an account name and true for anything the inference gets wrong.' },
              credential: { type: 'string', description: 'Reference of an already stored credential. The field is filled from the credential store without opening a card; a missing reference falls back to the card.' },
              rules: {
                type: 'object',
                additionalProperties: false,
                description: 'Per-field policy that overrides the call-wide rules, for forms whose fields differ (the current password usually has no minimum).',
                properties: {
                  minLength: { type: 'integer' },
                  maxLength: { type: 'integer' },
                  requireLower: { type: 'boolean' },
                  requireUpper: { type: 'boolean' },
                  requireDigit: { type: 'boolean' },
                  requireSymbol: { type: 'boolean' },
                },
              },
            },
          },
        },
        submit_selector: { type: 'string', description: 'Optional selector clicked after every field is filled, for example button:has-text("修改密码").' },
        verify_selector: { type: 'string', description: 'Optional selector read back after submit, so the result reports what the page itself says (a success banner, an error line).' },
        verify_delay_ms: { type: 'integer', description: 'Wait between submit and the read-back, default 1200, capped at 15000. Raise it for pages that show a toast after an API round trip.' },
        url: { type: 'string', description: 'On the dsh engine, the site that selects which sidebar tab to fill (it does not navigate); on ego, a page to open first. Omitting it fills whatever is open, and is refused when several tabs are open.' },
        engine: { type: 'string', enum: ['dsh', 'ego'], description: 'Which browser to fill: "dsh" drives the DSH sidebar browser panel (default when it is open), "ego" drives Ego Lite. Falls back to ego when the sidebar has no webview.' },
        space: { type: 'string', description: 'ego engine only: Ego TaskSpace id or name. Defaults to "dsh-secret-form".' },
        timeout_ms: { type: 'integer', description: 'Browser wait budget per step, default 45000, capped at 120000.' },
      },
    },
    output: {
      schema: SECRET_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: `secret_browser ${value.status}\n${value.output}${value.vault_ref ? `\nSaved in DSH Vault as ${value.vault_ref}` : ''}` }],
    },
    async execute(args, exec) {
      const owner = exec.agent
      if (!owner || typeof owner !== 'object') throw new Error('secret_browser must run from a live agent')
      const callId = String(exec.callId ?? '')
      if (!callId) throw new Error('DSH did not provide a tool call id')
      if (requests.has(callId)) throw new Error('Duplicate secret_browser call id')
      const plan = validateBrowserFill(args)
      const timeoutMs = clampBrowserTimeout(args.timeout_ms, 45000)
      const request = {
        callId,
        state: 'starting',
        label: String(args.label ?? '安全输入').slice(0, 120),
        context: plan.prompt,
        prompt: '',
        challenge: undefined,
        promptNumber: 0,
        maxPromptCount,
        totalFields: plan.fields.length,
        rules: validateRules(args.rules),
        autocompleteDefault: typeof args.autocomplete === 'string' ? args.autocomplete : undefined,
        autocomplete: typeof args.autocomplete === 'string' ? args.autocomplete : undefined,
        secret: undefined,
        feedback: undefined,
        rawOutput: '',
        scanOutput: '',
        revision: 0,
        scannedRevision: 0,
        exit: undefined,
        secrets: [],
        vaultRef: undefined,
        userCancelled: false,
        publicError: undefined,
        terminal: undefined,
        dshFill: undefined,
        dshResolve: undefined,
        attempt: 0,
      }
      requests.set(callId, request)

      const abort = () => {
        request.userCancelled = true
        if (request.dshResolve) {
          const settle = request.dshResolve
          request.dshFill = undefined
          request.dshResolve = undefined
          settle({ ok: false, detail: 'aborted by the agent' })
        }
        if (request.challenge) {
          const challenge = request.challenge
          clearTimeout(challenge.timer)
          request.challenge = undefined
          request.state = 'cancelled'
          challenge.resolve({ cancelled: true, reason: 'aborted' })
        }
      }
      exec.signal?.addEventListener('abort', abort, { once: true })

      try {
        if (disposing) return { status: 'cancelled', output: '插件正在卸载。' }

        // One card per target field. A rename form asks for the current password, the new
        // one, and a confirmation: three cards, then a single fill pass and one submit.
        const values = []
        const total = plan.fields.length
        const baseLabel = request.label
        for (let index = 0; index < total; index += 1) {
          const field = plan.fields[index]
          request.label = total > 1
            ? `${baseLabel} · ${field.label ?? `字段 ${index + 1}/${total}`}`
            : baseLabel
          request.promptNumber = index + 1
          request.maxPromptCount = total
          // A rename form has three different policies: the current password has none, the new
          // one has the full policy, the confirmation repeats it. Field rules win over the call.
          if (field.rules !== undefined) request.rules = validateRules(field.rules)
          request.secret = field.secret
          request.autocomplete = field.secret
            ? request.autocompleteDefault
            : 'username'
          // A field backed by a stored credential is filled without a card at all; the
          // model asked for this by naming the reference.
          if (field.credential) {
            const stored = await readCredential(field.credential)
            if (stored !== undefined) {
              values.push(stored)
              continue
            }
          }
          request.state = 'running'
          // The card title already names the field, so a generated second sentence would only
          // repeat it. Only a caller-supplied prompt is worth showing.
          const promptText = field.prompt ?? ''
          const submitted = await createPromptWaiter(request, promptText, '', timeoutMs)
          if (submitted.cancelled) {
            request.state = 'cancelled'
            const reason = submitted.reason === 'timeout' ? '等待输入超时。' : '已取消输入。'
            values.fill('')
            return { status: 'cancelled', output: `${reason}浏览器未被修改。` }
          }
          values.push(submitted.value)
        }
        request.secrets.push(...values)
        request.state = 'running'
        const egoless = {
          space: plan.space,
          url: plan.url,
          fields: plan.fields,
          submitSelector: plan.submitSelector,
          verifySelector: plan.verifySelector,
          verifyDelayMs: plan.verifyDelayMs,
          values,
          timeoutMs,
        }
        let filled = plan.engine === 'dsh'
          ? await fillInSidebar(request, plan, values, timeoutMs)
          : await fillInBrowser(egoless)
        // The sidebar panel may simply not be open; Ego is the fallback, not a substitute.
        if (plan.engine === 'dsh' && !filled.ok && /no sidebar webview/i.test(filled.output)) {
          filled = await fillInBrowser(egoless)
        }
        // Both engines report the page's own answer in one shape, so a caller never has to
        // know which engine ran.
        if (plan.verifySelector) {
          const verified = filled.output.match(/^VERIFIED (.*)$/m)
          if (verified) {
            let text = verified[1]
            try { text = JSON.parse(verified[1]) } catch { /* keep the raw line */ }
            const shown = text === null || text === undefined || text === ''
              ? '(selector matched nothing)'
              : String(text)
            filled = { ...filled, output: `${filled.output.replace(verified[0], '').trimEnd()}\n[page says] ${shown}` }
          }
        }
        values.fill('')
        const status = filled.ok ? 'completed' : 'failed'
        request.state = status
        const output = redactSecrets(filled.output, request.secrets).slice(-maxOutputChars)
        return { status, output, ...(request.vaultRef ? { vault_ref: request.vaultRef } : {}) }
      } catch (error) {
        const message = redactSecrets(error?.message ?? 'Browser fill failed.', request.secrets)
        request.publicError = message.slice(0, 300)
        request.state = exec.signal?.aborted ? 'cancelled' : 'failed'
        return { status: request.state, output: request.publicError }
      } finally {
        exec.signal?.removeEventListener('abort', abort)
        if (request.challenge) {
          clearTimeout(request.challenge.timer)
          request.challenge.resolve({ cancelled: true, reason: 'finished' })
        }
        request.challenge = undefined
        request.prompt = ''
        request.feedback = undefined
        request.dshFill = undefined
        request.dshResolve = undefined
        request.rawOutput = ''
        request.scanOutput = ''
        request.secrets.fill('')
        requests.delete(callId)
      }
    },
  })

  ctx.effect(() => () => {
    disposing = true
    for (const request of requests.values()) {
      request.userCancelled = true
      if (request.challenge) {
        const challenge = request.challenge
        clearTimeout(challenge.timer)
        request.challenge = undefined
        request.state = 'cancelled'
        challenge.resolve({ cancelled: true, reason: 'plugin-unload' })
      }
    }
    for (const terminal of activeTerminals) interruptTerminal(terminal)
  })
}
