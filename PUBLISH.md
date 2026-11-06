# 发布到 DSH 生态

三条路，彼此独立，可以只走其中一条。

---

## 一、自建插件市场索引（最快，不需要任何人审核）

任何人都能发布一个「市场索引」—— 一个 JSON 文件加一个 `icons/` 目录，放在任意静态主机上。用户在 **插件 → 发现 → 添加索引源** 里填你的索引 URL 就能看到。

### 目录结构

```
site/
  index.json
  icons/
    dsh-secret-form.svg
```

`icon: "icons/dsh-secret-form.svg"` 是**相对于索引 URL** 解析的，所以索引和图标并排放，换主机也不用改文件。

### `index.json`

```json
{
  "format": 1,
  "title": { "en": "davidzhao plugins", "zh": "davidzhao 插件" },
  "description": {
    "en": "Secure input cards for DSH.",
    "zh": "给 DSH 用的安全输入卡片。"
  },
  "plugins": [
    {
      "name": "dsh-secret-form",
      "title": { "en": "Secure input cards", "zh": "安全输入卡片" },
      "description": {
        "en": "Collects passwords through a card instead of the conversation: terminal prompts, sidebar browser forms, and Ego Lite.",
        "zh": "通过卡片向用户索取密码，而不是让值进入对话：终端提示、侧边栏浏览器表单、Ego Lite。"
      },
      "icon": "icons/dsh-secret-form.svg",
      "author": "davidzhao",
      "homepage": "https://github.com/kcgoofee-jpg/dsh-secret-form#readme",
      "repository": {
        "url": "https://github.com/kcgoofee-jpg/dsh-secret-form",
        "directory": "."
      },
      "metadata": { "category": "security" },
      "versions": [
        {
          "version": "0.1.0",
          "publishTimestamp": 1793958000,
          "source": {
            "type": "git",
            "url": "https://github.com/kcgoofee-jpg/dsh-secret-form",
            "commit": "0000000000000000000000000000000000000000"
          },
          "engines": { "dsh": ">=0.2.2-rc.1 <0.3.0" }
        }
      ]
    }
  ]
}
```

把 `USER` 和 `commit` 换成真值。`commit` 必须是 **40 位十六进制 SHA**，否则索引整体被拒。

### 硬性规则（违反任意一条，DSH 拒绝整个索引）

| 规则 | 说明 |
|---|---|
| `format` | 必须是 `1` |
| `plugins[].name` | 索引内唯一 |
| `plugins[].versions` | 至少一个 |
| `version` | 精确 SemVer，插件内唯一 |
| `source.type: git` | `url` 必须 https，`commit` 必须 40 位 hex |
| `icon` 内联 | `data:` URL，≤ **32 KiB**；外链则走相对路径或 https 绝对地址 |
| 索引体积 | 默认 ≤ 128 MiB，2xx 返回且不重定向 |
| `LocalizedText` | 对象必须以 `en` 为键之一 |

`engines.dsh` 要跟包自身 `package.json` 里的一致（本插件是 `>=0.2.2-rc.1 <0.3.0`）。

### 用官方生成器

仓库带一个生成器，从纯文本列表建索引：

```sh
pnpm --filter @deepseek-ai/dsh-plugin-market-generator start \
  --input plugins.txt --output site/index.json --title "davidzhao plugins"
```

`plugins.txt` 每行一个 npm 包名或 https Git URL。**它只读文件，不安装、不执行代码。**

---

## 二、GitHub：加 `dsh-plugin` topic

官方仓库**当前不接受外部 PR**。生态参与的标准路径是：

1. 插件做成独立 GitHub 仓库
2. 仓库 **Settings → Topics** 加 `dsh-plugin`（可同时加 `deepseek-harness`）
3. 收录雷达每 6–8 小时自动扫一次 topic

加 topic 后的自动扫描层级：

```
L0 发现（topic）
L1 清单（package.json / exports / dsh 声明）
L2 静态兼容
L3 编译实验
L4 运行实测（K8s agent 跑最小任务）
```

「收录 ≠ 兼容 ≠ 可用 ≠ 安全审计」，四个结论要分开看。

### 自动扫描的最低条件

| # | 条件 | 本插件 |
|---|---|---|
| 1 | 仓库公开 + `dsh-plugin` topic | 待做 |
| 2 | 根目录合法 `package.json`，`name` 非空 | ✅ `dsh-secret-form` |
| 3 | `main`/`exports` 或明确的 `dsh` 入口 | ✅ `exports` + `dsh.bundle` |
| 4 | README 说明做什么、怎么装、怎么卸、最小示例 | ✅ 281 行 |
| 5 | 运行时依赖显式声明 | ⚠️ 只有 `peerDependencies.cordis`，无 runtime 依赖 |
| 6 | 声明支持的 DSH 版本 | ✅ `dsh.compatibility` |
| 7 | 有许可证，不含密钥 | ⚠️ 有 `license: MIT`，但没有 LICENSE 文件 |
| 8 | 包名不占用他人命名空间 | ✅ |

### 发布前要补的

```sh
# 1. LICENSE 文件（现在 package.json 写了 MIT 但没有实体文件）
# 2. git 仓库 + 首次 commit
git init && git add -A && git commit -m "feat: secure input cards for DSH"

# 3. 推上去，然后到 Settings → Topics 加 dsh-plugin
```

---

## 三、精选目录 PR

| 目录 | 做法 | 收录后 |
|---|---|---|
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | fork → `README.md` 和 `README.zh.md` 对应分类各加一行 → PR | 可挂官方 badge |
| [awesome-dsh-plugins](https://github.com/AdamPlatin123/awesome-dsh-plugins)（雷达） | 加 topic 等自动扫；或按 PR 模板往 `PLUGINS.md` 追加 | 会跑 L4 运行实测 |

PR 里**要附测试材料**，格式大概是：

```text
## 测试环境
- 插件: dsh-secret-form v0.1.0 (commit <sha>)
- DSH: 0.2.2-rc.1
- OS: macOS 26; Node: v26.10.0

## 测试层级与结果
- L1 清单: package.json / exports / dsh.bundle 齐全
- L2/L3: npm run verify 全绿（self-test + check-tokens + check-readme + 语法）
- L4 运行级: 三条通道实测通过
  - secret_exec: sudo 重试、ssh-keygen 双 passphrase、openssl 加解密
  - secret_browser(dsh): 内置面板三字段填充，React 受控组件确认收到值
  - secret_browser(ego): 本地页多字段 + 提交 + verify 读回
```

**这一条我们现在拿得出来** —— `npm run verify` 就是现成的 L2/L3 材料，L4 的三条通道都有实测记录。

---

## 一键自检

发布前跑：

```sh
npm run verify
```

输出全绿才推。它检查：host 行为、设计 token 不漂移、两份文档的示例对得上 schema、两个源文件语法。
