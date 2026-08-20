/**
 * Subagent Pro — host half entry.
 *
 * Wires three capabilities into one loader:
 *   1. Live subagent run monitor — subscribes to subagent/start and subagent/end
 *      events globally, attributes runs to their root session via the parent
 *      chain, and exposes the merged view (events + durable descendant catalog)
 *      at /api/dsh-subagent-pro/snapshot for the browser panel.
 *   2. Role-based subagent routing — registers the `subagent_role` model-facing
 *      tool with a four-layer fallback (call > role > default > inherit). Roles
 *      come from three sources, merged with explicit precedence: project agent
 *      md > global agent md > settings.roles. The role's persona and toolFilter
 *      flow into SubagentStartRequest so they reach the child verbatim.
 *   3. Default route seam — wraps ctx.subagents.start / startContinuable so any
 *      subagent started without explicit agentOptions receives the configured
 *      defaultProvider/defaultModel. Un-routable defaults silently fall back.
 *
 * Settings live under the `subagent-pro` settings namespace; settings.yaml
 * edits and the role editor UI both flow through the standard dsh-settings seam
 * — no bespoke HTTP bridge required (we are in-tree so inject reaches settings
 * directly).
 */
import type { Context } from '@deepseek-ai/cordis'

import type { SubagentProConfig } from './index-types.js'
export type { SubagentProConfig } from './index-types.js'

import { mountMonitor } from './monitor.js'
import { mountRoles } from './roles.js'
import { loadAgentMdRoles, refreshAgentMdRoles } from './agents-md.js'
import { resolveSettings } from './settings.js'

export const name = 'dsh-subagent-pro'
export const inject = [
  'webServer',
  'sessions',
  'subagents',
  'tools',
  'llm',
  'settings',
  'systemPrompt',
  'jobs',
  'shell',
]

export function apply(ctx: Context, config: SubagentProConfig = {}): void {
  // 1. settings snapshot — single source of truth for defaults + role table.
  const resolved = resolveSettings(ctx, config)

  // 2. Agent md handle (file scanner, refreshable on settings/cwd change).
  const agentMd = loadAgentMdRoles(resolved.globalAgentDir, resolved.projectAgentDirName)

  const reloadMd = (): void => {
    const cwd = ctx.get('shell')?.cwd
    const merged = refreshAgentMdRoles(
      agentMd,
      resolved.globalAgentDir,
      resolved.projectAgentDirName,
      cwd,
    )
    resolved.setMdRoles(merged.roles, merged.warnings)
  }
  reloadMd()
  ;(ctx as unknown as { on: (event: string, listener: () => void) => void }).on('settings/change', reloadMd)

  // 3. Live subagent monitor — event attribution + snapshot endpoint.
  mountMonitor(ctx, resolved)

  // 4. Role-based routing: delegation tool + default route seam + system prompt section.
  mountRoles(ctx, config, resolved, agentMd)
}
