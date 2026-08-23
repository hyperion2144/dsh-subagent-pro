# Changelog

All notable changes to `dsh-subagent-pro` are recorded here. Format follows Keep a Changelog.

## [Unreleased]

### Added

- **File-backed role section in the role editor (`角色（文件）`)** — every role discovered on disk is loaded and shown read-only alongside the existing editable `角色（设置）` list. Sources: `~/.dsh/agents/*.md` (global) + every registered workspace's `.dsh/agents/*.md` (project). On a same-id collision the **project** copy wins; the panel also tags the entry with `also: 全局/项目` and a gray italic note pointing at the losing file. Source labels (`项目` / `全局`) are coloured chips; entries are pinned with a lucide `lock` SVG (no emoji). Read-only — the editor on the next line explains "修改请直接编辑 .md 文件".
  - New host bridge route `GET /api/dsh-subagent-pro/roles` (registered by `dsh-subagent-pro-bridge`) — walks `ctx.workspaceRegistry.list()` + the global dir, runs `mergeRoles`, returns `{ ok, roles, warnings }`.
  - `agents-md.ts` exports `loadAgentMdRolesAcrossWorkspaces(ctx, globalDir, projectDirName)` and a pure `mergeRoles(global, project)` (tested) so the bridge stays headless-friendly and the merge logic is unit-testable.
  - 4 new tests in `agents-md.test.ts` lock down project-wins precedence, global-only fall-through, multi-workspace enumeration, and graceful degradation when `workspaceRegistry.list()` throws.

- **`subagent_providers` model tool** — lets the main agent introspect the host `llm` service for routable providers, models, and reasoning-effort levels. **Unified catalog call** (no action enum): `subagent_providers()` returns every provider nested with its models and each model's reasoning efforts; `subagent_providers({ provider })` scopes to that provider; `subagent_providers({ provider, model })` scopes to one model leaf. Backed by the same `ctx.llm` calls that power the settings-panel dropdowns (`/api/dsh-subagent-pro/llm/*`). Tolerates a missing `llm` service (returns an empty catalog). Tool name configurable via `infoToolName`; can be disabled via `enableLlmInfoTool: false`.
- New `src/llm-info-tool.ts` host module, registered alongside `subagent_role` in `roles.ts`; catalog-build tests rewritten in `src/__tests__/llm-info-tool.test.ts`.

- **`subagent_roles` model tool** — lets the main agent discover every role it can pass to `subagent_role`. Lists the merged role table (project agent md > global agent md > settings), each entry carrying id, display name, description, source label (项目/全局/设置), optional provider/model route binding, persona presence, tool scoping, and override flag. `subagent_roles()` lists all, `subagent_roles({ role })` filters by id or display name. Tool name configurable via `rolesToolName`; can be disabled via `enableRolesTool: false`. New `src/roles-info-tool.ts` + `src/__tests__/roles-info-tool.test.ts`.
- **`dsh-subagent-pro-bridge` loader entry** (`src/bridge-entry.ts`, patched via `cordis.patch.yml`) — self-publishes two webServer prefix routes so the browser settings editor can read/write the `subagent-pro` namespace without the apiproxy `exposedNamespaces()` allowlist: `GET/PATCH /api/dsh-subagent-pro/settings/*` and LLM enumeration `GET /api/dsh-subagent-pro/llm/*` (providers / models / reasoning-efforts via `llm.resolveModelInfo`). Only active in web profiles (injects `webServer`).
- **Settings editor now writes real settings** — the role-editor fetches through the bridge endpoints; provider / model / reasoningEffort selectors are cascading dropdowns fed by live `llm` enumeration (fall back to text input when the bridge is unreachable).
- **Per-row model info in the monitor panel** — each row shows a dedicated model chip (`provider · model · reasoningEffort`) resolved from the child session's OWN persisted `request/header` events (`session.requestHeader()` live fast path; `@deepseek-ai/dsh-api-remotes.inspectApiRemoteSession` + `foldRequestHeader` cold path). Works for running, ended, and restart-survived historical subagents — no custom persistence.
- **"← 主会话" back button** in the panel header — shown when the current session is itself a subagent (`useSessions(...currentAddress.parentSessionId)`), jumps back to the parent session.
- **Row-foot CSS alignment** — `.dsp-row-label/-open/-foot/-meta/-time` rules (ellipsis + tabular-nums) ported from the monitor reference; badges now anchor via `position: relative` on the toggle; HUD-style footer stat chips.

