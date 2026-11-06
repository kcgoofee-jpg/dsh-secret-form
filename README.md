# dsh-secret-form

为 DSH Desktop 提供敏感输入卡片和一次性终端密码注入。Agent 请求运行命令后，host 在临时、私有 PTY 中执行；当输出出现受支持的密码/验证码提示时，聊天工具行显示「打开安全表单」。输入值由 client 直接发给 host，再写入该 PTY。Agent 只收到脱敏后的命令输出和结束状态。

适用示例：`ssh root@example-host 'sudo passwd root'`。SSH 首次连接的 yes/no 主机指纹确认、覆盖确认等非密码提示不会自动获准输入，也不会把 secret 投给那个提示。

## 安装

要求 DSH Desktop `0.2.2-rc.1` 或更新的 `0.2.x`，且插件组合已启用官方 PTY、subprocess、sandbox、working-directory 和 credentials 服务。

可以直接从 DSH 界面安装本地目录：打开 **Plugins → Add plugin**，粘贴本目录的绝对路径并安装。DSH 的插件安装对话框支持绝对本地路径。

也可以手动放进桌面 profile 的插件目录：

```sh
mkdir -p ~/.dsh/profiles/desktop/node_modules
cp -R /path/to/dsh-secret-form ~/.dsh/profiles/desktop/node_modules/dsh-secret-form
```

安装后在 Plugins 页确认 `dsh-secret-form` bundle 已启用，并重启 DSH Desktop。`cordis.patch.yml` 会插入 host 插件工具和所需服务注入项；包的 `dsh.client` 配置会加载聊天工具行组件。

## 三分钟上手

三种典型调用，AI 直接照抄改参数就行。

**终端里要密码**

```json
{
  "command": "ssh -t owl-new 'sudo passwd root'",
  "prompt": "为 owl-new 的 root 改密码",
  "label": "SSH + sudo",
  "rules": { "minLength": 12 }
}
```

**网页单个密码框**

```json
{
  "engine": "dsh",
  "url": "https://example.com/login",
  "selector": "input[name=\"password\"]",
  "submit_selector": "button[type=\"submit\"]",
  "verify_selector": "body",
  "autocomplete": "current-password",
  "prompt": "登录 example.com",
  "label": "example.com 密码"
}
```

**网页一次改三个密码**

```json
{
  "engine": "dsh",
  "url": "https://example.com/settings/password",
  "fields": [
    { "selector": "input[autocomplete=\"current-password\"]", "label": "当前密码" },
    { "selector": "input[autocomplete=\"new-password\"] >> nth=0", "label": "新密码", "rules": { "minLength": 12 } },
    { "selector": "input[autocomplete=\"new-password\"] >> nth=1", "label": "确认新密码", "rules": { "minLength": 12 } }
  ],
  "submit_selector": "button:has-text(\"修改密码\")",
  "verify_selector": "body",
  "verify_delay_ms": 1500,
  "autocomplete": "new-password",
  "prompt": "修改 example.com 的后台密码"
}
```

判断顺序：有命令跑 → `secret_exec`；要在网页里填 → `secret_browser`；面板里已经打开那站点 → `engine: "dsh"`（默认），否则 `engine: "ego"`。

## 识别的提示语

提示必须在输出**尾部**（去掉 ANSI 后，行尾就是 `:` 或 `：`），也就是 CLI 确实停在等待输入的状态。

| 类别 | 词表 |
| --- | --- |
| 密码 | `password`、`passphrase`、`pass phrase`、`passcode` |
| 短码 | `pin`、`pin code`、`otp`、`2fa code` |
| 授权码 | `auth code`、`authentication code`、`access code`、`unlock code` |
| 一次性 | `one-time password`、`one time code` |
| 验证 | `verification code`、`security code` |
| 中文 | `密码`、`验证码`、`认证码`、`动态码`、`口令` |

