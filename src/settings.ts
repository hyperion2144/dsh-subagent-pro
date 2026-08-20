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
 * Live updates use dsh-settings' setSource/onChange wiring (director pattern);
 * md overlay updates trigger via `setMdRoles` from agents-md.ts.
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'

import type { RoleTemplate, SubagentProSettings } from './route-resolver.js'

export type { RoleTemplate, SubagentProSettings } from './route-resolver.js'

/** Settings namespace id (kebab-case; matches cordis.patch.yml entry id). */
export const SUBAGENT_PRO_SETTINGS_NAMESPACE = 'subagent-pro'

/** Source of a role in the merged table — used by the role editor to mark md-synced rows. */
export type RoleSource = 'project-md' | 'global-md' | 'settings'

export interface MergedRole extends RoleTemplate {
  /** Where this role came from in the merged view. */
  source: RoleSource
  /** Absolute path of the agent md file, when source is project/global-md. */
  filePath?: string
}

export interface ResolvedSubagentProSettings {
  /** The current raw settings snapshot (settings.yaml + UI overrides). */
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

export function resolveSettings(
  ctx: Context,
  config: { globalAgentDir?: string; projectAgentDirName?: string },
): ResolvedSubagentProSettings {
  const settingsSvc = ctx.get('settings')
  const globalAgentDir = config.globalAgentDir ?? homedir() + '/.dsh/agents'
  const projectAgentDirName = config.projectAgentDirName ?? '.dsh/agents'

  let base: SubagentProSettings = {}
  let mdLayer: MergedRole[] = []
  let warnings: string[] = []

  const computeMerged = (): MergedRole[] => {
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

  if (settingsSvc === undefined) {
    const logger = (ctx as unknown as { logger?: { debug?: (m: string) => void } }).logger
    logger?.debug?.('[subagent-pro] no settings service mounted; using empty base')
    return {
      get: () => base,
      getRoles: () => computeMerged(),
      setMdRoles: (roles, w) => {
        mdLayer = roles
        warnings = w
      },
      getWarnings: () => warnings,
      globalAgentDir,
      projectAgentDirName,
    }
  }

  // Lazy settings subscription: read current value, subscribe to changes.
  let cached: SubagentProSettings = {}
  try {
    const descriptors = (settingsSvc as { describe(opts: { redactSecrets: boolean }): Array<{ ns: string; value: SubagentProSettings }> }).describe({ redactSecrets: true })
    for (const d of descriptors) {
      if (d.ns === SUBAGENT_PRO_SETTINGS_NAMESPACE) cached = d.value ?? {}
    }
  } catch (err) {
    const logger = (ctx as unknown as { logger?: { warn?: (m: string) => void } }).logger
    logger?.warn?.('[subagent-pro] settings describe failed: ' + (err instanceof Error ? err.message : String(err)))
  }
  base = cached

  const onChange = (ctx as unknown as { on?: (event: string, listener: (ns: string, next: unknown) => void) => void }).on
  onChange?.('settings/change', (ns: string, next: unknown) => {
    if (ns !== SUBAGENT_PRO_SETTINGS_NAMESPACE) return
    base = (next as SubagentProSettings) ?? {}
  })

  return {
    get: () => base,
    getRoles: () => computeMerged(),
    setMdRoles: (roles, w) => {
      mdLayer = roles
      warnings = w
    },
    getWarnings: () => warnings,
    globalAgentDir,
    projectAgentDirName,
  }
}
