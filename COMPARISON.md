# 和已有插件的关系

DSH 生态里已经有好几个「敏感值」插件。它们各做一段，本项目把链子接起来：**索取 → 投递 → 展示**。

调研时间 2026-11-06，依据是各仓库的 `package.json` 与 README，以及 dshfind 插件索引（6272 条）。

| 能力 | 本插件 | 已有实现 | 差别 |
|---|---|---|---|
| 对话内弹卡片索取密钥，明文不进模型 | ✅ `secret_exec` / `secret_browser` / `secret_reveal` 的卡片 | ✅ [dsh-password-prompt](https://github.com/MagicCrazyMan/dsh-password-prompt)、[dsh-credential-handoff](https://github.com/xiaohj233/dsh-credential-handoff) | 这张卡片已经有人做了，我们不假装首创 |
| 终端提示自动识别 + 直接写入 PTY | ✅ | — | `sudo` / `ssh` / `passwd` 出现提示就弹卡，重试自带 `Sorry, try again.` 反馈 |
| 填 **DSH 内置侧边栏浏览器** 的表单 | ✅ | [dsh-inner-browser-use](https://github.com/regrevia/dsh-inner-browser-use) 能驱动面板，但输入文本必须由模型提供 | 这里的值从 host 直达 `webview.executeJavaScript`，模型拿不到 |
| 外部浏览器（Ego Lite）投递 | ✅ | — | 值走 0600 一次性交接文件，不进 argv、不进脚本正文 |
| 把**已存在**的密钥展示给人看，模型只拿键名 | ✅ `secret_reveal` | — | 别人是「把值给模型」或「给模型一个句柄」，没有「只给人看」这一档 |
| 写进 DSH 凭据库、只回引用名 | 卡片勾选后可写 | ✅ [dsh-credential-handoff](https://github.com/xiaohj233/dsh-credential-handoff) | 它的 README 明确写了不做子进程注入；我们负责投递 |
| 凭据库管理界面 / TOTP / 密码生成 | 后续版本 | ✅ [dsh-vault](https://github.com/Ox0400/dsh-vault)（AES-256-GCM + TOTP + 设置页） | 规划中：复用 DSH 凭据服务，不自建加密库 |
| 句柄化 + 出口打码 | 不做 | ✅ [dsh-secret-vault](https://github.com/yuloop/dsh-secret-vault) | 那是另一套模型（你粘贴、agent 拿句柄干活），不冲突 |

## 什么时候该用别人

- **只想让 agent 拿到一把 API key 去调工具**：`dsh-credential-handoff` 更小、只管这一件事。
- **想要加密保险库、TOTP、跨设备管理**：`dsh-vault` 已经做完，别再用这个凑。
- **要让 agent 浏览、点击、读页面**：`dsh-inner-browser-use` 或 `dsh-browser-agent`，它们做通用自动化；本插件只碰「要填密码的那一步」。
- **想把一堆东西粘进去、让 agent 拿着句柄干活**：`dsh-secret-vault`。

## 不做什么

- 不自建加密存储：值存 DSH 凭据服务（`ctx.credentials`）。
- 不做通用浏览器自动化。
- 不处理 SSH 首次连接的 yes/no、MFA 选项、任意 stdin 提示。
- 不读回凭据值给模型——唯一例外是 `secret_reveal` 的卡片（值只在界面上）。

## 名字

`dsh-secret-form` 这个名字和 [unera/dsh-secret-form](https://github.com/unera/dsh-secret-form)（npm `@dr-co/dsh-secret-form`，做一次性密钥链接）撞了，是两个不同项目。
