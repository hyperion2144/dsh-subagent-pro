/**
 * dsh-subagent-pro — browser half entry.
 *
 * Slot composition (HUD-style placement):
 *   - `conversation.input.left` → Toggle button (28x28 icon button with running
 *      badge + warn-yellow active state). Replaces the monitor's sidebar text
 *      button.
 *   - `shell.overlay`           → Panel (floating card with status points,
 *      drag/resize, hide/clear).
 *   - `settings.section`        → Role editor (cards for settings.roles).
 *
 * State is shared between toggle and panel via a page-local store
 * (useSyncExternalStore) so they stay in sync without prop drilling.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'

import { Panel } from './panel'
import { Toggle } from './toggle'
import { RoleEditorSection } from './role-editor'
import { STYLES } from './styles'
import {
  setSessionsService,
  setSettingsService,
  type FileRoleInfo,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmReasoningEffortInfo,
  type SessionsService,
  type SettingsService,
} from './store'

export const inject = ['slots', 'sessions']

/** Settings bridge endpoint registered by src/bridge-entry.ts. */
const SETTINGS_VIEW = '/api/dsh-subagent-pro/settings/view'
const SETTINGS_MUTATE = '/api/dsh-subagent-pro/settings/mutate'
/** LLM-info bridge endpoints — provider/model/reasoning-effort enumeration. */
const LLM_PROVIDERS = '/api/dsh-subagent-pro/llm/providers'
const LLM_MODELS = '/api/dsh-subagent-pro/llm/models'
const LLM_REASONING = '/api/dsh-subagent-pro/llm/reasoning-efforts'
/** File-role bridge endpoint — every registered workspace's .dsh/agents/*.md
 *  plus the global `~/.dsh/agents/*.md` directory, merged with project-wins
 *  precedence. Powers the read-only "角色（文件）" section in the role editor. */
const FILE_ROLES = '/api/dsh-subagent-pro/roles'

function makeFetchSettingsService(): SettingsService & {
  listProviders(): Promise<LlmProviderInfo[]>
  listModels(provider: string): Promise<LlmModelInfo[]>
  listReasoningEfforts(provider: string, model: string): Promise<LlmReasoningEffortInfo[]>
  listFileRoles(): Promise<FileRoleInfo[]>
} {
  return {
    async read() {
      const res = await fetch(SETTINGS_VIEW, { credentials: 'same-origin' })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        throw new Error(`settings read HTTP ${res.status}: ${text}`)
      }
      const data = (await res.json()) as
        | { ok: true; view: Record<string, unknown>; revision: number }
        | { ok: false; error: { code: string; message: string } }
      if (!data.ok) throw new Error(`settings read failed: ${data.error.message}`)
      return { view: data.view, revision: data.revision }
    },
    async mutate(ops, expectedRevision) {
      const res = await fetch(SETTINGS_MUTATE, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ops, expectedRevision }),
      })
      const data = (await res.json()) as
        | { ok: true; view: Record<string, unknown>; revision: number }
        | { ok: false; error: { code: string; message: string } }
      if (!data.ok) throw new Error(`settings mutate failed: ${data.error.message}`)
      return { view: data.view, revision: data.revision }
    },
    async listProviders() {
      const res = await fetch(LLM_PROVIDERS, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`llm providers HTTP ${res.status}`)
      const data = (await res.json()) as
        | { ok: true; providers: LlmProviderInfo[] }
        | { ok: false; error: { code: string; message: string } }
      if (!data.ok) throw new Error(`llm providers failed: ${data.error.message}`)
      return data.providers
    },
    async listModels(provider) {
      const url = LLM_MODELS + '?provider=' + encodeURIComponent(provider)
      const res = await fetch(url, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`llm models HTTP ${res.status}`)
      const data = (await res.json()) as
        | { ok: true; models: LlmModelInfo[] }
        | { ok: false; error: { code: string; message: string } }
      if (!data.ok) throw new Error(`llm models failed: ${data.error.message}`)
      return data.models
    },
    async listReasoningEfforts(provider, model) {
      const url =
        LLM_REASONING +
        '?provider=' +
        encodeURIComponent(provider) +
        '&model=' +
        encodeURIComponent(model)
      const res = await fetch(url, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`llm reasoning-efforts HTTP ${res.status}`)
      const data = (await res.json()) as
        | { ok: true; efforts: LlmReasoningEffortInfo[]; defaultEffort?: string }
        | { ok: false; error: { code: string; message: string } }
      if (!data.ok) throw new Error(`llm reasoning-efforts failed: ${data.error.message}`)
      return data.efforts
    },
    async listFileRoles() {
      const res = await fetch(FILE_ROLES, { credentials: 'same-origin' })
      if (!res.ok) throw new Error(`file-roles HTTP ${res.status}`)
      const data = (await res.json()) as
        | { ok: true; roles: FileRoleInfo[]; warnings?: string[] }
        | { ok: false; error: { code: string; message: string } }
      if (!data.ok) throw new Error(`file-roles failed: ${data.error.message}`)
      return data.roles
    },
  }
}

export function apply(ctx: ClientContext): void {
  // Resolved services — both are optional in the runtime contract.
  setSessionsService(ctx.get('sessions') as unknown as SessionsService | undefined)
  // Settings bridge is provided by the host's dsh-subagent-pro-bridge entry
  // (prefix route /api/dsh-subagent-pro/settings). The client just fetches it.
  setSettingsService(makeFetchSettingsService())

  // Inject global stylesheet (HUD-style tokens + monitor-compatible panel chrome).
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-subagent-pro'
    tag.textContent = STYLES
    document.head.appendChild(tag)
    return () => {
      tag.remove()
    }
  }, 'dsh-subagent-pro: styles')

  // HUD-style toggle: conversation.input.left seat.
  // Slot names cast through unknown to bypass strict module-augmentation checks
  // (the augmentations live in peer packages we don't import here).
  //
  // CRITICAL: must invoke ctx.slots.register(...) inline so `this` stays bound to
  // the SlotRegistry instance. Extracting register to a local const detaches `this`,
  // and SlotRegistry.prototype.register uses `this.ctx.effect(...)` internally —
  // with `this === undefined` (strict mode) the call throws "Cannot read properties
  // of undefined (reading 'effect')" inside the runtime. dsh-hud and dsh-subagent-monitor
  // both call ctx.slots.register(...) inline for the same reason.
  const SLOTS = {
    inputLeft: 'conversation.input.left' as unknown as 'root',
    shellOverlay: 'shell.overlay' as unknown as 'root',
    settingsSection: 'settings.section' as unknown as 'root',
  }

  ctx.slots.inject(SLOTS.inputLeft, () =>
    ctx.slots.register(
      { name: SLOTS.inputLeft, id: 'dsh-subagent-pro-toggle' } as never,
      Toggle,
    ),
  )

  ctx.slots.inject(SLOTS.shellOverlay, () =>
    ctx.slots.register(
      { name: SLOTS.shellOverlay, id: 'dsh-subagent-pro-panel' } as never,
      Panel,
    ),
  )

  ctx.slots.inject(SLOTS.settingsSection, () =>
    ctx.slots.register(
      {
        name: SLOTS.settingsSection,
        id: 'dsh-subagent-pro-settings',
        order: 50,
        label: 'Subagent Pro',
      } as never,
      RoleEditorSection,
    ),
  )
}
