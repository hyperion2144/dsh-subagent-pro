# AGENTS.md

## 项目简介

`dsh-subagent-pro` 是 DeepSeek Harness（DSH）的常驻扩展插件，单 bundle 同时提供：实时子代理运行监控、`subagent_role` 角色路由委派工具、Claude Code 风格 `.dsh/agents/*.md` 角色注入。详见 `README.md` / `ARCHITECTURE.md`。

## 开发纪律

- **包管理器**：pnpm（lockfile 已纳入版本控制）。
- **构建**：tsdown 同时产出 host 半 (`lib/index.js`, ESM) 与 client 半 (`lib/client.js`, CJS)；构建产物随仓库分发（沿用 monitor 发布副本约定），无需用户先 build。
- **类型检查**：`pnpm typecheck`（`tsc --noEmit`，严格模式 + `exactOptionalPropertyTypes`）。
- **测试**：`pnpm test`（`tsx --test`，19 个纯函数测试覆盖 `route-resolver` + `agents-md`）。
- **文档门禁**：`pnpm verify:docs`（版本号三处一致、双语 README、相对链接、lib/ 包名）。
- **提交前**：跑 `pnpm typecheck && pnpm test && pnpm build && pnpm verify:docs`。

## 文件布局

```
src/
├── index.ts                # host 半主入口（apply）
├── index-types.ts          # 公共类型
├── monitor.ts              # 实时子代理监控（事件归因 + snapshot 路由）
├── roles.ts                # 角色路由装配（delegation tool + default seam + guidance）
├── agents-md.ts            # agent md 加载器（Claude Code 风格 frontmatter 解析）
├── route-resolver.ts       # 纯函数 4 层回退解析
├── settings.ts             # settings 命名空间 + 实时快照
├── delegation-tool.ts      # `subagent_role` 模型工具定义
├── default-route.ts        # default route seam
├── guidance.ts             # system prompt 角色清单 section
└── client/
    ├── index.ts            # client 半主入口
    ├── styles.ts           # inlined CSS
    ├── store.ts            # 页面级共享 store
    ├── toggle.tsx          # HUD 风格图标按钮
    ├── panel.tsx           # 浮层面板
    └── role-editor.tsx     # 设置面板角色编辑器
```

## Agent skills

### Issue tracker

GitHub Issues at `hyperion2144/dsh-subagent-pro`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context (CONTEXT.md + docs/adr/ at repo root) — no monorepo signals. See `docs/agents/domain.md`.

### Wayfinder labels

`wayfinder:map`, `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task` — used by the `wayfinder` skill for large-effort planning. The labels are present in this repo's issue tracker.