名词和冒号之间允许三种修饰：`for <target>`（`password for root@host:`）、括号补充（`passphrase (empty for no passphrase):`、`password (again):`）、`again`（`passphrase again:`）。大小写不敏感，ANSI 颜色和 `\r\n` 不影响识别。

`spin:`、`hotspot:`、`pinned:` 这类把 `pin`/`otp` 藏在普通单词里的输出不会误触发表单。

内置词表覆盖不到的自定义提示，在 `cordis.patch.yml` 里加 `extraPromptPatterns`（大小写不敏感的正则数组，最多 16 条，无效正则会被静默跳过）：

```yaml
config:
  extraPromptPatterns:
    - 'enter\s+(?:the\s+)?unlock\s+code'
    - '解锁口令'
```

## 使用

让 Agent 使用 `secret_exec`，并给出不包含敏感值的命令、用户提示和卡片标签。比如：

```text
使用 secret_exec 执行 ssh root@example-host 'sudo passwd root'。
prompt 写“为 example-host 修改 root 密码”，label 写“SSH 密码”。
```

当终端输出受支持的密码提示时，点击聊天中的安全输入卡片，填写密码后提交。命令可以连续询问多次，例如当前密码、新密码及确认密码；每次受支持的提示都会重新打开输入流程。

**重试会自己回到眼前。** 用户提交过一次之后，下一条提示到来时模态框自动重新打开，不用回头找那张卡；卡片上会标出「第 N/8 次输入」，并把两次提示之间的终端输出（例如 sudo 的 `Sorry, try again.`）原样显示在输入框上方，所以密码被拒时能立刻看到原因。主动取消（Esc、×、点遮罩）之后不会再自动打开。

**结束的卡片会收成一行。** 命令完成后，卡片折叠成一条 12px 的灰色状态行（`· 已完成` / `· 已取消` / `· 执行失败`），不再占版面；hover 可以看到标签和状态。完整的命令输出仍然在工具结果里。

**CLI 自己放弃提示时，卡片立刻结束。** `sudo` 这类程序有内部超时，到点会自己退出并打印 `sudo: a password is required`。此时 PTY 已经关闭，没人会再读那个输入，所以插件不再等满 `timeout_ms`，而是直接按命令的真实退出码收尾（上例就是 `failed` / `exit 1`），卡片当场消失。

取消按钮、Esc、输入等待超时或 Agent 取消都会终止本次私有终端操作。

勾选「安全保存到凭据库」会把这次输入写进 DSH credentials 服务，工具结果只回一个引用名（`DSH_SECRET_…`），不回值。多字段表单按字段分别保存（`DSH_SECRET_…_1` / `_2` / `_3`）。

这个选择会被记住：同一轮里后续字段自动沿用，下一次调用也沿用上一次的选择（存在 localStorage，键 `dsh-secret-form:save-to-vault`）。

⚠️ DSH 的设置页里**没有凭据管理界面**（只有 account / general / models / plugins / agent-presets 五个 section）。它的实体是 `~/.dsh/.credentials.yaml` 的 `refs:` 段，要查看或删除只能直接改那个文件。所以勾选前想清楚 —— 存下来方便，但删起来要手动。

## 浏览器表单（`secret_browser`）

`secret_exec` 只能往 PTY 里写，网页表单没有终端。同一张安全卡片因此有第二个目标 `secret_browser`，它有两个引擎：

| 引擎 | 目标 | 机制 |
|---|---|---|
| `dsh`（默认） | **DSH 侧边栏的浏览器面板** | `webview.executeJavaScript` —— 不需要 CDP，跨域也能注入 |
| `ego` | Ego Lite | `page.fill()`（Playwright 语义） |

侧边栏面板之所以能被控制：它是 Electron 的 `<webview>`，而本插件的 client 半边和它渲染在**同一个页面**里，直接调 `executeJavaScript` 就行。不需要远程调试端口，也不需要 browser-use provider。

