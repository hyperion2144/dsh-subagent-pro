# 🎬 dsh-subagent-pro

> DeepSeek Harness Web extension: live subagent monitor + role-based subagent routing + Claude Code style `.dsh/agents/*.md` persona injection.

[中文](#中文) · [Features](#features) · [Credits](#credits) · [Install](#install) · [Usage](#usage) · [Roles](#roles) · [Architecture](#architecture) · [Development](#development) · [FAQ](#faq)

---

## Credits

This plugin is deeply indebted to two open-source projects:

- **[dsh-subagent-monitor](https://github.com/Mombrane/dsh-subagent-monitor) (`@leetoners/dsh-ui-subagent-monitor` v0.2.0)** — the live subagent monitor panel: event attribution, the floating panel (drag / resize / collapse / hide rows / status dots), the `conversation.input.left` HUD icon button, and the `shell.overlay` mounting approach all originate from this project.
- **[dsh-plugin-subagent-director](https://github.com/SeverusZh/dsh-plugin-subagent-director) (v0.2.1)** — role-based subagent routing: the `subagent_role` four-layer fallback (call > role > default > inherit), default-model seam wrapping `subagent/start`, the settings namespace with role CRUD, and the system-prompt role listing all originate from this project.

Without their pioneering work, this plugin would not exist. Thanks to the original authors.

## Features

- **Live subagent panel** — listens to `subagent/start` and `subagent/end` events, attributes runs to their root session via the parent chain; up to 200 rows per root; browser polls `/api/dsh-subagent-pro/snapshot` once per second; status dots follow the official StateDot spec (running = pixel-art chase, terminal = solid + 10% same-color halo).
- **HUD-style icon button** — 28×28 linear SVG icon injected into the `conversation.input.left` slot; top-right warn-yellow badge shows the running-subagent count; matches the official interaction color tokens.
- **Role-based routing** — registers the `subagent_role` tool with a four-layer fallback (call > role > default > inherit); persona and toolFilter flow into `SubagentStartRequest`; foreground / one-shot background / continuable background execution modes.
- **LLM route self-introspection** — registers the `subagent_providers` tool so the main agent can query the host `llm` service for available providers, models, and reasoning-effort levels (same source as the settings-panel dropdowns); agents do not need to hard-code model ids.
- **Default model fallback** — once `defaultProvider`/`defaultModel` are configured, any subagent started without explicit `agentOptions` (including built-in `subagent`/`subagent_fork`) automatically uses the default; an un-routable default provider silently falls back to the parent model.
- **Claude Code style agent md** — scans `~/.dsh/agents/*.md` (global) and `<cwd>/.dsh/agents/*.md` (project); frontmatter fields map to RoleTemplate; the body becomes the persona injected into the subagent.
- **Role precedence** — project md > global md > settings.roles; all three coexist in the main-agent guidance; delegate by role id (kebab-case file basename).
- **Settings UI** — exposes a `Subagent Pro` section via `settings.section` slot: defaults + settings-role CRUD; md-sourced roles are read-only with their source tag (`project-md` / `global-md`).
- **Hot reload** — settings.yaml / settings UI writes take effect immediately, no restart; agent md is rescanned on settings/change.
- **Zero intrusion** — with no roles and no defaults, behavior is identical to not installing the plugin.

## Install

> ⚠️ **Not published to npm yet**: `dsh plugin add dsh-subagent-pro` (by package name) does not work yet. Install via the GitHub path (pinned to the tag):

```bash
dsh plugin --profile <name> add github:hyperion2144/dsh-subagent-pro#v0.1.0
```

First install requires one allowBuilds entry in the target profile's `pnpm-workspace.yaml` (pnpm 11 supply-chain protection: git-hosted deps must be explicitly allowed to run build scripts, otherwise `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`). **The key is not the package name but the exact codeload URL** (includes the commit sha, changes per release) — copy the line printed in the error message:

```yaml
# ~/.dsh/profiles/<name>/pnpm-workspace.yaml (example; use the key from the error message)
allowBuilds:
  "dsh-subagent-pro@https://codeload.github.com/hyperion2144/dsh-subagent-pro/tar.gz/<commit-sha>": true
```

Once published to npm, `dsh plugin --profile <name> add dsh-subagent-pro` will work instead.

The plugin is a single bundle entry (`dsh-subagent-pro`) that mounts both the host half and the client half; no manual `cordis.patch.yml` write required. To override defaults, patch the main entry by id:

> **`lib/` is not in version control** (T2 decision 2026-08-23): the `prepare` hook builds it on install. `github:` / npm / tgz installs build automatically; if you use `dsh plugin add link:./` pointing at a local checkout, run `pnpm build` there first (link mode does not trigger `prepare`).

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

## Usage

### Monitor panel

After install, the conversation composer gets a HUD-style icon button on the left:

- Idle: linear SVG subagent-tree icon.
- Running subagents: top-right warn-yellow badge with the count.
- Click toggles the floating panel (auto-open on desktop, hidden on `≤ 768px` viewports).
- Panel: drag, resize, collapse, close, hide rows, clear completed, open child session.

### Role delegation (settings)

Open DSH Settings → Subagent Pro:

1. Set `defaultProvider` / `defaultModel` (optional). All subagents without an explicit model use this.
2. Click `+ 新增角色` to add a custom role with `displayName` / `description` / `persona` / `provider` / `model` / `tools`.
3. The main agent sees the role catalog (auto-injected into the system prompt) and delegates:

```text
subagent_role({ role: "code-reviewer", prompt: "review src/foo.ts" })
subagent_role({ role: "code-reviewer", model: "deepseek-chat", prompt: "..." })
```

### Role delegation (agent md)

Drop a `.md` file under `~/.dsh/agents/` (global) or `<project>/.dsh/agents/` (project). The main agent picks it up on the next settings change and the persona is injected into every subagent started with that role id.

### Discover available models (`subagent_providers`)

The main agent can call `subagent_providers` at any time to inspect the host `llm` service for routable providers, models, and reasoning-effort levels — no restart or config-file read required:

```text
subagent_providers({ action: "list_providers" })
// -> { kind: "providers", providers: [{ id: "minimax-cn", name: "minimax-cn" }, ...] }

subagent_providers({ action: "list_models", provider: "opencode-go" })
// -> { kind: "models", provider: "opencode-go", models: [{ id: "deepseek-v4-flash", ... }] }

subagent_providers({ action: "list_reasoning_efforts", provider: "opencode-go", model: "deepseek-v4-flash" })
// -> { kind: "reasoning", efforts: [...], defaultEffort: "low" }
```

The data source is the same as the settings-panel dropdowns (`/api/dsh-subagent-pro/llm/*`). If the `llm` service is unavailable the tool returns empty arrays instead of throwing.

## Roles

### settings.roles (UI sandbox)

```yaml
subagent-pro:
  defaultProvider: opencode-go
  defaultModel: minimax-m2.7
  roles:
    translator:
      displayName: Translator
      description: EN <-> ZH technical translation
      persona: You are a professional translator...
      provider: deepseek-official
      model: deepseek-chat
      toolFilter:
        allow: [Read, Grep]
```

### agent md (project / global)

`<project>/.dsh/agents/code-reviewer.md`:

```markdown
---
name: Code Reviewer
description: Reviews code quality, safety, maintainability, test coverage
tools: Read Grep Glob
model: sonnet
---
You are a rigorous code reviewer. Lead with the verdict, then evidence; separate blockers from suggestions; give actionable edits. Direct, no flattery.
```

**Precedence**: project md > global md > settings.roles (all three can coexist; same id across layers is overwritten by the higher-priority source).

**Constraints**:

- Filename (sans `.md`) is the role id; must be kebab-case.
- `description` is required; missing → filename fallback + warning.
- `model` accepts `provider/model` (split) or just `model` (provider inherited).
- Frontmatter parse failure: file degrades to pure persona with `displayName`/`description` = filename, warning, never a hard error.

## Architecture

See [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Development

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm verify:docs
```

## FAQ

**What changed vs. the legacy `dsh-subagent-monitor`?**

- The trigger moved from a sidebar text button to a HUD-style `conversation.input.left` icon, matching the official interaction tokens.
- Snapshot endpoint moved from `/api/subagent-monitor/snapshot` to `/api/dsh-subagent-pro/snapshot` (update any external scrapers).
- No legacy features dropped; gained agent-md + role routing.

**What changed vs. the legacy `dsh-plugin-subagent-director`?**

- Single bundle entry; no manual `cordis.patch.yml` (the old split into main + bridge entries was a workaround for webServer's `inject` closure).
- Role source expanded from settings-only to settings + agent md (project > global precedence).
- Settings namespace renamed `subagent-director` → `subagent-pro`. Migrate manually (see ARCHITECTURE §3).

**Zero-config behavior?**

Identical to not installing the plugin: no panel, no tool, no seam side effects, no guidance section.

**Do I need to restart after editing agent md?**

Save any settings field once, or restart the DSH session that hosts the plugin. The md directory itself is not watched (avoids fs noise).

## License

[MIT](./LICENSE)

---

## 中文

**dsh-subagent-pro** 是一个单一 bundle 的 DeepSeek Harness Web 扩展插件，合并三大能力：

- 实时子代理运行面板（事件驱动快照、可拖动浮层面板、HUD 风格图标按钮）；
- 角色路由委派（`subagent_role` 工具，四层回退，persona / toolFilter 注入）；
- Claude Code 风格 `.dsh/agents/*.md` persona 注入（项目 > 全局 > settings 优先级）。

安装：`dsh plugin --profile <name> add github:hyperion2144/dsh-subagent-pro#v0.1.0`。中文章节详细描述角色 md 格式、设置面板使用与 FAQ。

License: MIT.
