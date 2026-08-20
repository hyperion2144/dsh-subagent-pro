# 架构说明

决策记录：合并自 monitor 与 director 的设计取舍。

约定：被后续变更取代的决策保留原文，在小节标题后标注（已被 x.x 取代，YYYY-MM-DD），新决策写入对应小节。

## 1. 概览

dsh-subagent-pro 是 DSH Web 的常驻扩展插件，单 bundle entry 同时提供三件事：

1. 实时子代理监控：监听 subagent/start / subagent/end 全局事件，归因到根会话，浏览器浮层面板轮询 /api/dsh-subagent-pro/snapshot；
2. 角色路由委派：注册 subagent_role 模型工具，四层回退解析 provider/model/persona/toolFilter；
3. Claude Code 风格 agent md 注入：扫描 ~/.dsh/agents/*.md 与 <cwd>/.dsh/agents/*.md，合并到角色表，正文作为 persona 注入。

数据流：

user -> main agent -> subagent_role tool -> resolveRoute -> SubagentStartRequest{persona, agentOptions, toolFilter}
                                                                       |
                                                          ctx.subagents.start(provider, request)
                                                                       |
                                                            child session with persona

事件流：

subagent/start -> ctx.on('global') -> parent-chain walk -> rootId -> runs Map -> /api/dsh-subagent-pro/snapshot (every 1s)

## 2. 设计决策与理由

### 2.1 为什么合并 monitor + director 而不是独立两个插件

- 两者都是常驻扩展（页面刷新后状态保留），职责重叠：director 的 subagent_role 工具返回的子代理正是 monitor 关心的对象；
- 合并后只需一个 cordis entry，少一个 bundle patch、少一处 settings 命名空间管理；
- 客户端 UI 共享一个 toggle 按钮和共享 store（useSyncExternalStore），无需 prop drilling。

已选方案 A：单插件 dsh-subagent-pro。

### 2.2 为什么 toggle 按钮放在 conversation.input.left 而不是 sidebar

HUD 插件（a903067276-rgb/dsh-hud）使用 conversation.input.left slot 放置状态按钮；DSH 官方 composer chrome 也用同位置放附件按钮。这是一个与对话强相关的语义位：

- 监控面板的关注对象就是我（主代理）派出的子代理，属于对话场景；
- sidebar footer 偏向全程序控制项（设置、主题、用户），子代理监控过重。

monitor 原版的 sidebar 文字按钮已替换为 HUD 风格的 28x28 SVG 图标按钮（线性 SVG 子代理树状图标 + warn-yellow 角标 + .is-open 激活态），token 与官方对齐：--dsw-alias-state-warn-tertiary、--dsw-alias-state-warn-primary、--dsw-alias-state-warn-label。

### 2.3 事件为什么走 { global: true } 而不是加入 subagent 父作用域

同 monitor ARCH 2.3：事件按委托方（父会话）作用域分发；本插件挂在根组合上，必须 global 监听才能收到所有事件，再走父链归因到根会话。

### 2.4 事件为什么合并 listDescendants（history fill）

同 monitor ARCH 2.4：刷新 / 重启后事件仓库清空，但子代理记录在持久目录里。合并 catalog 提供免费的 label/mode/depth 字段 + 历史回填。

### 2.5 角色优先级为什么是 project md > global md > settings

- settings.roles 是用户在设置面板里手写的调试沙盒，临时实验友好；
- agent md 是项目级 / 全局级的代码化部署形态，可纳入版本控制、跨机器同步。

设计取舍：md 是部署形态（immutable + 版本化），settings 是 UI 实验形态（mutable + 即时生效）。当两者冲突时，md 赢——用户把 md 写进 git 时就知道自己在做什么；settings 是临时覆盖层。

非冲突的情况下三者并存，主代理指引全部列出，UI 把 md 角色显示为只读、把 settings 角色显示为可编辑。

### 2.6 为什么 agent md 正文直接作为 persona 注入

director 已验证：role.persona 通过 buildSubagentRequest({ persona: route.persona }) 进入 SubagentStartRequest.persona，到达子代理的 system prompt。这是 agent md -> 子代理行为的唯一注入路径，与 settings 角色完全一致。

frontmatter 的 schema 设计：

字段 | 必需 | 映射到 | 说明
name | 否 | displayName | 缺省取文件名
description | 是 | description | 缺省回退文件名 + warn
tools | 否 | toolFilter.allow | 空格分隔
model | 否 | provider / model | provider/model 拆分；仅 model 时 provider 继承
正文 | 是 | persona | 去掉 frontmatter 后整段作为 persona

### 2.7 为什么 settings 命名空间是 subagent-pro 而不是 subagent-director

director 拆 main + bridge 两个 entry 绕开 webServer inject 闭包（详见 director ARCH）；本插件单 entry 直接 inject: webServer，所以不再需要 bridge，命名空间也无须兼容旧名。

迁移说明：旧 dsh-plugin-subagent-director 用户需要把 settings.yaml 里的 subagent-director 块改名为 subagent-pro。CHANGELOG 标注。

### 2.8 为什么 4 层回退解析而不是显式 provider/model

4 层回退是 LLM route 解析的自然形态：

1. 模型在调用时显式给出（per-call override）
2. 角色模板绑定（per-role template）
3. 插件全局默认（deploy-wide policy）
4. 不注入，让 default-route seam 继承父模型（zero intrusion）

director ARCH 6 的论证、unittests 19 个全过。

### 2.9 为什么 persona 注入要 capability-check

只有部分 subagent transport provider 支持 persona / toolFilter（例如 spawn 支持，fork 不支持）；不支持时通过 assertDelegationCapabilities 抛 subagent-director: role binds a persona but transport provider ... does not support the persona capability，避免运行时静默丢弃 persona。

## 3. 文件结构

src/index.ts                  # host 半主入口（apply）
src/index-types.ts            # 公共类型（SubagentProConfig）
src/monitor.ts                # 实时子代理监控（event attribution + snapshot 路由）
src/roles.ts                  # 角色路由装配（delegation tool + default seam + guidance）
src/agents-md.ts              # agent md 加载器（Claude Code 风格 frontmatter 解析）
src/route-resolver.ts         # 纯函数 4 层回退解析
src/settings.ts               # settings 命名空间 + 校验 + 实时快照
src/delegation-tool.ts        # subagent_role 模型工具定义
src/default-route.ts          # default route seam（包装 start/startContinuable）
src/guidance.ts               # system prompt 角色清单 section
src/client/index.ts           # client 半主入口（slots）
src/client/styles.ts          # 全部 CSS（inlined）
src/client/store.ts           # 页面级共享 store（useSyncExternalStore）
src/client/toggle.tsx         # HUD 风格图标按钮（28x28 SVG + warn-yellow 角标）
src/client/panel.tsx          # 浮层面板（状态点 + 拖动 + 调高 + 收起）
src/client/role-editor.tsx    # 设置面板角色编辑器（默认值 + settings 角色 CRUD）

## 4. 测试覆盖

src/__tests__/ 下的纯函数测试（tsx --test）：

- route-resolver.test.ts：8 个用例（call/role/default/inherit 优先级、displayName 反查、role persona 注入、未知 role warn、reasoningEffort advisory、模型单独缺省）。
- agents-md.test.ts：10 个用例（kebab-case 校验、.md 后缀剥离、lastSegment 双分隔符、fileIdFromPath 组合、frontmatter 完整/缺失/不闭合、model 拆分、tools 拆分）。

运行时集成测试依赖 DSH 真机；此处未自动化，建议在 DSH web profile 中手动验证：

1. 点击输入区左侧的 toggle 按钮；面板在右上角出现。
2. 在 ~/.dsh/agents/ 写一个 md，重启 DSH；settings -> Subagent Pro 出现该角色。
3. 主代理在对话中调用 subagent_role({ role: <id>, prompt: ... })；子代理启动后 persona 已注入 system prompt。

## 5. 版本与发布

沿用 monitor 的发布纪律（AGENTS.md §5）：

- 版本号三处一致：package.json、CHANGELOG 最新条目、git tag；
- 双语 README 同 PR 同步；
- pnpm verify:docs 检查文档一致性；
- 决策记录 ARCHITECTURE.md 保留旧决策，新决策写新小节。
