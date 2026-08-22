# DSH Client Slot Inventory + `conversation.input.left` Stability

Branch: `research/dsh-slot-inventory`
Repo target: `deepseek-ai/deepseek-harness` @ `master` (latest tag `dsh-v0.1.1-rc.2`)

## TL;DR

- `conversation.input.left` is **stable on `master`** in the released `v0.1.1-rc.2` line — it is declared by the shipped `ui-conversation` composer entry, has no deprecation JSDoc marker, and the contract comment explicitly recommends it as the seat for a "small always-visible control" alongside the resident chrome [1].
- For the floating panel that overlays the right edge of conversation, **`shell.overlay` (root-scoped, additive, click-through-by-default)** is the cleanest match; `details` is the wrong target because it is `kind: 'single'` and already occupied by `DetailsPanel`, so registering there would shadow the shipped UI rather than add beside it [2][3].
- Migration risk is low: the input-region slots (`conversation.input.{dock,left,right,overlay}` and `conversation.composer.dock`) are all declared in one block in `apply.ts` and were last refactored together (single-commit blast radius), so any future rename lands as one coordinated PR with a JSDoc rename note — adopt the seat today, monitor the docstring on `apply.ts` as the deprecation surface.

## Slot Inventory (master @ `dsh-v0.1.1-rc.2`)

Authoritative source: `cordis-client-runner/src/client/slot-catalog.ts` (synchronized runtime catalog) cross-referenced with each owner package's `contract/slots.ts` and `apply.ts` [2][3][4][5][6][7]. Grouped by namespace; columns: **name | kind/scope | declared by | purpose | stability | source**.

