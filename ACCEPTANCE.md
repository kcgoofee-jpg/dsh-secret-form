# 验收清单

自动化能覆盖的都在 `npm run self-test` 里。这份清单只列**必须人来点一下**的部分，以及每条的判据。

跑之前：

```sh
cd /path/to/dsh-secret-form
npm run self-test && npm run check-tokens && npm run check-readme
```

三条全绿再往下。**client 侧改动需要 Cmd+R 刷新页面**才生效。

---

## A. 三字段表单（内置面板）

**前置**：DSH 右侧浏览器面板打开 `gate.davidzhao.top/admin/system`，且已登录。

```json
{
  "engine": "dsh",
  "url": "https://gate.davidzhao.top/admin/system",
  "fields": [
    { "selector": "input[autocomplete=\"current-password\"]", "label": "当前密码" },
    { "selector": "input[autocomplete=\"new-password\"] >> nth=0", "label": "新密码", "rules": { "minLength": 12 } },
    { "selector": "input[autocomplete=\"new-password\"] >> nth=1", "label": "确认新密码", "rules": { "minLength": 12 } }
  ],
  "prompt": "改后台密码，不提交"
}
```

| 判据 | 预期 |
|---|---|
| 卡片标题 | `猫头鹰… · 当前密码` / `· 新密码` / `· 确认新密码`，逐张变化 |
| 第三张之后 | 三个输入框都有圆点，长度与填写一致 |
| 强度条 | 新密码不足 12 位时提交禁用、条为红；够 12 位转绿 |
| 取消 | 中途按 Esc，结果应为 `cancelled` + 「已填内容全部丢弃，浏览器未被修改」 |

---

## B. 跨站点匹配（两个 webview 并存）

**前置**：面板里同时开着 `gate.davidzhao.top` 和 `accounts.google.com`。

```json
{
  "engine": "dsh",
  "url": "https://accounts.google.com/signin",
  "selector": "input[type=\"email\"]",
  "prompt": "填邮箱，不提交"
}
```

| 判据 | 预期 |
|---|---|
| 填入位置 | **Google 那个标签页**，后台页面纹丝不动 |
| 不给 url 时 | 报错 `no webview matches this site, and 2 are open`，什么都不填 |

---

## C. verify_selector 的真实措辞

**前置**：任意会返回明确结果的后台表单。

```json
{
  "engine": "dsh",
  "url": "https://gate.davidzhao.top/admin/system",
  "fields": [{ "selector": "input[autocomplete=\"current-password\"]", "label": "当前密码" }],
  "submit_selector": "button:has-text(\"修改密码\")",
  "verify_selector": "body",
  "verify_delay_ms": 1500,
  "prompt": "验证改密结果"
}
```

| 判据 | 预期 |
|---|---|
| 结果末尾 | 出现 `[page says] …`，内容是页面自己那段话 |
| 校验失败时 | 那段话里能直接看出原因（如「新密码至少需要 12 个字符」） |
| ego 引擎对比 | 同样传 `verify_selector`，输出格式**一致**都是 `[page says]` |

---

## D. 终端通道

```json
{ "command": "sudo -k; sudo -v; echo \"exit=$?\"", "prompt": "授权 sudo", "rules": { "minLength": 1 } }
```

| 判据 | 预期 |
|---|---|
| 首次输错 | 卡片自动重开，上方出现 `Sorry, try again.`，副标题 `第 2/3 次` |
| 输对 | `exit=0`，值不出现在结果里 |
| 取消 | 终端被 Ctrl+C 中断，**命令序列的后续语句不执行** |

---

## E. 界面细节

| 检查 | 判据 |
|---|---|
| 眼睛图标 | 睁眼/斜线两只 SVG，点击切换明文与圆点 |
| 勾选框 | 勾过之后，下一张卡自动带勾；刷新页面后仍然记得 |
| 卡片结束 | 收成一行 12px 灰字，不是整块消失也不是留着 |
| 提示区 | 只有终端那一行（等宽灰底），上面是解释文字，两者不混在一起 |
| 深色模式 | 切换主题，卡片背景/边框/文字跟着走，不出现死白或死黑 |

---

## 已知边界

| 现象 | 原因 |
|---|---|
| 内置面板未打开时 `engine: "dsh"` 会回退到 Ego | 设计如此，fallback 不是替代 |
| 已登录站点没有密码框可填 | 浏览器有会话就直接是登录态 |
| DSH 设置里找不到凭据库 | 它没有 UI，实体是 `~/.dsh/.credentials.yaml` |
| 多字段保存到凭据库时 ref 带 `_1/_2` 后缀 | 每个字段独立一条 |
