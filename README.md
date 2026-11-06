# dsh-secret-form

给 DSH 一套安全输入卡片。密码、验证码、密钥只在用户和 host 之间走，**不进模型上下文、不进对话记录**。三种用途：

| 工具 | 场景 |
|---|---|
| `secret_exec` | 终端里要密码（`sudo`、`passwd`、`ssh` 私钥口令…） |
| `secret_browser` | 网页表单要密码（DSH 侧边栏浏览器，或 Ego Lite） |
| `secret_reveal` | 把服务器/文件里**已经存着**的密钥展示给用户看，模型读不到值 |

## 安装

要求 DSH Desktop `>= 0.2.2-rc.1 < 0.3.0`。

DSH 里 **Plugins → Add plugin**，粘贴本目录绝对路径即可。等价的手动安装：

```sh
mkdir -p ~/.dsh/profiles/desktop/node_modules
cp -R /path/to/dsh-secret-form ~/.dsh/profiles/desktop/node_modules/dsh-secret-form
```

装完重启 DSH，在 Plugins 页确认 `dsh-secret-form` 已启用。

## 三分钟上手

**终端要密码**

```json
{
  "command": "ssh -t owl-new 'sudo passwd root'",
  "prompt": "为 owl-new 的 root 改密码",
  "label": "SSH + sudo",
  "rules": { "minLength": 12 }
}
```

**网页登录**

```json
{
  "engine": "dsh",
  "url": "https://github.com/login",
  "fields": [
    { "selector": "#login_field", "label": "账号" },
    { "selector": "#password", "label": "密码" }
  ],
  "submit_selector": "input[type=\"submit\"]",
  "verify_selector": "body",
  "autocomplete": "current-password",
  "prompt": "登录 GitHub"
}
```

**看存着的密钥**

```json
{
  "command": "ssh owl-new 'cat /opt/service-tools/.env'",
  "prompt": "owl-lax 后台管理界面的环境变量",
  "label": "owl 服务器密钥",
  "format": "dotenv"
}
```

怎么选：要跑命令 → `secret_exec`；要填网页 → `secret_browser`（侧边栏已开着该站点用 `engine: "dsh"`，否则 `engine: "ego"`）；要**看**已存在的密钥 → `secret_reveal`。

## 识别的提示语

提示必须在输出**尾部**，也就是 CLI 真的停在等输入的状态。

| 类别 | 词表 |
|---|---|
| 密码 | `password`、`passphrase`、`passcode` |
| 短码 | `pin`、`pin code`、`otp`、`2fa code` |
| 授权码 | `auth code`、`access code`、`unlock code`、`security code` |
| 一次性 | `one-time password`、`verification code` |
| 中文 | `密码`、`验证码`、`认证码`、`动态码`、`口令` |

名词和冒号之间可以夹 `for <target>`、括号补充、`again`。`spin:`、`hotspot:` 这类把 `pin` 藏在单词里的不会误触发。

内置词表覆盖不到的提示，在插件配置里加正则（最多 16 条）：

```yaml
config:
  extraPromptPatterns:
    - 'enter\s+(?:the\s+)?unlock\s+code'
    - '解锁口令'
```

## `secret_browser`

| 参数 | 必填 | 说明 |
|---|---|---|
| `prompt` | ✅ | 卡片上的上下文 |
| `label` | | 卡片标题；多字段自动拼成 `标题 · 字段名` |
| `selector` | 单字段 | CSS / Playwright 选择器 |
| `fields` | 多字段 | `{ selector, label, prompt, rules }` 数组，按顺序各弹一张卡 |
| `submit_selector` | | 全部填完后点击的元素 |
| `verify_selector` | | 提交后读回该元素文本 —— 页面说成功才算成功 |
| `url` | | `dsh`：用它匹配该站点的 webview；`ego`：先导航过去 |
| `engine` | | `dsh`（默认，侧边栏）/ `ego` |
| `rules` | | 见下 |
| `autocomplete` | | `current-password` / `new-password` / `one-time-code` / `off` |
| `timeout_ms` | | 每步等待，默认 45000，上限 120000 |

`fields` 里每项还可以带 `secret`。账号、邮箱这类**不是密钥**的字段设为 `false`，卡片就当普通文本框用：不打码、没有强度条、不提供保存；不写则按选择器推断（`type=password` 或选择器里带 password/otp/code 的算密钥，`autocomplete=username|email` 的不算）。

选择器支持原生 CSS 加三个扩展：

| 写法 | 作用 |
|---|---|
| `input[name="password"]` | 标准 CSS |
| `input[autocomplete="new-password"] >> nth=0` | 第 N 个匹配项 |
| `button:has-text("修改密码")` | 文本包含 |
| `button:text-is("登录")` | 文本完全相等 |

`rules` 由调用方从页面上读出来再传进来 —— 插件不知道哪个站点要几位：

```json
{ "minLength": 12, "requireDigit": true, "requireSymbol": true }
```

满足不了就禁用提交，下方配一条强度条和一句人话（`偏弱 · 还差 1 位`）。不传 `rules` 时按长度和字符种类估算。

## `secret_reveal`

跑一条命令，把 stdout 解析成键值对，**值只写进卡片**：工具结果里只有键名和脱敏后的输出。

| 参数 | 必填 | 说明 |
|---|---|---|
| `command` | ✅ | 例如 `ssh host 'cat /opt/app/.env'`，不能含密钥本身 |
| `prompt` | ✅ | 卡片上的上下文 |
| `label` | | 卡片标题，默认「密钥」 |
| `format` | | `auto`（默认）/ `dotenv` / `json` / `lines` |
| `keys` | | 只展示这些键名，大小写不敏感 |
| `timeout_ms` | | 每条终端提示的等待，默认 120000 |
| `reveal_timeout_ms` | | 卡片停留时长，默认 300000，上限 900000 |

卡片里每项都可以单独按眼睛看明文、单独复制，也可以「全部复制」。命令中途要密码（比如 ssh 私钥口令）时照样弹输入卡，走的还是同一套流程。

## 安全

- `command`、`prompt`、`label` 是普通工具参数，会进工具记录；**永远不要把密钥写在里面**。
- 用户输入的密码走同源 POST 从 UI 传给 host，只存在内存，`no-store`；host 只把它写进自己创建的 PTY，返回前按已知值脱敏。
- 勾选「保存到凭据库」会写进 `~/.dsh/.credentials.yaml` 的 `refs:` 段 —— DSH 设置页没有凭据管理界面，删只能手改那个文件。
- 单次执行最多 10 分钟，每条提示最多等 600 秒，最多 8 次提示（`maxPromptCount` 可调到 20）。