| Name | Kind / Scope | Declared by | Purpose | Stability | Source |
|---|---|---|---|---|---|
| `root` | single / root | runtime (built-in) | Built-in render-tree root, ancestor of every seat. DO NOT register. | stable | [2] / [8] |
| `shell.overlay` | list / root | `root` (client-ui-layout) | Frame-wide floating layer above every column, outside scroll containers; click-through, entries opt in. **Recommended for floating panel.** | stable | [2] / [6] |
| `details` | single / session | `root` (client-ui-layout) | Right details column. Occupied by `DetailsPanel`. Replacing shadows the shipped UI. | stable (occupied) | [2] / [6] |
| `sidebar` | single / root | `root` (client-ui-layout) | Whole left column. Occupied by `SidebarRoot`. | stable (occupied) | [2] / [6] |
| `sidebar.brand.mark` | single / root | `sidebar` (client-ui-sidebar) | Brand mark (expanded + collapsed rail). | stable | [2] / [7] |
| `sidebar.brand.name` | single / root | `sidebar` (client-ui-sidebar) | Brand name beside the mark. | stable | [2] / [7] |
| `sidebar.settings` | single / root | `sidebar` (client-ui-sidebar) | Settings seat at sidebar foot. Occupied. | stable (occupied) | [2] / [7] |
| `sidebar.footer.action` | list / root | `sidebar` (client-ui-sidebar) | Actions beside Settings (e.g. CordisPanel). | stable | [2] / [7] |
| `sidebar.workspaces` | single / root | `sidebar` (client-ui-sidebar) | Workspace/session browsing region. Occupied by `WorkspaceBrowser`. | stable (occupied) | [2] / [7] |
| `sidebar.workspaces.directoryFlow` | single / root | `sidebar.workspaces` (client-ui-workspace) | Directory-pick flow under the browser. Occupied (browse + native). | stable (occupied) | [2] / [7] |
| `settings.trigger` | single / root | `sidebar.settings` (client-ui-settings-general) | Sidebar-foot trigger row content. Occupied. | stable (occupied) | [2] / [9] |
| `settings.action` | list / root | `sidebar.settings` (client-ui-settings-general) | Content-column header actions before Close. | stable | [2] / [9] |
| `settings.close` | single / root | `sidebar.settings` (client-ui-settings-general) | Close button's visually-hidden label. | stable (a11y-critical) | [2] / [9] |
| `settings.section` | list / root | `sidebar.settings` (client-ui-settings-general) | Settings sections (general, models, plugins, agent-presets). | stable | [2] / [9] |
| `settings.general.item` | list / root | `sidebar.settings` (client-ui-settings-general) | Individual settings rows (per-section). | stable | [3] |
| `conversation` | single / root | client-ui-conversation | Conversation skeleton (hero / composer frame). Occupied by `ConversationRoot`. | stable (occupied) | [4][5] |
| `conversation.session` | single / session | `conversation` | Whole session body (view ring + composer chain host). Occupied. | stable (occupied) | [1][5] |
| `conversation.session.header` | single / session | `conversation` | Title, view tabs, action row strip. Occupied. | stable (occupied) | [1][5] |
| `conversation.session.header.lineage` | single / session | `conversation.session.header` | One breadcrumb title + lineage controls. Occupied by `SubagentHeaderLineage`. | stable (occupied) | [2][5] |
| `conversation.session.header.actions` | list / session | `conversation.session.header` | Buttons beside the title (additive; `order` ascending, negatives reserved). Occupied: agent-preset, job-list. | stable | [1][5] |
| `conversation.session.header.utilities` | list / session | `conversation.session.header` | Right-aligned Session utilities kept off the action group. | stable | [1][5] |
| `conversation.view` | list / session | `conversation.session` | Per-tab view ring (chat, trajectory, …). Occupied: chat, trajectory. | stable | [1][5] |
| `conversation.chat.node` | keyed / session | `conversation.view` (chat entry) | Business Node renderer, dispatched by `ChatNodeKind` hook context. | stable | [1] |
| `conversation.message.images` | single / session | `conversation.view` (chat entry) | Optional consecutive-image gallery renderer. | stable | [1][2] |
| `conversation.chat.commandview` | keyed / session | `conversation.view` (chat entry) | Per-command row hole, keyed by command name. | stable | [1] |
| `conversation.chat.turnTail` | chain / session | `conversation.view` (chat entry) | Completed Turn extension chain. | stable | [1] |
| `conversation.chat.assistant-actions` | list / session | `conversation.view` (chat entry) | Per-message action strip inside assistant IconActions. | stable | [1] |
| `conversation.details.tool` | single / session | `details` (client-ui-conversation DetailsPanel) | Whole tool details panel — every tool, not per-tool. | stable | [1] |
| `conversation.composer` | chain / session | `conversation` | Composer-takeover chain (approval, questions). | stable | [1][5] |
| `conversation.composer.bar` | single / session-maybe | `conversation` | Default InputBar body; passes `leftItems`/`rightItems`/`footer`. Occupied by `InputBar`. | stable (occupied) | [1][5] |
| `conversation.composer.dock` | list / session | `conversation` | Band under the composer card, inside its width column (stats line lives here). | stable | [1][5] |
| `conversation.hero.workspace` | single / root | `conversation` | Hero-phase workspace picker. | stable | [1][5] |
| `conversation.hero.brand.mark` | single / root | `conversation` | Blank-session brand mark. | stable | [1][5] |
| `conversation.hero.agentPreset` | single / root | `conversation` | Agent-preset chip on new-session screen. | stable | [1][5] |
| `conversation.input.dock` | list / session | `conversation` | Own-line strip above the composer (queues, goals, todos). | stable | [1][5] |
| `conversation.input.left` | list / session | `conversation` | Left end of composer tool row, **after** resident chrome (access, plan, attach). **Recommended for HUD toggle.** | stable | [1][5] |
| `conversation.input.right` | list / session | `conversation` | Right end of composer tool row, before primary send button. | stable | [1][5] |
| `conversation.input.overlay` | list / session | `conversation` | Floating overlay anchor (menu, popupSelect). Owned here; type merged from ui-input-trigger. | stable | [10][5] |
| `conversation.input.attachments` | single / session-maybe | `conversation.composer.bar` | Optional draft-image rail + drop target. Occupied by attachment plugin. | stable (occupied) | [1][5] |
| `conversation.input.plan` | single / session | `conversation.composer.bar` | Named plan-status seat, right of access mode. Renders nothing while empty. | stable | [1][5] |
| `conversation.input.model` | single / session | `conversation.composer.bar` | Named model-select seat, left of send button. Renders nothing while empty. | stable | [1][5] |
| `tool.call.toolview` | keyed / session | `conversation.chat.node` | Per-tool-name renderer (open key domain). | stable | [2] |
| `tool.view.cordis` | keyed / session | `tool.call.toolview` | Interactive Package-owned region inside the latest `cordis_run` card. | stable | [2] |

Total: 38 documented slots in the runtime catalog (master), organized across 6 namespaces: `root`/`shell`/`sidebar`/`settings`/`conversation`/`tool`.

## `conversation.input.left` — Stability Assessment

**Stable on `master`, no rename or deprecation signals detected** in the current release line (`dsh-v0.1.1-rc.2`).

Evidence:

1. Contract marker in `packages/client/ui-conversation/src/client/contract/slots.ts:231` (the contract comment explicitly chooses its name, defines the seat, and references the `.right` sibling for cross-direction guidance — verbatim: *"the seat for a small always-visible control. Entries sit beside that chrome, never replace it"*) [1].
2. The slot is declared in `apply.ts` inside the single children block of `slots.register({ name: 'conversation', children: { … 'conversation.input.left': { kind: 'list', scope: 'session' }, … } }, ConversationRoot)` [5]. Renaming would touch one call site, one SlotMap type augmentation, and the comment cross-reference.
3. Five-input sibling set (`conversation.input.{dock,left,right,overlay}` + `conversation.composer.dock`) is documented together as a coordinated family in the contract's `InputZone` block, and is wired together in the same declarative block in `apply.ts` — any rename lands as one synchronized PR with a JSDoc migration note, not a silent drop [1][5].
4. Recent commit history on `slots.ts` shows **no rename or deprecation commit in 2026 to date** — the most recent surface-level changes were the subagent-header review fixes (`fix(web): address subagent header review findings`) and refinement to the subagent header switcher, neither of which touched the input-region declarations (verified via the last 5 distinct commits on the file path) [11].
5. The runtime slot-catalog (which the Guard depends on for live registration) lists `conversation.input.left` as `kind: 'list', scope: 'session', declaredBy: 'an entry in conversation (client-ui-conversation)'` with `replaceRisk: 'none'` — i.e., additive registration is explicitly endorsed [2].
6. The architecture note `2026-07-25-web-input-machine-and-slash-pipeline.md` treats the input-region slot set as the shipped composition and does not flag any pending reshuffle [12].

The two state-changing bits worth watching going forward: (a) the `InputZone` shape (the owner props `{ session, input }`) is intentionally minimal — extending it is a breaking-ish change, but never a rename; (b) the family of five slots moves together — bundling the monitoring concern into one slot group is intentional, so any future "tool row" redesign lands once and is signalled in JSDoc.

## Recommendations

### HUD toggle button (28×28 icon, conversation-adjacent, top-level)

