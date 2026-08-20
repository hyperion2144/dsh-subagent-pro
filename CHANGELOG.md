# Changelog

All notable changes to `dsh-subagent-pro` are recorded here. Format follows Keep a Changelog.

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
