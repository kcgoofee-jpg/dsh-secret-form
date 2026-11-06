(function () {
  window.__ModuleLoader__.load({
    id: 'dsh-secret-form',
    factory: (require) => {
      const module = { exports: {} }
      const React = require('react')
      const h = React.createElement
      const activeCallIds = new Set()
      const API_PATH = '/secret-terminal/api'
      const ACTIVE_STATES = new Set(['starting', 'running', 'awaiting'])

      async function api(body) {
        const response = await fetch(new URL(API_PATH, window.location.href), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify(body),
        })
        const result = await response.json().catch(() => ({}))
        if (!response.ok || result.ok === false) throw new Error(result.error || `Request failed (${response.status})`)
        return result
      }

      // Every size, weight, radius, shadow and colour below is a DSH design token:
      // --dsw-font-{xxxs-11,xxs-12,xs-13,s-14,base-16,base-strong-16,m-18,l-20,xl-24}
      // --dsw-radius-{xs,sm,md,lg,xl,panel}
      // --dsw-shadow-{lv1,lv2,lv3}
      // --dsw-alias-{bg-*,label-*,border-l*,state-*,button-*,brand-primary}
      // Nothing here hard-codes a hex value except the mutually-exclusive fallbacks.

      // Rules come from the caller, never from a hard-coded policy: the plugin cannot know
      // what a given site requires, but the agent that read the page can pass it along.
      function evaluateRules(value, rules) {
        if (!rules || typeof rules !== 'object') return []
        const text = String(value ?? '')
        const chars = [...text].length
        const checks = []
        // `text` reads as a standalone statement, `short` slots into "还需要 …" so the
        // sentence stays grammatical instead of stacking verb phrases.
        if (Number.isInteger(rules.minLength)) checks.push({ ok: chars >= rules.minLength, text: `至少 ${rules.minLength} 位`, short: `${rules.minLength} 位` })
        if (Number.isInteger(rules.maxLength)) checks.push({ ok: chars <= rules.maxLength, text: `最多 ${rules.maxLength} 位`, short: `不超过 ${rules.maxLength} 位` })
        if (rules.requireLower) checks.push({ ok: /[a-z]/.test(text), text: '含小写字母', short: '小写字母' })
        if (rules.requireUpper) checks.push({ ok: /[A-Z]/.test(text), text: '含大写字母', short: '大写字母' })
        if (rules.requireDigit) checks.push({ ok: /\d/.test(text), text: '含数字', short: '数字' })
        if (rules.requireSymbol) checks.push({ ok: /[^A-Za-z0-9]/.test(text), text: '含符号', short: '符号' })
        return checks
      }

      // Four segments, red -> amber -> green, the shape Bootstrap/CoreUI/Jack Henry all
      // converged on. With rules the score is "how much of the stated policy is met"; without
      // rules it falls back to length plus character variety, the usual heuristic.
      const STRENGTH_LABEL = ['', '很弱', '偏弱', '良好', '很强']
      function scoreStrength(value, rules, checks) {
        const text = String(value ?? '')
        if (text.length === 0) return 0
        const chars = [...text].length
        if (checks.length > 0) {
          const passed = checks.filter((check) => check.ok).length
          const ratio = passed / checks.length
          let level = ratio >= 1 ? 4 : ratio >= 0.75 ? 3 : ratio >= 0.5 ? 2 : 1
          // Satisfying a weak policy is not the same as being strong: a 4-character password
          // that meets minLength:4 must never render as "very strong".
          if (chars < 6) return 1
          if (chars < 8) return Math.min(level, 2)
          if (chars < 10) return Math.min(level, 3)
          return level
        }
        const length = [...text].length
        const variety = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(text)).length
        const score = Math.floor(length / 5) + variety
        if (score >= 5) return 4
        if (score >= 4) return 3
        if (score >= 2) return 2
        return 1
      }

      // One sentence instead of a wall of chips: say what is still missing.
      function strengthNote(value, rules, checks, score) {
        if (String(value ?? '').length === 0) return ''
        const missing = checks.filter((check) => !check.ok)
        if (missing.length === 0) return '满足全部要求'
        if (rules && Number.isInteger(rules.minLength)) {
          const need = rules.minLength - [...String(value)].length
          if (need > 0) return `还差 ${need} 位`
        }
        const words = missing.map((check) => check.short ?? check.text).slice(0, 2)
        return `还需要 ${words.join('、')}`
      }

      // Chrome remembers "save to vault" the way it remembers a form: one choice covers the
      // whole form, and the next form starts from the last answer instead of resetting.
      const SAVE_KEY = 'dsh-secret-form:save-to-vault'
      function readSavePref() {
        try { return window.localStorage.getItem(SAVE_KEY) === '1' } catch { return false }
      }
      function writeSavePref(value) {
        try { window.localStorage.setItem(SAVE_KEY, value ? '1' : '0') } catch { /* storage may be unavailable */ }
      }

      // A sidebar <webview> only has plain DOM: no Playwright selector engine. This resolver
      // reproduces the three extensions the cards accept -- `>> nth=N`, `:has-text("x")`,
      // `:text-is("x")` -- so one selector text works on both engines. It is stringified into
      // the injected snippet, so it must stay free of outer-scope references.
      function resolveTarget(spec) {
        let sel = String(spec).trim()
        let nth = null
        let needle = null
        let exact = false
        const arrow = sel.lastIndexOf('>>')
        if (arrow >= 0) {
          const tail = sel.slice(arrow + 2)
          sel = sel.slice(0, arrow).trim()
          const eq = tail.indexOf('=')
          if (eq > 0 && tail.slice(0, eq).trim() === 'nth') nth = Number(tail.slice(eq + 1).trim())
        }
        const hasText = sel.lastIndexOf(':has-text(')
        const textIs = sel.lastIndexOf(':text-is(')
        const marker = Math.max(hasText, textIs)
        if (marker >= 0) {
          const head = marker === hasText ? 10 : 9
          let tail = sel.slice(marker + head).trim()
          if (tail.endsWith(')')) tail = tail.slice(0, -1)
          sel = sel.slice(0, marker).trim()
          needle = tail.trim().replace(/^["']/, '').replace(/["']$/, '')
          exact = marker === textIs
        }
        // An invalid selector throws a SyntaxError, which would abort the whole injected
        // snippet and surface as an opaque "Script failed to execute". Returning undefined
        // instead keeps the failure legible: the caller reports "no element matched".
        let nodes = []
        try { nodes = Array.from(document.querySelectorAll(sel)) } catch { return undefined }
        if (needle !== null) {
          nodes = nodes.filter((node) => {
            const text = (node.textContent || '').trim()
            return exact ? text === needle : text.includes(needle)
          })
        }
        return nth === null ? nodes[0] : nodes[nth]
      }

      function buildFieldScript(selector, value) {
        return `(() => {
  const resolveTarget = ${resolveTarget.toString()}
  const el = resolveTarget(${JSON.stringify(selector)})
  if (!el) return { ok: false, reason: 'no element matched ' + ${JSON.stringify(selector)} }
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
  if (setter) setter.call(el, ${JSON.stringify(value)})
  else el.value = ${JSON.stringify(value)}
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  el.focus()
  return { ok: true, length: el.value.length }
})()`
      }

      function buildSubmitScript(selector) {
        return `(() => {
  const resolveTarget = ${resolveTarget.toString()}
  const el = resolveTarget(${JSON.stringify(selector)})
  if (!el) return { ok: false, reason: 'no submit element matched ' + ${JSON.stringify(selector)} }
  el.click()
  return { ok: true }
})()`
      }

      function buildReadScript(selector) {
        return `(() => {
  const resolveTarget = ${resolveTarget.toString()}
  const el = resolveTarget(${JSON.stringify(selector)})
  if (!el) return { ok: false, reason: 'no element matched ' + ${JSON.stringify(selector)} }
  return { ok: true, text: (el.textContent || '').trim().slice(0, 600) }
})()`
      }

      async function runSidebarFill(callId, fill) {
        const all = Array.from(document.querySelectorAll('webview'))
        const matched = fill.match ? all.filter((view) => (view.getAttribute('src') || '').includes(fill.match)) : []
        if (all.length === 0) {
          await api({ op: 'dsh-result', callId, ok: false, detail: 'no sidebar webview is open; open the Browser panel first' }).catch(() => {})
          return
        }
        // Ambiguity is never resolved by guessing: with several tabs open and no site to bind
        // to, refuse rather than risk typing a password into the wrong page.
        if (matched.length === 0 && all.length > 1) {
          const where = all.map((view) => (view.getAttribute('src') || 'about:blank')).slice(0, 4).join(', ')
          await api({ op: 'dsh-result', callId, ok: false, detail: `no webview matches this site, and ${all.length} are open (${where}); pass url to pick one` }).catch(() => {})
          return
        }
        const pool = matched.length > 0 ? matched : all
        let detail = ''
        let usedView = pool[0]
        const landedLengths = []
        for (let index = 0; index < fill.fields.length; index += 1) {
          const selector = fill.fields[index].selector
          const value = fill.values[index]
          let landed = ''
          for (const view of pool) {
            try {
              const result = await view.executeJavaScript(buildFieldScript(selector, value))
              if (result && result.ok) { landed = view.getAttribute('src') || 'webview'; landedLengths[index] = result.length; usedView = view; break }
              detail = (result && result.reason) || 'field not found'
            } catch (error) {
              detail = String((error && error.message) || error)
            }
          }
          if (!landed) {
            // A selector that does not match is nearly always the wrong page, and the caller
            // cannot see which page the panel is on. Report it, plus how many password fields
            // exist, so the next attempt can be corrected instead of guessed.
            let where = 'unknown page'
            try {
              const seen = await pool[0].executeJavaScript(`(() => ({
                url: location.href,
                passwordFields: document.querySelectorAll('input[type=\"password\"]').length,
                inputs: Array.from(document.querySelectorAll('input')).slice(0, 8).map((el) => ({ type: el.type, name: el.name, id: el.id })),
              }))()`)
              where = `${(seen && seen.url) || 'unknown page'} [${(seen && seen.passwordFields) || 0} password field(s); inputs: ${JSON.stringify((seen && seen.inputs) || []).slice(0, 240)}]`
            } catch { /* a diagnostic must never mask the real failure */ }
            await api({ op: 'dsh-result', callId, ok: false, detail: `field ${index + 1}/${fill.fields.length} (${selector}): ${detail} — panel shows ${where}` }).catch(() => {})
            return
          }
          detail = `field ${index + 1}/${fill.fields.length} filled (${landedLengths[index] ?? '?'} chars) in ${landed}`
        }
        if (fill.submitSelector) {
          try {
            const submitted = await usedView.executeJavaScript(buildSubmitScript(fill.submitSelector))
            detail += submitted && submitted.ok ? '; submit clicked' : `; submit skipped: ${(submitted && submitted.reason) || 'unknown'}`
          } catch (error) {
            detail += `; submit failed: ${String((error && error.message) || error)}`
          }
        }
        // What the page itself says afterwards is the only real proof the app accepted the
        // values, so read it back before reporting.
        let verifyText = ''
        if (fill.verifySelector) {
          try {
            await new Promise((done) => setTimeout(done, Number.isInteger(fill.verifyDelayMs) ? fill.verifyDelayMs : 1200))
            const read = await usedView.executeJavaScript(buildReadScript(fill.verifySelector))
            verifyText = read && read.ok ? read.text : ((read && read.reason) || '')
          } catch (error) {
            verifyText = String((error && error.message) || error)
          }
        }
        detail += `; lengths ${JSON.stringify(landedLengths)}`
        await api({ op: 'dsh-result', callId, ok: true, detail, verifyText }).catch(() => {})
      }

      const CSS = `
        .dsh-secret-card{box-sizing:border-box;width:min(560px,100%);display:flex;align-items:center;gap:11px;padding:11px 13px;margin:6px 0;border:1px solid var(--dsw-alias-border-l1,#0000000a);border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);box-shadow:var(--dsw-shadow-lv1,0 2px 4px rgba(0,0,0,.05))}
        .dsh-secret-icon{width:32px;height:32px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:var(--dsw-radius-md,12px);background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 6%,transparent);color:var(--dsw-alias-label-secondary,#61666b)}
        .dsh-secret-copy{min-width:0;flex:1}
        .dsh-secret-title{font:var(--dsw-font-s-14,14px/22px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);font-weight:500;overflow-wrap:anywhere}
        .dsh-secret-sub{font:var(--dsw-font-xxs-12,12px/18px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif);color:var(--dsw-alias-label-tertiary,#5c626b);margin-top:1px;overflow-wrap:anywhere}
        .dsh-secret-open{flex:none;height:28px;padding:0 13px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:999px;background:var(--dsw-alias-button-floating-fill,#fff);color:var(--dsw-alias-label-primary,#0f1115);font:var(--dsw-font-xxs-12,12px/18px -apple-system,sans-serif);font-weight:500;cursor:pointer;transition:background .12s ease}
        .dsh-secret-open:hover:not(:disabled){background:var(--dsw-alias-button-floating-hover,#f1f3f5)}
        .dsh-secret-open:disabled{opacity:.4;cursor:default}

        .dsh-secret-done{display:flex;align-items:center;gap:6px;margin:1px 0;padding:0 2px;font:var(--dsw-font-xxs-12,12px/18px -apple-system,sans-serif);color:var(--dsw-alias-label-caption,#8b9199)}
        .dsh-secret-done-dot{width:5px;height:5px;flex:none;border-radius:50%;background:currentColor;opacity:.5}
        .dsh-secret-done-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}
        .dsh-secret-done-note{opacity:.85;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px}

        .dsh-secret-mask{position:fixed;inset:0;z-index:2147483000;display:grid;place-items:center;padding:20px;box-sizing:border-box;background:var(--dsw-alias-bg-mask-1,#0000003d)}
        .dsh-secret-modal{box-sizing:border-box;width:min(440px,94vw);max-height:min(88vh,760px);overflow:auto;padding:20px 22px 22px;border-radius:var(--dsw-radius-panel,28px);background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#0f1115);box-shadow:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.08));font:var(--dsw-font-base-16,16px/24px -apple-system,sans-serif)}
        .dsh-secret-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}
        .dsh-secret-heading{font:var(--dsw-font-l-20,500 20px/28px -apple-system,sans-serif);overflow-wrap:anywhere}
        .dsh-secret-close{width:28px;height:28px;flex:none;display:flex;align-items:center;justify-content:center;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-tertiary,#5c626b);font:var(--dsw-font-m-18,500 16px/28px -apple-system,sans-serif);line-height:1;cursor:pointer}
        .dsh-secret-close:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 7%,transparent);color:var(--dsw-alias-label-primary,#0f1115)}
        .dsh-secret-context{margin:0 0 10px;font:var(--dsw-font-xs-13,13px/20px -apple-system,sans-serif);color:var(--dsw-alias-label-secondary,#61666b);overflow-wrap:anywhere}
        .dsh-secret-prompt{display:block;margin:0 0 12px;padding:7px 10px;border-radius:var(--dsw-radius-sm,8px);background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 4%,transparent);color:var(--dsw-alias-label-tertiary,#5c626b);font-family:var(--dsh-font-family-code-default,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:72px;overflow:auto}
        .dsh-secret-again{display:inline-flex;align-items:center;height:20px;padding:0 8px;margin:0 0 10px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f5a623) 15%,transparent);color:var(--dsw-alias-state-warn-primary,#f5a623);font:var(--dsw-font-xxxs-11,11px/14px -apple-system,sans-serif);font-weight:500}
        .dsh-secret-feedback{white-space:pre-wrap;overflow-wrap:anywhere;max-height:118px;overflow:auto;margin:0 0 14px;padding:8px 10px;border-left:2px solid var(--dsw-alias-state-warn-primary,#f5a623);border-radius:0 var(--dsw-radius-sm,8px) var(--dsw-radius-sm,8px) 0;background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#f5a623) 8%,transparent);color:var(--dsw-alias-label-primary,#0f1115);font-family:var(--dsh-font-family-code-default,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px}
        .dsh-secret-field{margin:0}
        .dsh-secret-meter{display:flex;gap:3px;margin:9px 0 0}
        .dsh-secret-meter span{flex:1;height:4px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 9%,transparent);transition:background .18s ease}
        .dsh-secret-meter span.on1{background:var(--dsw-alias-state-error-primary,#d33)}
        .dsh-secret-meter span.on2{background:var(--dsw-alias-state-warn-primary,#f5a623)}
        .dsh-secret-meter span.on3{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#1a9f60) 55%,var(--dsw-alias-state-warn-primary,#f5a623))}
        .dsh-secret-meter span.on4{background:var(--dsw-alias-state-success-primary,#1a9f60)}
        .dsh-secret-note{margin:7px 0 0;font:var(--dsw-font-xxs-12,12px/18px -apple-system,sans-serif);color:var(--dsw-alias-label-tertiary,#5c626b)}
        .dsh-secret-note b{font-weight:550;color:var(--dsw-alias-label-secondary,#61666b)}
        .dsh-secret-inputwrap{position:relative}
        .dsh-secret-input{box-sizing:border-box;width:100%;height:42px;padding:0 40px 0 12px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-base,#fff);color:inherit;font:var(--dsw-font-base-16,16px/24px -apple-system,sans-serif);outline:none;transition:border-color .12s ease,box-shadow .12s ease}
        .dsh-secret-input:focus{border-color:var(--dsw-alias-brand-primary,#0f1115);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-brand-primary,#0f1115) 12%,transparent)}
        .dsh-secret-eye{position:absolute;right:5px;top:5px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-tertiary,#5c626b);font-size:14px;line-height:1;cursor:pointer}
        .dsh-secret-eye:hover{background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 7%,transparent);color:var(--dsw-alias-label-primary,#0f1115)}
        .dsh-secret-error{margin-top:6px;font:var(--dsw-font-xxs-12,12px/18px -apple-system,sans-serif);color:var(--dsw-alias-state-error-primary,#d33)}
        .dsh-secret-save{display:flex;align-items:center;gap:8px;margin:14px 0 0;font:var(--dsw-font-s-14,14px/22px -apple-system,sans-serif);color:var(--dsw-alias-label-secondary,#61666b);cursor:pointer}
        .dsh-secret-save input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary,#0f1115)}
        .dsh-secret-foot{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:18px}
        .dsh-secret-hint{flex:1;min-width:0;font:var(--dsw-font-xxxs-11,11px/14px -apple-system,sans-serif);color:var(--dsw-alias-label-caption,#8b9199);line-height:1.55}
        .dsh-secret-actions{display:flex;gap:8px;flex:none}
        .dsh-secret-button{height:34px;padding:0 15px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:999px;background:transparent;color:var(--dsw-alias-label-primary,#0f1115);font:var(--dsw-font-s-14,14px/22px -apple-system,sans-serif);font-weight:500;cursor:pointer;transition:background .12s ease,filter .12s ease}
        .dsh-secret-button:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 6%,transparent)}
        .dsh-secret-button.primary{border-color:transparent;background:var(--dsw-alias-button-contrast-fill,#3c4048);color:var(--dsw-alias-label-primary-foreground,#fff)}
        .dsh-secret-button.primary:hover:not(:disabled){filter:brightness(1.15)}
        .dsh-secret-button:disabled{opacity:.4;cursor:default}

        .dsh-secret-modal.wide{width:min(560px,94vw)}
        .dsh-secret-reveal{margin:2px 0 0;padding:0 10px;border:1px solid var(--dsw-alias-border-l1,#0000000a);border-radius:var(--dsw-radius-md,12px);background:var(--dsw-alias-bg-base,#fff);max-height:min(46vh,400px);overflow:auto}
        .dsh-secret-reveal-row{padding:9px 0;border-top:1px solid var(--dsw-alias-border-l1,#0000000a)}
        .dsh-secret-reveal-row:first-child{border-top:0}
        .dsh-secret-reveal-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
        .dsh-secret-reveal-key{flex:1;min-width:0;font-family:var(--dsh-font-family-code-default,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary,#0f1115);overflow-wrap:anywhere}
        .dsh-secret-reveal-tag{flex:none;height:18px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-brand-primary,#0f1115) 10%,transparent);color:var(--dsw-alias-brand-primary,#0f1115);font:var(--dsw-font-xxxs-11,11px/18px -apple-system,sans-serif);font-weight:500}
        .dsh-secret-reveal-tools{display:flex;gap:4px;flex:none}
        .dsh-secret-mini{height:24px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2,#0000001a);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary,#61666b);font:var(--dsw-font-xxxs-11,11px/14px -apple-system,sans-serif);cursor:pointer;transition:background .12s ease}
        .dsh-secret-mini:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-label-primary,#0f1115) 6%,transparent);color:var(--dsw-alias-label-primary,#0f1115)}
        .dsh-secret-mini:disabled{opacity:.45;cursor:default}
        .dsh-secret-reveal-value{font-family:var(--dsh-font-family-code-default,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:132px;overflow:auto;color:var(--dsw-alias-label-primary,#0f1115)}
        .dsh-secret-reveal-value.masked{color:var(--dsw-alias-label-tertiary,#5c626b);letter-spacing:.16em;user-select:none}
        @media(max-width:520px){.dsh-secret-modal{width:94vw;padding:18px 18px 20px;border-radius:var(--dsw-radius-xl,20px)}.dsh-secret-foot{flex-direction:column;align-items:stretch;gap:12px}.dsh-secret-actions{justify-content:flex-end}.dsh-secret-actions .dsh-secret-button{flex:1}}
      `

      function Icon() {
        return h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          h('circle', { cx: 16.8, cy: 7.2, r: 3.2 }),
          h('path', { d: 'M13.7 9.5 4 19.2h5v-3h3v-3h3l1.4-1.4' }))
      }

      // The conventional eye / eye-with-slash pair, drawn rather than typed, so it matches
      // stroke weight with the rest of the UI at any font size.
      function EyeIcon({ off }) {
        return h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          h('path', { d: 'M1.8 12S5.4 5.5 12 5.5 22.2 12 22.2 12 18.6 18.5 12 18.5 1.8 12 1.8 12Z' }),
          h('circle', { cx: 12, cy: 12, r: 3.1 }),
          off ? h('path', { d: 'M3 21 21 3' }) : null)
      }

      function SecureModal({ callId, state, label, initialSave, onSettled }) {
        const [value, setValue] = React.useState('')
        const [visible, setVisible] = React.useState(false)
        const [save, setSave] = React.useState(Boolean(initialSave))
        const [busy, setBusy] = React.useState(false)
        const [error, setError] = React.useState('')
        const inputRef = React.useRef(null)
        // An account name is not a credential: no mask, no strength meter, no vault checkbox.
        const isSecret = state.secret !== false

        React.useEffect(() => {
          inputRef.current?.focus()
        }, [])

        const cancel = async () => {
          setValue('')
          try { await api({ op: 'cancel', callId }) } catch { /* host may already have settled */ }
          onSettled('cancel')
        }
        const submit = async () => {
          if (!value || !state.challenge || busy) return
          setBusy(true)
          setError('')
          try {
            const saveChoice = isSecret ? save : false
            await api({ op: 'submit', callId, challenge: state.challenge, value, save: saveChoice })
            setValue('')
            onSettled('submit', saveChoice)
          } catch (err) {
            setError(err?.message || '提交失败，请重试。')
            setBusy(false)
          }
        }
        const keyDown = (event) => {
          if (event.key === 'Escape' && !busy) { event.preventDefault(); void cancel() }
          else if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit() }
        }

        const retry = Number(state.promptNumber) > 1
        const checks = evaluateRules(value, state.rules)
        const strength = scoreStrength(value, state.rules, checks)
        const detail = strengthNote(value, state.rules, checks, strength)
        const note = strength > 0 ? `${STRENGTH_LABEL[strength]}${detail ? ` · ${detail}` : ''}` : ''
        const blockedByRules = checks.length > 0 && checks.some((check) => !check.ok)

        return h('div', { className: 'dsh-secret-mask', onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) void cancel() } },
          h('section', { className: 'dsh-secret-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'dsh-secret-heading', onKeyDown: keyDown },
            h('header', { className: 'dsh-secret-head' },
              h('div', { className: 'dsh-secret-heading', id: 'dsh-secret-heading' }, label || '安全输入'),
              h('button', { className: 'dsh-secret-close', type: 'button', onClick: () => void cancel(), disabled: busy, 'aria-label': 'Cancel' }, '×')),
            retry ? h('div', { className: 'dsh-secret-again' }, `第 ${state.promptNumber}/${state.maxPromptCount ?? 8} 次输入`) : null,
            state.context ? h('div', { className: 'dsh-secret-context' }, state.context) : null,
            // The box exists for a terminal's own prompt line ("Password:"). A browser field
            // has nothing to add -- its name is already the title.
            state.prompt ? h('div', { className: 'dsh-secret-prompt' }, state.prompt) : null,
            state.feedback ? h('div', { className: 'dsh-secret-feedback' }, state.feedback) : null,
            h('div', { className: 'dsh-secret-field' },
              h('div', { className: 'dsh-secret-inputwrap' },
                h('input', { ref: inputRef, id: 'dsh-secret-value', className: 'dsh-secret-input', type: !isSecret || visible ? 'text' : 'password', value, autoComplete: state.autocomplete || (isSecret ? 'new-password' : 'username'), onChange: (event) => setValue(event.target.value), onPaste: (event) => event.stopPropagation(), disabled: busy, maxLength: 4096,
                  'aria-invalid': error ? 'true' : undefined,
                  'aria-describedby': [note ? 'dsh-secret-note' : '', error ? 'dsh-secret-error' : ''].filter(Boolean).join(' ') || undefined }),
                isSecret
                  ? h('button', { className: 'dsh-secret-eye', type: 'button', onClick: () => setVisible((current) => !current), 'aria-label': visible ? '隐藏输入' : '显示输入', title: visible ? '隐藏' : '显示' }, h(EyeIcon, { off: visible }))
                  : null),
              isSecret && strength > 0
                ? h('div', { className: 'dsh-secret-meter' }, [1, 2, 3, 4].map((segment) => h('span', { key: segment, className: segment <= strength ? `on${strength}` : '' })))
                : null,
              isSecret && note ? h('div', { className: 'dsh-secret-note', id: 'dsh-secret-note', 'aria-live': 'polite' }, note) : null,
              error ? h('div', { className: 'dsh-secret-error', id: 'dsh-secret-error', role: 'alert' }, error) : null),
            isSecret ? h('label', { className: 'dsh-secret-save' },
              h('input', { type: 'checkbox', checked: save, onChange: (event) => setSave(event.target.checked), disabled: busy }),
              h('span', null, '安全保存到凭据库')) : null,
            h('footer', { className: 'dsh-secret-foot' },
              h('div', { className: 'dsh-secret-hint' }, '不会进入对话记录。'),
              h('div', { className: 'dsh-secret-actions' },
                h('button', { className: 'dsh-secret-button', type: 'button', onClick: () => void cancel(), disabled: busy }, '取消'),
                h('button', { className: 'dsh-secret-button primary', type: 'button', onClick: () => void submit(), disabled: busy || !value || blockedByRules }, busy ? '提交中…' : '提交')))))
      }

      // Clipboard access can be refused (no user gesture, insecure context). The legacy
      // textarea path keeps "copy" working instead of silently doing nothing.
      async function copyText(text) {
        try {
          if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true }
        } catch { /* fall through to the legacy path */ }
        try {
          const area = document.createElement('textarea')
          area.value = text
          area.setAttribute('readonly', '')
          area.style.cssText = 'position:fixed;top:-1000px;left:-1000px;opacity:0'
          document.body.appendChild(area)
          area.select()
          const ok = document.execCommand('copy')
          area.remove()
          return ok
        } catch { return false }
      }

      // A fixed mask, never one dot per character: the mask itself must not leak the length.
      const MASK = '••••••••••••'

      function RevealModal({ callId, reveal, label, onSettled }) {
        const entries = reveal.entries || []
        const [shown, setShown] = React.useState(() => new Set())
        const [save, setSave] = React.useState(false)
        const [copied, setCopied] = React.useState('')
        const [busy, setBusy] = React.useState(false)

        const toggle = (key) => setShown((current) => {
          const next = new Set(current)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
        const copyOne = async (entry) => {
          if (!(await copyText(entry.value))) return
          setCopied(entry.key)
          setTimeout(() => setCopied((current) => (current === entry.key ? '' : current)), 1400)
        }
        const copyAll = async () => {
          if (!(await copyText(entries.map((entry) => `${entry.key}=${entry.value}`).join('\n')))) return
          setCopied('__all__')
          setTimeout(() => setCopied((current) => (current === '__all__' ? '' : current)), 1400)
        }
        const settle = async (op) => {
          if (busy) return
          setBusy(true)
          try { await api({ op, callId, save }) } catch { /* the host may already have settled */ }
          onSettled()
        }
        const keyDown = (event) => {
          if (event.key === 'Escape' && !busy) { event.preventDefault(); void settle('reveal-cancel') }
        }

        return h('div', { className: 'dsh-secret-mask', onMouseDown: (event) => { if (event.target === event.currentTarget && !busy) void settle('reveal-cancel') } },
          h('section', { className: 'dsh-secret-modal wide', role: 'dialog', 'aria-modal': 'true', onKeyDown: keyDown },
            h('header', { className: 'dsh-secret-head' },
              h('div', { className: 'dsh-secret-heading' }, label || '密钥'),
              h('button', { className: 'dsh-secret-close', type: 'button', onClick: () => void settle('reveal-cancel'), disabled: busy, 'aria-label': '关闭' }, '×')),
            reveal.context ? h('div', { className: 'dsh-secret-context' }, reveal.context) : null,
            h('div', { className: 'dsh-secret-reveal' }, entries.map((entry) =>
              h('div', { className: 'dsh-secret-reveal-row', key: entry.key },
                h('div', { className: 'dsh-secret-reveal-head' },
                  h('span', { className: 'dsh-secret-reveal-key' }, entry.key),
                  entry.secret ? h('span', { className: 'dsh-secret-reveal-tag' }, '密钥') : null,
                  h('div', { className: 'dsh-secret-reveal-tools' },
                    entry.secret ? h('button', { className: 'dsh-secret-mini', type: 'button', onClick: () => toggle(entry.key), disabled: busy }, shown.has(entry.key) ? '隐藏' : '显示') : null,
                    h('button', { className: 'dsh-secret-mini', type: 'button', onClick: () => void copyOne(entry), disabled: busy }, copied === entry.key ? '已复制' : '复制'))),
                h('div', { className: `dsh-secret-reveal-value${entry.secret && !shown.has(entry.key) ? ' masked' : ''}` },
                  entry.secret && !shown.has(entry.key) ? MASK : (entry.value.length > 0 ? entry.value : '（空）'))))),
            reveal.truncated ? h('div', { className: 'dsh-secret-note' }, '条目太多，只显示了一部分。') : null,
            h('label', { className: 'dsh-secret-save' },
              h('input', { type: 'checkbox', checked: save, onChange: (event) => setSave(event.target.checked), disabled: busy }),
              h('span', null, '把密钥保存到凭据库')),
            h('footer', { className: 'dsh-secret-foot' },
              h('div', { className: 'dsh-secret-hint' }, '只在这个卡片里，不会进入对话记录。'),
              h('div', { className: 'dsh-secret-actions' },
                h('button', { className: 'dsh-secret-button', type: 'button', onClick: () => void copyAll(), disabled: busy }, copied === '__all__' ? '已复制' : '全部复制'),
                h('button', { className: 'dsh-secret-button primary', type: 'button', onClick: () => void settle('reveal-ack'), disabled: busy }, busy ? '处理中…' : '完成')))))
      }

      // The reveal card has no input: the host reads the secret, sends it here, and waits
      // until the user is done looking. Nothing about the values ever reaches the model.
      function SecretRevealRow(props) {
        const callId = props.callId
        const block = props.block
        const fallbackLabel = block?.args?.text?.('label') || '密钥'
        const [state, setState] = React.useState({ state: 'starting' })
        const [reveal, setReveal] = React.useState(null)
        const [open, setOpen] = React.useState(false)
        const seenRef = React.useRef('')
        const phaseRef = React.useRef(props.phase)
        phaseRef.current = props.phase
        const phase = props.phase

        React.useEffect(() => {
          activeCallIds.add(callId)
          let stopped = false
          let timer
          const poll = async () => {
            let next = null
            try { next = await api({ op: 'status', callId, seenReveal: seenRef.current || undefined }) } catch { next = null }
            if (stopped) return
            if (next) {
              setState(next)
              // The values ride along once; afterwards the poll only names the token it
              // already holds, so a large reveal is not retransmitted on every tick.
              if (next.reveal?.entries) {
                seenRef.current = next.reveal.token
                setReveal(next.reveal)
                setOpen(true)
              }
            }
            if (phaseRef.current === 'result') {
              setState((current) => (ACTIVE_STATES.has(current.state) ? { ...current, state: 'completed' } : current))
              return
            }
            timer = setTimeout(poll, 700)
          }
          void poll()
          return () => {
            stopped = true
            clearTimeout(timer)
            activeCallIds.delete(callId)
          }
        }, [callId])

        const settled = phase === 'result' || !ACTIVE_STATES.has(state.state)
        const title = reveal?.label || state.label || fallbackLabel

        if (settled) {
          const note = state.state === 'failed'
            ? (state.message || '执行失败')
            : state.state === 'cancelled'
              ? '已取消'
              : '已完成'
          return h('div', { className: 'dsh-secret-done', title: `${title} · ${note}` },
            h('span', { className: 'dsh-secret-done-dot' }),
            h('span', { className: 'dsh-secret-done-label' }, title),
            h('span', { className: 'dsh-secret-done-note' }, `· ${note}`))
        }

        const status = reveal
          ? `查看 ${reveal.entries.length} 项，只在这个卡片里`
          : state.state === 'running'
            ? '正在读取…'
            : '正在启动受控终端…'
        return h(React.Fragment, null,
          h('div', { className: 'dsh-secret-card', 'data-secret-form-call': callId },
            h('div', { className: 'dsh-secret-icon' }, h(Icon)),
            h('div', { className: 'dsh-secret-copy' },
              h('div', { className: 'dsh-secret-title' }, title),
              h('div', { className: 'dsh-secret-sub' }, status)),
            h('button', { className: 'dsh-secret-open', type: 'button', disabled: !reveal, onClick: () => setOpen(true) }, '查看')),
          open && reveal ? h(RevealModal, { callId, reveal, label: title, onSettled: () => { setOpen(false); setReveal(null) } }) : null)
      }

      function SecretExecRow(props) {
        const callId = props.callId
        const block = props.block
        const label = block?.args?.text?.('label') || '安全输入'
        const [state, setState] = React.useState({ state: 'starting' })
        const [open, setOpen] = React.useState(false)
        const submittedRef = React.useRef(false)
        const dshTokenRef = React.useRef('')
        const saveRef = React.useRef(readSavePref())
        const phaseRef = React.useRef(props.phase)
        phaseRef.current = props.phase
        const phase = props.phase

        React.useEffect(() => {
          activeCallIds.add(callId)
          let stopped = false
          let timer
          const poll = async () => {
            let next = null
            try { next = await api({ op: 'status', callId }) } catch { next = null }
            if (stopped) return
            if (next) {
              setState(next)
              // The card keeps polling during the call, so this is where a sidebar fill
              // request arrives; the token makes each request run exactly once.
              if (next.dshFill && next.dshFill.token !== dshTokenRef.current) {
                dshTokenRef.current = next.dshFill.token
                void runSidebarFill(callId, next.dshFill)
              }
            }
            if (phaseRef.current === 'result') {
              setState((current) => (ACTIVE_STATES.has(current.state) ? { ...current, state: 'completed' } : current))
              return
            }
            timer = setTimeout(poll, 650)
          }
          void poll()
          return () => {
            stopped = true
            clearTimeout(timer)
            activeCallIds.delete(callId)
          }
        }, [callId])

        const settled = phase === 'result' || !ACTIVE_STATES.has(state.state)
        const awaiting = !settled && state.state === 'awaiting' && Boolean(state.challenge)
        // The host names each card ("GitHub 登录 · GitHub 账号"); before the first poll the
        // tool argument is the best available title.
        const title = state.label || label || '安全输入'

        // A rejected secret comes straight back as a fresh prompt. Reopen the modal on
        // the user's own continuation, so retrying does not require hunting for the card.
        React.useEffect(() => {
          if (awaiting && submittedRef.current) setOpen(true)
        }, [state.challenge, awaiting])

        const onSettled = (kind, saveChoice) => {
          setOpen(false)
          submittedRef.current = kind === 'submit'
          if (kind === 'submit' && typeof saveChoice === 'boolean') {
            saveRef.current = saveChoice
            writeSavePref(saveChoice)
          }
        }

        if (settled) {
          const note = state.state === 'failed'
            ? (state.message || '执行失败')
            : state.state === 'cancelled'
              ? '已取消'
              : '已完成'
          return h(React.Fragment, null,
            h('div', { className: 'dsh-secret-done', 'data-secret-form-call': callId, title: `${title} · ${note}` },
              h('span', { className: 'dsh-secret-done-dot' }),
              h('span', { className: 'dsh-secret-done-label' }, title),
              h('span', { className: 'dsh-secret-done-note' }, `· ${note}`)))
        }

        const status = awaiting
          ? (Number(state.promptNumber) > 1 ? `打开安全表单 · 第 ${state.promptNumber}/${state.maxPromptCount ?? 8} 次` : '打开安全表单')
          : state.state === 'running'
            ? '正在等待终端提示…'
            : '正在启动受控终端…'

        return h(React.Fragment, null,
          h('div', { className: 'dsh-secret-card', 'data-secret-form-call': callId },
            h('div', { className: 'dsh-secret-icon' }, h(Icon)),
            h('div', { className: 'dsh-secret-copy' },
              h('div', { className: 'dsh-secret-title' }, title),
              h('div', { className: 'dsh-secret-sub' }, status)),
            h('button', { className: 'dsh-secret-open', type: 'button', disabled: !awaiting, onClick: () => setOpen(true) }, '打开')),
          open && awaiting ? h(SecureModal, { callId, state, label: title, initialSave: saveRef.current, onSettled }) : null)
      }

      function apply(ctx) {
        // One stylesheet per plugin run, not one per card: the previous version rendered a
        // <style> inside every tool row, so four cards meant four identical copies.
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-secret-form'
        tag.textContent = CSS
        document.head.appendChild(tag)
        ctx.effect(() => () => tag.remove())

        // The same card serves every tool that parks a secret in a live target: the
        // terminal PTY and the Ego Lite browser share one host-side request map and
        // one status endpoint, so only the tool key list differs. `secret_reveal` reads
        // instead of writes, so it gets the reveal variant of the same card.
        const rows = { secret_exec: SecretExecRow, secret_browser: SecretExecRow, secret_reveal: SecretRevealRow }
        for (const [key, Row] of Object.entries(rows)) {
          ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
            name: 'tool.call.toolview',
            key,
          }, Row))
        }
        ctx.effect(() => () => {
          for (const callId of activeCallIds) void api({ op: 'cancel', callId }).catch(() => {})
          activeCallIds.clear()
        })

        // Report what the sidebar browser actually is, and keep watching: the panel may be
        // opened long after this bundle loads. An Electron <webview> exposes
        // executeJavaScript across origins; a plain <iframe> does not. Which one DSH
        // renders decides whether this plugin can fill that panel at all.
        let lastProbeKey = ''
        const probeTick = () => {
          try {
            const views = Array.from(document.querySelectorAll('webview, iframe')).map((el) => ({
              tag: el.tagName.toLowerCase(),
              src: (el.getAttribute('src') || '').slice(0, 120) || null,
              partition: el.getAttribute('partition') || null,
              canExecute: typeof el.executeJavaScript === 'function',
              ready: el.tagName.toLowerCase() === 'webview' ? el.getAttribute('src') !== null : true,
            }))
            const key = `${window.location.href}|${JSON.stringify(views)}`
            if (key === lastProbeKey) return
            lastProbeKey = key
            void api({ op: 'probe', payload: { views, href: window.location.href, at: new Date().toISOString() } }).catch(() => {})
          } catch { /* a probe must never break the panel */ }
        }
        const probeTimer = setInterval(probeTick, 2000)
        probeTick()
        ctx.effect(() => () => clearInterval(probeTimer))
      }

      module.exports = { name: 'dsh-secret-form/client', inject: ['slots'], apply }
      return module.exports
    },
  })
})()
