/**
 * Subagent Pro settings — namespace, schema, validation, and live snapshot.
 *
 * Inherited verbatim from dsh-plugin-subagent-director (settings.ts + route-resolver.ts):
 *   - kebab-case role ids, non-empty displayName/description,
 *   - defaultRole references an existing role,
 *   - 4-layer fallback: call > role > default > inherit.
 *
 * The merger (resolved.getRoles()) layers in:
 *   project agent md > global agent md > settings.roles (UI/调试沙盒)
 *
 * Live updates: installSettingsSection hands us a `setSource` getter at
 * register time. The getter resolves to the current registered value on every
 * call (settings.yaml hot reload + UI writes both flow through it). We store
 * the getter and call it on every read so live edits are visible without an
 * additional event subscription — same pattern as dsh-agent-default-model
 * (dsh-agent-default-model/lib/index.js:45-50). Do NOT add a `settings/change`
 * listener here: that event name does not exist (the real name is
 * `settings/updated`, see dsh-settings/lib/types/types.d.ts:31).
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'

import type { RoleTemplate, SubagentProSettings } from './route-resolver.js'

export type { RoleTemplate, SubagentProSettings } from './route-resolver.js'

/** Settings namespace id (kebab-case; matches cordis.patch.yml entry id). */
export const SUBAGENT_PRO_SETTINGS_NAMESPACE = 'subagent-pro'

/**
 * Permissive schemastery schema for the subagent-pro namespace. Schemastery
 * makes all object fields optional by default; `.loose()` opts out of strict
 * key checks so future plugin versions writing new fields don't get rejected
 * by older plugin builds.
 */
export const SubagentProSettingsSchema: z<SubagentProSettings> = z
  .object({})
  .loose() as unknown as z<SubagentProSettings>

/** Source of a role in the merged table — used by the role editor to mark md-synced rows. */
export type RoleSource = 'project-md' | 'global-md' | 'settings'

export interface MergedRole extends RoleTemplate {
  /** Where this role came from in the merged view. */
  source: RoleSource
  /** Absolute path of the agent md file, when source is project/global-md. */
  filePath?: string
}

export interface ResolvedSubagentProSettings {
  /** The current resolved settings snapshot (live: re-reads on every call). */
  get(): SubagentProSettings
  /** The current merged role table (md > settings). */
  getRoles(): MergedRole[]
  /** Replace the md layer of the merged table (called when md scan refreshes). */
  setMdRoles(roles: MergedRole[], warnings: string[]): void
  /** Current warnings emitted by md loading (key/format issues). */
  getWarnings(): string[]
  /** Absolute path of the global agent directory (defaults to <homedir>/.dsh/agents). */
  readonly globalAgentDir: string
  /** Directory name under cwd for project agents (defaults to '.dsh/agents'). */
  readonly projectAgentDirName: string
}

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function validateSettings(value: SubagentProSettings): void {
  const roles = value.roles ?? {}
  for (const [id, role] of Object.entries(roles)) {
    if (role === undefined) continue
    if (!KEBAB_CASE.test(id)) {
      throw new Error(
        'subagent-pro: role id "' + id + '" is not kebab-case (lowercase letters, digits and single hyphens)',
      )
    }
    if (role.displayName.trim() === '') {
      throw new Error('subagent-pro: role "' + id + '" must have a non-empty displayName')
    }
    if (role.description.trim() === '') {
      throw new Error('subagent-pro: role "' + id + '" must have a non-empty description')
    }
    if (typeof role.provider === 'string' && role.provider.trim() === '') {
      throw new Error('subagent-pro: role "' + id + '" provider must be a non-empty string when set')
    }
  }
  if (value.defaultRole !== undefined && value.defaultRole !== '' && roles[value.defaultRole] === undefined) {
    throw new Error(
      'subagent-pro: defaultRole "' + value.defaultRole + '" does not reference a defined role',
    )
  }
  if (typeof value.defaultProvider === 'string' && value.defaultProvider.trim() === '') {
    throw new Error('subagent-pro: defaultProvider must be a non-empty string when set')
  }
}

