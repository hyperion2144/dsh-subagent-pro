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
import { setSessionsService, setRolesService, type SessionsService, type RolesService } from './store'

export const inject = ['slots', 'sessions']

export function apply(ctx: ClientContext): void {
  // Resolved services — both are optional in the runtime contract.
  setSessionsService(ctx.get('sessions') as unknown as SessionsService | undefined)
  setRolesService(ctx.get('roles') as unknown as RolesService | undefined)

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
  const SLOTS = {
    inputLeft: 'conversation.input.left' as unknown as 'root',
    shellOverlay: 'shell.overlay' as unknown as 'root',
    settingsSection: 'settings.section' as unknown as 'root',
  }

  const register = ctx.slots.register as unknown as (
    options: { name: string; id?: string; order?: number; label?: string },
    component: unknown,
  ) => () => void

  ctx.slots.inject(
    SLOTS.inputLeft,
    () => register({ name: SLOTS.inputLeft, id: 'dsh-subagent-pro-toggle' }, Toggle),
  )

  ctx.slots.inject(
    SLOTS.shellOverlay,
    () => register({ name: SLOTS.shellOverlay, id: 'dsh-subagent-pro-panel' }, Panel),
  )

  ctx.slots.inject(
    SLOTS.settingsSection,
    () =>
      register(
        {
          name: SLOTS.settingsSection,
          id: 'dsh-subagent-pro-settings',
          order: 50,
          label: 'Subagent Pro',
        },
        RoleEditorSection,
      ),
  )
}