`dsh` 引擎找不到打开的 webview 时自动回退到 `ego`。

### 参数

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✅ | 卡片上的上下文说明 |
| `label` | | 卡片标题；多字段时自动拼成 `标题 · 字段名` |
| `selector` | 单字段 | CSS / Playwright 选择器 |
| `fields` | 多字段 | 数组，每项 `{ selector, label, prompt }`，按声明顺序各弹一张卡 |
| `submit_selector` | | 全部填完后点击的元素 |
| `verify_selector` | | 提交后读回该元素的文本，附在结果里 —— 页面说成功才算成功 |
| `url` | | `dsh`：用来匹配该站点的 webview（避免填到别的标签页）；`ego`：先导航到该页 |
| `engine` | | `dsh` / `ego`，默认 `dsh` |
| `rules` | | 实时校验规则，见下 |
| `autocomplete` | | `current-password` / `new-password` / `one-time-code` / `off` |
| `space` | | 仅 `ego`：TaskSpace 的 id 或名字 |
| `timeout_ms` | | 每步等待，默认 45000，上限 120000 |

### 选择器语法

原生 CSS，外加三个扩展（`dsh` 引擎内置了一个等价解析器，所以两边写法一致）：

| 写法 | 作用 |
|---|---|
| `#id` / `.class` / `input[name="password"]` | 标准 CSS |
| `input[autocomplete="new-password"] >> nth=0` | 取第 N 个匹配项（同名新密码框、确认框常用） |
| `button:has-text("修改密码")` | 文本包含 |
| `button:text-is("登录")` | 文本完全相等 |

### 实时校验（`rules`）

插件不知道哪个站点要几位、要不要大小写 —— 规则由**调用的 AI 从页面上读出来**再传进来：

```json
{ "minLength": 12, "requireDigit": true, "requireSymbol": true }
```

输入时卡片下方出现四段强度条（红 → 琥珀 → 黄绿 → 绿），配一句人话：`偏弱 · 还差 1 位`。规则没满足时**提交按钮直接禁用**，不用等服务器驳回。

不传 `rules` 时，强度按长度 + 字符种类估算。

### 值到浏览器的路径

`dsh` 引擎：

1. host 弹卡片，用户填写
2. host 通过 `status` 响应（`no-store`）把值交给 client，带一次性 token
3. client 按 `url` 匹配 webview，`executeJavaScript` 注入：原生 `value` setter + `input`/`change` 事件（React 受控组件靠这个才会更新）
4. client 回报结果，host 收尾

`ego` 引擎：

1. host 写一个 `0600` 一次性文件（`randomBytes(16)` 命名）
2. host 启动 `ego-browser nodejs`，脚本从 stdin 送入
3. 脚本第一步读文件并 `unlink`，再 `page.fill`
4. 值不进 argv、不进脚本正文、不进工具结果

为什么 `ego` 不能用本地端点：Ego Lite 的 Node 沙箱里 `node:fs` 可用，但对外网络是封的（全局 `fetch` 和 `node:http` 都会挂起）。文件是这个沙箱里唯一能穿过去的通道。

已登录的站点没有密码框可填 —— 有活跃会话时直接就是登录态。

## 参考