/**
 * Snapshot holder — bridges installSettingsSection's hooks to the consumer-
 * facing API. Same shape as dsh-plugin-subagent-director's
 * `createSettingsSnapshot`:
 *
 *   - `hooks.setSource(getter)` is called by installSettingsSection ONCE the
 *     namespace is registered; it captures a live getter on the scope.
 *   - `hooks.onChange()` is called by installSettingsSection after each commit;
 *     we re-invoke the captured source to refresh the cached snapshot, so the
 *     getter always sees the latest value (no reliance on a cordis event).
 *   - `get()` returns the cached snapshot.
 *
 * The dsh-settings SettingsScope's `get()` already returns the live value
 * (`registration.resolved` is updated in-place on every commit), so
 * re-invoking the source on every onChange is sufficient and matches the
 * dsh-agent-default-model pattern.
 */
export interface SettingsSnapshot<T> {
  hooks: { setSource(getter: () => T): void; onChange(): void }
  get(): T
}

export function createSettingsSnapshot<T>(initial: T): SettingsSnapshot<T> {
  let source: (() => T) | undefined
  let snapshot: T = initial
  return {
    hooks: {
      setSource(getter) {
        source = getter
        snapshot = getter()
      },
      onChange() {
        if (source !== undefined) snapshot = source()
      },
    },
    get() {
      return snapshot
    },
  }
}

export function resolveSettings(
  ctx: Context,
  config: { globalAgentDir?: string; projectAgentDirName?: string },
): ResolvedSubagentProSettings {
  const globalAgentDir = config.globalAgentDir ?? homedir() + '/.dsh/agents'
  const projectAgentDirName = config.projectAgentDirName ?? '.dsh/agents'

  let mdLayer: MergedRole[] = []
  let warnings: string[] = []

  const computeMerged = (base: SubagentProSettings): MergedRole[] => {
    const out: MergedRole[] = []
    for (const r of mdLayer) out.push(r)
    for (const [id, role] of Object.entries(base.roles ?? {})) {
      if (role === undefined) continue
      out.push({
        ...role,
        source: 'settings',
        filePath: 'settings:' + id,
      })
    }
    return out
  }

  // Snapshot holder — follows the dsh-plugin-subagent-director pattern:
  // installSettingsSection calls snapshot.hooks.setSource() with the live
  // SettingsScope.get() getter, and snapshot.hooks.onChange() after each
  // commit. The snapshot getter returns the cached value, so every consumer
  // (default route seam, role guidance, delegation tool) sees the same
  // resolved view without re-registering event listeners.
  const snapshot = createSettingsSnapshot<SubagentProSettings>({})
  installSubagentProSettings(ctx, {}, snapshot.hooks)

  return {
    get: () => snapshot.get(),
    getRoles: () => computeMerged(snapshot.get()),
    setMdRoles: (roles, w) => {
      mdLayer = roles
      warnings = w
    },
    getWarnings: () => warnings,
    globalAgentDir,
    projectAgentDirName,
  }
}

/**
 * Install the `subagent-pro` settings namespace into the host settings service.
 *
 * No-op if the deployment has no settings service mounted (e.g. headless profile
 * without dsh-settings-file). After this call, ctx.settings.describe() lists
 * `subagent-pro` and our bridge endpoint at /api/dsh-subagent-pro/settings can
 * read/write it.
 *
 * Follows the dsh-plugin-subagent-director pattern: installSettingsSection
 * captures the live SettingsScope.get() getter via `hooks.setSource(...)` and
 * fires `hooks.onChange()` after each commit. Our SettingsSnapshot wires
 * those hooks directly so consumer getters always see the latest value.
 */
export function installSubagentProSettings(
  ctx: Context,
  entry: SubagentProSettings = {},
  hooks: {
    setSource(current: () => SubagentProSettings): void
    onChange(): void
  },
): void {
  const settingsSvc = (ctx as unknown as { get(name: string): unknown }).get('settings')
  if (settingsSvc === undefined) return
  try {
    installSettingsSection<SubagentProSettings>(
      ctx,
      SUBAGENT_PRO_SETTINGS_NAMESPACE as never,
      SubagentProSettingsSchema,
      entry,
      hooks,
    )
  } catch (err) {
    // Tolerate a second install (hot-reload, double-mount): settings.register
    // throws when the namespace already exists. Log + move on.
    const message = err instanceof Error ? err.message : String(err)
    if (!/already (declared|registered)/i.test(message)) {
      throw err
    }
  }
}
