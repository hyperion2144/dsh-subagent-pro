# 🎬 dsh-subagent-pro

> DeepSeek Harness Web 扩展插件：实时子代理监控 + 角色路由委派 + Claude Code 风格 `.dsh/agents/*.md` 角色注入。

[English](#english) · [特性](#特性) · [致谢](#致谢) · [安装](#安装) · [使用](#使用) · [角色定义](#角色定义) · [架构](#架构) · [开发](#开发) · [FAQ](#faq)

---

## 致谢

本插件在建造型上深度借鉴了以下两个开源项目，特此致谢：

- **[dsh-subagent-monitor](https://github.com/Mombrane/dsh-subagent-monitor)（`@leetoners/dsh-ui-subagent-monitor` v0.2.0）** — 实时子代理监控面板：事件归因、浮层面板（拖动 / 调高 / 收起 / 隐藏行 / 状态点）、`conversation.input.left` HUD 图标、`shell.overlay` 面板挂载方式均源自该项目。
- **[dsh-plugin-subagent-director](https://github.com/SeverusZh/dsh-plugin-subagent-director)（v0.2.1）** — 角色路由委派：`subagent_role` 四层回退（call > role > default > inherit）、默认模型兜底（seam 包装 `subagent/start`）、settings 命名空间与角色 CRUD、系统提示词角色清单，均源自该项目。

没有这两个项目的先行工作，就不会有本插件。感谢原作者们的设计与实现。

## 特性

- **实时子代理面板** — 监听 `subagent/start` 与 `subagent/end` 事件，按父链归因到根会话；每根会话最多保留 200 条；浏览器每 1 秒轮询 `/api/dsh-subagent-pro/snapshot`；状态点对齐官方 StateDot 规格（运行中 = 像素追逐，终态 = 实心 + 10% 同色光晕）。
- **HUD 风格图标按钮** — 28×28 线性 SVG 图标，注入 `conversation.input.left` slot；右上角 warn-yellow 角标显示运行中子代理数；与官方交互色板一致。
- **角色路由委派** — 注册 `subagent_role` 工具，支持四层回退（call > role > default > inherit），persona 与 toolFilter 注入到 `SubagentStartRequest`；foreground / one-shot 后台 / continuable 后台三种执行模式。
- **LLM 路由自省工具** — 注册 `subagent_providers` 工具，让主代理可主动查询当前 `llm` 服务暴露的 provider、model、reasoning-effort 列表（与设置面板的下拉同源），agent 在不确定用什么模型时不必硬编码。
- **默认模型兜底** — 配置 `defaultProvider`/`defaultModel` 后，任何未显式指定 `agentOptions` 的子代理（包括内置 `subagent`/`subagent_fork` 工具）自动应用默认；不存在的 provider 静默回退到父模型。
- **Claude Code 风格 agent md** — 自动扫描 `~/.dsh/agents/*.md`（全局）与 `<cwd>/.dsh/agents/*.md`（项目）目录；frontmatter 字段映射到 RoleTemplate；正文作为 persona 注入到子代理。
- **角色优先级** — project md > global md > settings.roles，三者并存时主代理指引列出全部，delegate 时按 role id（kebab-case 文件名）调用。
- **设置面板 UI** — `settings.section` slot 暴露 `Subagent Pro` 分组：默认委派 + settings 角色增删改；md 角色只读展示，标注 `project-md` / `global-md` 来源。
- **配置热更新** — settings.yaml / 设置面板的改动即时生效，无需重启；agent md 在 settings/change 时重新扫描。
- **零侵入** — 未配置任何角色与默认模型时与未安装本插件完全一致。

## 安装

```bash
dsh plugin --profile <name> add dsh-subagent-pro
```

本插件是单一 bundle entry（`dsh-subagent-pro`），自动挂载 host 半 + client 半，无需手写 `cordis.patch.yml`。

如需覆盖默认配置，按 id 覆盖主条目：

```yaml
- id: dsh-subagent-pro
  name: dsh-subagent-pro
  config:
    subagentProvider: spawn
    toolName: subagent_role
    enableRunInBackground: true
    backgroundMode: one-shot
    maxDepth: 3
    applyDefaultRoute: true
```

## 使用

### 监控面板

插件装载后，会话输入区左侧出现 HUD 风格图标按钮：

- 静态显示：线性 SVG 子代理树状图标；
- 有 running 子代理时右上角显示橙色角标（数量）；
- 点击打开 / 关闭浮层面板（默认桌面自动开，手机端 `≤ 768px` 默认关）；
- 面板可拖动、可调高、可收起 / 关闭 / 隐藏行 / 清空已完成 / 打开子会话。

### 角色委派（settings 角色）

在 DSH 设置面板的 `Subagent Pro` 分组下：

1. 填写 `defaultProvider` / `defaultModel`（可选），所有未显式指定的子代理应用该模型；
2. 点击「+ 新增角色」增加自定义角色，填写 `displayName` / `description` / `persona` / `provider` / `model` / `tools`；
3. 主代理会自动看到角色清单（系统提示注入），并委派：

```text
subagent_role({ role: "code-reviewer", prompt: "审查 src/foo.ts" })
subagent_role({ role: "code-reviewer", model: "deepseek-chat", prompt: "..." })
```

### 角色委派（agent md 角色）

在 `~/.dsh/agents/` 或 `<project>/.dsh/agents/` 写一个 md 文件（详见下一节）；主代理会自动加载并把 `persona` 注入到子代理的 system prompt。

### 查询可用模型（`subagent_providers`）

主代理可随时调用 `subagent_providers` 查询当前 host `llm` 服务暴露的 provider / model / reasoning-effort 列表，无需重启或查看配置文件：

```text
subagent_providers({ action: "list_providers" })
// -> { kind: "providers", providers: [{ id: "minimax-cn", name: "minimax-cn" }, ...] }

subagent_providers({ action: "list_models", provider: "opencode-go" })
// -> { kind: "models", provider: "opencode-go", models: [{ id: "deepseek-v4-flash", ... }] }

subagent_providers({ action: "list_reasoning_efforts", provider: "opencode-go", model: "deepseek-v4-flash" })
// -> { kind: "reasoning", efforts: [...], defaultEffort: "low" }
```

数据源与设置面板的下拉（`/api/dsh-subagent-pro/llm/*`）完全一致。如果 `llm` 服务不可用，工具返回空数组而不是抛错。

## 角色定义

### settings.roles（UI 调试沙盒）

```yaml
subagent-pro:
  defaultProvider: opencode-go
  defaultModel: minimax-m2.7
  roles:
    translator:
      displayName: 翻译员
      description: 中英互译技术文档
      persona: 你是专业翻译...
      provider: deepseek-official
      model: deepseek-chat
      toolFilter:
        allow: [Read, Grep]
```

### agent md（项目 / 全局）

`<project>/.dsh/agents/code-reviewer.md`：

```markdown
---
name: 代码审查员
description: 审查代码质量、安全、可维护性与测试覆盖
tools: Read Grep Glob
model: sonnet
---
你是严谨的代码审查员。先给结论再给证据，区分阻塞项与建议项；逐条指出问题并给出可操作的修改建议，语气客观直接，不吹捧也不刻薄。
```

**优先级**：

1. `<cwd>/.dsh/agents/<id>.md`（项目级，最优先）
2. `~/.dsh/agents/<id>.md`（全局级）
3. `settings.roles[<id>]`（UI 调试沙盒，可与 md 共存）

**约束**：

- 文件名（去掉 `.md`）即 role id，必须是 kebab-case；
- `description` 必填；缺省时回退到文件名并发出 warning；
- `model` 形如 `provider/model` 拆分 provider；仅 model 时 provider 继承；
- frontmatter 解析失败时整文件降级为纯 persona，`displayName`/`description` 取文件名，warning 不阻断。

## 架构

详见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)。

## 开发

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm verify:docs
```

## FAQ

**与旧 [`dsh-subagent-monitor`](https://github.com/Mombrane/dsh-subagent-monitor) 有什么区别？**

- 触发开关从 sidebar 文字按钮改为 HUD 风格 `conversation.input.left` 图标按钮，与官方交互色板一致；
- 数据路由从 `/api/subagent-monitor/snapshot` 改为 `/api/dsh-subagent-pro/snapshot`（如需兼容旧监控脚本请同步更新）；
- 旧插件无 agent-md 与角色路由能力，本插件合并了三者。

**与旧 [`dsh-plugin-subagent-director`](https://github.com/SeverusZh/dsh-plugin-subagent-director) 有什么区别？**

- 单 bundle entry，无需手写 `cordis.patch.yml`（旧插件拆 main + bridge 两个条目绕开 webServer 注入限制，本插件 host 半是单进程直接 `inject: webServer`）；
- 角色来源从仅 settings 扩展为 settings + agent md（project > global 优先级）；
- settings 命名空间从 `subagent-director` 改为 `subagent-pro`（旧用户请按 ARCHITECTURE §3 迁移）。

**未配置任何角色时行为如何？**

未配置任何角色与默认模型时与未安装本插件完全一致（零侵入）。

**agent md 修改后需要重启吗？**

需要在 settings 面板保存一次（任意字段），或者重启插件挂载的 DSH 会话；md 文件本身修改不会触发 host 重扫（避免 fs watcher 噪声）。

## License

[MIT](./LICENSE)

---

## English

**dsh-subagent-pro** is a single-bundle DeepSeek Harness extension that merges:

- Live subagent run monitor (event-driven snapshot, drag/resizable floating panel, HUD-style icon button trigger)
- Role-based subagent routing (`subagent_role` tool with 4-layer fallback, persona/toolFilter injection)
- Claude Code style `.dsh/agents/*.md` persona injection (project > global > settings priority)

Install: `dsh plugin --profile <name> add dsh-subagent-pro`. See the Chinese section above for the role md format, settings UI walkthrough, and FAQ.

License: MIT.