- [DSH Web Client Slots](https://deepseek-harness.github.io/deepseek-harness/reference/subsystems/slots.md) —— slot 的所有权、cardinality、组件输入与扩展规则
- [DSH Web client 架构](https://github.com/deepseek-ai/deepseek-harness/blob/8bd3278/.agents/notes/archived/architecture/2026-07-19-gui-web-client-architecture.md) —— 客户端 cordis 树与 slot 组合方式
- [Chromium: Password Form Styles](https://chromium.googlesource.com/experimental/website/+/90ada2e550d4e3bce2c59da0c9eacb3e7b9a2a67/site/developers/design-documents/form-styles-that-chromium-understands.md) —— 浏览器如何识别密码字段
- [Unmasking the Security and Usability of Password Masking](https://par.nsf.gov/biblio/10633523/media/xml) —— 遮罩对可用性的影响

## 出错时会怎样

卡片背后是一个同源 POST 接口，它的失败语义分得比较细 —— 因为「重试有用」和「重试没用」是两件事：

| 状态 | 含义 | 调用方该做什么 |
|---|---|---|
| `400` | 请求体不是合法 JSON，或提交内容不合法（callId / challenge / value） | 修请求，重试无意义 |
| `404` | 这个 `callId` 没有活的请求（已完成、已取消、或从未存在） | 不要重试 |
| `405` | 用了 POST 以外的方法 | 改方法 |
| `409` | 输入请求已经不在等待（超时、取消、或已提交过） | 不要重试 |
| `413` | 请求体超过 16 KB | 缩小请求体后重试 |
| `403` | 同源校验或 DSH 载体准入拒绝 | 检查来源 |

并发：多个 `secret_exec` / `secret_browser` 可以同时进行，`callId` 各自独立，互不排队也不互相清理。同一 `callId` 重复发起会被拒绝。

## 注入代码为什么不怕奇怪的密码

`<webview>` 的 `executeJavaScript` 在 Electron 的安全实践里是敏感 API —— 它执行字符串。而这里的字符串是**拼出来的**，值一旦转义不当就可能改变语义甚至逃逸。

防线只有一条，但是够用：密码值经 `JSON.stringify` 变成 JS 字符串字面量，**不是拼接、不是模板替换**。实测七种刁钻输入：

| 输入 | 结果 |
|---|---|
| `he said "hi"` | 原样落进输入框 |
| `back\slash\\double` | 原样 |
| `</script><img src=x onerror=alert(1)>` | 原样，**不执行** |
| `` tick ` and ${injection} `` | 原样 |
| `sep\u2028here` | 原样（U+2028 在 ES2019 后是合法字符串内容） |
| `it's fine` | 原样 |
| `line1\nline2` | 落进去是 10 字符而非 11 —— `<input>` 丢弃换行，是单行控件的正常行为 |

`</script>` 那句值得单独说：它之所以不生效，是因为注入目标**不是 HTML 上下文**，而是 `executeJavaScript` 的 JS 求值上下文，`JSON.stringify` 把 `<` `/` 都留在字符串字面量内部，不会被解析成标签。

**这也是为什么选择器也必须走 `JSON.stringify`** —— 同一个理由。

## 一些设计取舍

**遮罩是默认，但明眼可开。** 研究反复表明密码遮罩的安全收益有限、却会明显拖慢输入并推高错误率；行业共识是默认遮罩 + 一个显式切换。卡片就是这么做的：默认 `type=password`，眼睛按钮切到明文。

**粘贴必须可用。** 阻止粘贴的密码框是反模式 —— 它会逼用户手敲长密码，而密码管理器正是为了不手敲。所以输入框显式放开粘贴事件（`onPaste` 只做 `stopPropagation`，不拦截）。

**`autocomplete` 分场景，但别指望 `off`。** 现代浏览器（尤其 Chrome/Safari）对密码字段的 `autocomplete="off"` 基本无视，密码管理器照样会提议。所以这里提供 `current-password` / `new-password` / `one-time-code` 三个「有意义的」值，`off` 只是留个口子，别为它设计交互。

**规则来自调用方，不来自插件。** 插件无从知道某个站点要几位、要不要符号 —— 那是读页面的 AI 的活。插件只负责把规则变成实时反馈，并在不满足时禁用提交。

**一个表单多个字段时，每个字段有自己的规则。** 改密表单的三个框策略不同，`fields[].rules` 覆盖调用级的 `rules`。

## 自测

先运行无外部服务的 host 自测：

```sh
cd /path/to/dsh-secret-form
npm run self-test
npm run check-tokens
```

`npm run self-test` 会覆盖：提示语词表与误伤反例、`extraPromptPatterns`、反馈提取、短 secret 标记、SSH 密码提示下的提交、PTY 回写、Vault 明确选择、输出脱敏、「第一次被拒 → 第二个提示带 `Sorry, try again.` → 换新 challenge → 成功」的重试链路，以及「CLI 自己退出后不再空等 `timeout_ms`」的收尾行为。

`npm run check-tokens` 检查 `client.js` 用到的每个 CSS 自定义属性都由已安装的 DSH 定义。UI 只使用设计 token（字号、圆角、阴影、按钮配色），这个脚本防止拼错或版本漂移导致组件悄悄退回硬编码默认值。

之后在 DSH Desktop 手动验证：

1. 安装并启用插件，重启 DSH；确认 `secret_exec` 工具可用。
2. 在可丢弃的测试主机上运行 `ssh <test-user>@<test-host> 'sudo passwd <test-user>'`。不要把密码写进命令。
3. 终端出现密码提示时，点击「打开安全表单」；确认密码默认隐藏，显示/隐藏、Enter、取消和 Esc 均有效。
4. 完成改密流程后检查工具结果和聊天记录；输入值不应出现在任一处。测试保存时，结果只应包含 Vault 引用名。
5. 分别测试错误密码、取消、超时、命令非零退出及多个连续密码提示。

真实场景回归可以用这几条本地命令，它们会走到和真实 CLI 相同的路径：

```sh
# 真实系统密码提示（macOS/Linux），填错会重试并自动重开表单
sudo -k; sudo -v; echo "sudo_exit=$?"

# 单次隐藏输入，打印长度而不打印值
stty -echo; printf 'Password: '; IFS= read -r v; stty echo; printf '\n[ok] %d chars\n' "${#v}"

# 三段式改密，两次不一致会走失败分支
stty -echo; printf 'Current password: '; IFS= read -r c; printf '\nNew password: '; IFS= read -r a; printf '\nRetype new password: '; IFS= read -r b; printf '\n'; stty echo; [ "$a" = "$b" ] && echo 'passwd: password updated successfully' || { echo 'passwd: passwords do not match'; exit 1; }

# 脱敏验证：故意不关回显，命令回显输入值，结果里应出现 [REDACTED]
printf 'Password: '; IFS= read -r v; printf 'you typed: %s\n' "$v"

# 非密码提示：不应弹表单，命令自己退出
printf 'Are you sure you want to continue connecting (yes/no)? '; sleep 3; echo; exit 124
```

## 安全边界

- `command`、`prompt`、`label` 是普通工具参数，会进入 DSH 的工具记录；严禁把密码、token 或其他 secret 写在 `command` 中。
- Secret 不经过模型工具参数或普通工具结果；host 只把它写入自己创建的 PTY，并在返回 PTY 输出前按输入值脱敏。
- 重试反馈同样走脱敏：两次提示之间的输出会先用已知 secret 打码，再显示到卡片上。
- 短于 4 个字符的 secret 仍然会被脱敏（子串替换可能连带遮住无关输出），此时结果里会追加一行提示说明可能过度匹配。
- PTY 继承 DSH 的 subprocess 环境清理，并用当前 Agent 的 sandbox 策略约束。一个执行最多等待 10 分钟；每个用户输入等待默认 120 秒、最多 600 秒，最多处理 8 次密码提示（可用 `maxPromptCount` 调整，上限 20）。
- 输入值经本机 DSH Web Server 的同源 POST 从 UI 传给 host；请求只存在内存中，并设置 `no-store`。插件不会创建自己的文件或写日志。
- Vault 复用 DSH credential reference 存储。用户勾选后即意味着持久保存；可在 DSH 凭据管理界面按返回的引用名管理它。
- 本插件不会修改 DSH 主干文件。它只支持 DSH Desktop，不处理 SSH yes/no 确认、MFA 选择、浏览器表单或任意 stdin 提示。