### Fixed

- **Default subagent model now actually applies.** The plugin previously subscribed to a non-existent `settings/change` event and cached the initial `describe()` snapshot, so the `applyDefaultRouteSeam` never saw user-edited `subagent-pro.defaultProvider` / `defaultModel` after startup — subagents silently fell back to `agent-default-model`. Rewired to use `installSettingsSection`'s `setSource` hook (the dsh-agent-default-model pattern): the snapshot getter now re-invokes the live source on every read, so settings.yaml hot reload + UI writes both flow through immediately. `src/index.ts` reload listener switched from the bogus `settings/change` to the real `settings/updated` event. New test `settings-snapshot.test.ts` locks down the live-source contract.
- **Model lookup for historical subagents** — `enrich()` queried models only from the in-memory `runs` map (empty after a host restart); now it iterates the durable descendant catalog ids and cold-reads each session's `request/header` events from persistence.

## [0.1.0] - 2026-08-20

### Added (首发合并版本)

**合并自 `@leetoners/dsh-ui-subagent-monitor` 0.2.0：**

- 实时子代理监控：监听 `subagent/start` / `subagent/end` 全局事件，按父链归因到根会话；
- HTTP snapshot 路由 `/api/dsh-subagent-pro/snapshot`（每根会话最多保留 200 行）；
- 浏览器浮层面板：状态点（运行中 = 像素追逐、终态 = 实心 + 10% 同色光晕）、拖动 / 调高 / 收起 / 关闭 / 隐藏行 / 清空已完成 / 打开子会话；
- 面板位置记忆（localStorage 跨会话保留）+ 高度记忆（按会话隔离）。

**合并自 `dsh-plugin-subagent-director` 0.2.1：**

- `subagent_role` 模型工具：四层回退（call > role > default > inherit）；
- 三种执行模式：foreground / one-shot 后台 / continuable 后台；
- 默认模型兜底：未显式指定 agentOptions 的子代理（含内置 `subagent`/`subagent_fork`）自动套用 settings 默认；
- 系统提示 section 注入角色清单；
- settings 命名空间 `subagent-pro` + 实时热更新；
- settings 面板 UI：默认值 + 角色 CRUD。

**新增能力：**

- **HUD 风格图标按钮** — 替换 monitor 原版的 sidebar 文字按钮；28×28 线性 SVG 图标注入 `conversation.input.left` slot；warn-yellow 角标显示运行中子代理数；token 与官方交互色板一致；
- **Claude Code 风格 agent md 注入** — 自动扫描 `~/.dsh/agents/*.md`（全局）与 `<cwd>/.dsh/agents/*.md`（项目）；
- frontmatter schema：`name` / `description` / `tools` / `model`；
- 正文作为 persona 注入到 `SubagentStartRequest`，与 settings 角色走同一注入路径；
- 角色优先级：project md > global md > settings.roles（同名时高优先级覆盖）；
- kebab-case id 校验、缺失 description 自动回退 + warn、frontmatter 解析失败降级。

### Changed

- 单一 bundle entry `dsh-subagent-pro`（不再像 director 拆 main + bridge 两 entry）；
- settings 命名空间从 `subagent-director` 改为 `subagent-pro`（迁移说明见 ARCHITECTURE §2.7）；
- snapshot 路由从 `/api/subagent-monitor/snapshot` 改为 `/api/dsh-subagent-pro/snapshot`；
- toggle slot 从 `sidebar.footer.action` 改为 `conversation.input.left`。

### Documentation

- 双语 README（中文 + English，同 PR 同步）；
- ARCHITECTURE.md 决策记录；
- 19 个 unittests 覆盖 `route-resolver` (8) + `agents-md` (10) + 解析与回退边界。