- **Use `conversation.input.left`** — declared `kind: 'list'`, `scope: 'session'`, owner share is the minimal `InputZone`, additive (`replaceRisk: 'none'`). The contract explicitly positions it as the seat for *"a small always-visible control. Entries sit beside that chrome, never replace it"* [1]. HUD toggle idiom (28×28 icon mirroring access / plan / attach) is exactly this profile: sitting beside the resident chrome in the composer tool row.
- **Why not alternatives**:
  - `conversation.input.right` — semantically for controls the user reaches on the way to **sending** (the model selector's neighbor); HUD toggle is not pre-send UX.
  - `conversation.composer.dock` — band *under* the card, not in the tool row; wrong locality for a 28×28 icon.
  - `conversation.session.header.actions` — correct as an additive action list, but renders *above* the composer, not adjacent to it; mirrors the job-list / agent-preset placement but loses the HUD visual rhythm that `dsh-hud` relies on (matched by sibling `a903067276-rgb/dsh-hud`).
  - `shell.overlay` — viable for a floating button but loses the stable tool-row slot semantics and theme context the shipped composer provides.
- **Migration plan**: keep `conversation.input.left` as the primary seat; no fallback needed in `v0.1.0`.

### Floating panel that overlays the right edge of conversation

- **Use `shell.overlay`** — declared `kind: 'list'`, `scope: 'root'`, declared by `root` (client-ui-layout), documented verbatim as *"the additive seat for a frame-wide surface of your own"* [2][6]. Frame-wide click-through by default, additive (no shipped occupants, `replaceRisk: 'none'`), and sits *above every column and outside their scroll containers* — exactly the layering the subagent monitor panel needs.
- **Why not alternatives**:
  - `details` — `kind: 'single'`, occupied by `DetailsPanel`; registering here shadows the shipped UI and "takes every action entry down with it" per the slot catalog's own warning [2][3]. Wrong target.
  - `conversation.input.overlay` — anchored to the composer card; it's a popup / menu anchor, not a frame-wide panel [10].
  - `tool.view.cordis` — only renders inside the latest eligible `cordis_run` card; not a persistent panel surface [2].
  - A custom column added via slot replacement — invasive; defeats the additive convention and would shadow the conversation body.
- **Layering**: the floating panel is mounted under `shell.overlay` with its own position-fixed layer over the conversation column. Anchor it visually to the right edge (the same column the `details` panel would occupy when opened) so an open monitor panel can substitute cleanly if the layout would otherwise be busy.

### Practical mapping for `dsh-subagent-pro`

| Surface | Seat | Rationale |
|---|---|---|
| HUD toggle (in `src/client/toggle.tsx`) | `conversation.input.left` | Matches `dsh-hud` convention; tool-row-adjacent icon; session-scoped refresh; zero risk today |
| Floating subagent monitor (in `src/client/panel.tsx`) | `shell.overlay` | Add frame-wide, click-through-by-default, right-edge anchored via CSS; non-shadowing |
| Settings role editor (in `src/client/role-editor.tsx`) | `settings.section` | Already the canonical seat; verify `id: 'subagent-pro.roles'` is unique |

## Migration Risk

**Low.** Renaming `conversation.input.left` would be a coordinated PR touching:

1. `packages/client/ui-conversation/src/client/contract/slots.ts` — SlotMap augmentation comment + name.
2. `packages/client/ui-conversation/src/client/apply.ts` — `children: { 'conversation.input.left': … }` in the `'conversation'` registration.
3. The composition (in `ConversationRoot.tsx`) that renders the `leftItems` passed into `ComposerBarOwnerProps.leftItems`.
4. The runtime slot-catalog (regenerated from the contract — GitHub Action expected; not yet verified the generator's source path) [2].
5. `InputZone` JSDoc — cross-references to `.left` and `.right`.

**No rename is planned or in flight on `master` as of `dsh-v0.1.1-rc.2`** (commit history check on `slots.ts` returned no deprecation / rename messages; the most recent surface-level fixes did not touch the input-region declarations) [11]. Risks to monitor:

- The `InputZone` owner props (`session`, `input` as point-in-time snapshots) could grow — a breaking-ish change but never a rename; absorb by ignoring new fields.
- The five-slot family (`conversation.input.{dock,left,right,overlay}` + `conversation.composer.dock`) is documented and wired together, so a future "tool row rework" lands as one PR with a JSDoc note. **Suggested monitor: subscribe to commits on `packages/client/ui-conversation/src/client/apply.ts` for changes to the `children:` block of the `'conversation'` registration** — that block is the single source-of-truth signal for the input-region surface.
- If the dependency-inversion direction changes (the SlotMap type merge for `conversation.input.overlay` is *transitive* from ui-input-trigger — explicit in the JSDoc: *"the dependency direction is the hard constraint — ui-input-trigger cannot import this package"*) [10], sibling slots could move; unlikely but worth tracking.

**Recommendation**: ship the HUD toggle on `conversation.input.left` and the floating panel on `shell.overlay` in `v0.1.0`. No fallback registration needed. Add a CI / release-watch on the input-region `children:` block of `packages/client/ui-conversation/src/client/apply.ts` as the canary for any upcoming rework.

## Sources

1. `packages/client/ui-conversation/src/client/contract/slots.ts` (SlotMap augmentation, `conversation.input.left` declaration) — <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-conversation/src/client/contract/slots.ts>
2. `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` (runtime slot catalog with `replaceRisk`, `occupants`, `declaredBy`) — <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/extensions/cordis-client-runner/src/client/slot-catalog.ts>
3. `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx` (composition render site) — <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx>
4. `packages/client/ui-conversation/src/client/apply.ts` (slot-declaration call sites, `conversation.input.left` wired into the `conversation` entry) — <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-conversation/src/client/apply.ts>
5. `packages/client/ui-conversation/src/client/apply.ts` (single-source-of-truth block for the five input-region slots) — <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-conversation/src/client/apply.ts>
6. `packages/client/ui-layout/src/client/index.ts` (`shell.overlay` declaration, declarative doc) — <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-layout/src/client/index.ts>
7. `packages/client/ui-sidebar/src/client/contract/slots.ts` (sidebar.* namespace) — <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-sidebar/src/client/contract/slots.ts>
8. `packages/client/runtime/src/client/slots.ts` (built-in `root`) — <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/runtime/src/client/slots.ts>
9. `packages/client/ui-settings/src/client/contract/slots.ts` (settings.* namespace) — <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-settings/src/client/contract/slots.ts>
10. `packages/client/ui-input-trigger/src/client/slots.ts` (SlotMap merge for `conversation.input.overlay`; documents the dependency-direction invariant) — <https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-input-trigger/src/client/slots.ts>
11. Recent commit log on `packages/client/ui-conversation/src/client/contract/slots.ts` (last 5 distinct commits: 5f7ac91 `fix(web): address subagent header review findings`; de572dd `feat(web): refine subagent header switcher`; 319d9a7 `feat(client): compose deployment branding through slots`; 2442e63 `fix: cr`; 0148c9b merge; **none rename or deprecate `conversation.input.left`**) — <https://github.com/deepseek-ai/deepseek-harness/commits/master/packages/client/ui-conversation/src/client/contract/slots.ts>
12. `.agents/notes/implemented/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md` (architecture rationale note confirming the input-region slot set is the shipped composition) — <https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/architecture/2026-07-25-web-input-machine-and-slash-pipeline.md>
13. Release tags on `dsh` line: `dsh-v0.1.1-rc.2` (latest), `dsh-v0.1.1-rc.1` — <https://github.com/deepseek-ai/deepseek-harness/tags>
