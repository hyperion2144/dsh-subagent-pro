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
import { loadAgentMdRolesAcrossWorkspaces } from './agents-md.js'
import { resolveSettings, SUBAGENT_PRO_SETTINGS_NAMESPACE } from './settings.js'

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

  // 2. Agent md roles — same multi-workspace loader the bridge /roles endpoint
  //    and the settings UI use, so the runtime role table (subagent_roles,
  //    subagent_role lookup, system-prompt guidance) shows the SAME merged
  //    table as the browser: global agent dir + every registered workspace's
  //    .dsh/agents/*.md, project wins on id collisions.
  const reloadMd = (): void => {
    const merged = loadAgentMdRolesAcrossWorkspaces(
      ctx,
      resolved.globalAgentDir,
      resolved.projectAgentDirName,
    )
    resolved.setMdRoles(merged.roles, merged.warnings)
  }
  reloadMd()
  // `settings/updated` (not `settings/change`) is the canonical resolved-value
  // event from @deepseek-ai/dsh-settings; re-scan agent md on every commit so
  // edits to the subagent-pro namespace (or any other namespace that the md
  // overlay depends on) refresh the role table without a restart.
  ;(ctx as unknown as { on: (event: string, listener: (ns: string) => void) => void }).on(
    'settings/updated',
    (ns: string) => {
      if (ns !== SUBAGENT_PRO_SETTINGS_NAMESPACE) return
      reloadMd()
    },
  )
  // The workspaceRegistry service (dsh-workspace) becomes ACTIVE asynchronously
  // after boot — its `Service.init` awaits storage/session persistence, so a
  // reloadMd() at apply time may run before the registry exists and cache an
  // empty md layer. Cordis emits `internal/service` when a service is provided
  // (state == active), so re-scan the md layer once workspaceRegistry appears.
  // `ctx.get(name, false)` would read even inactive impls; the event fires for
  // the active value via `reflect.notify`.
  ;(ctx as unknown as { on: (event: string, listener: (name: string) => void) => void }).on(
    'internal/service',
    (name: string) => {
      if (name !== 'workspaceRegistry') return
      reloadMd()
    },
  )

  // 3. Live subagent monitor — event attribution + snapshot endpoint.
  mountMonitor(ctx, resolved)

  // 4. Role-based routing: delegation tool + default route seam + system prompt section.
  mountRoles(ctx, config, resolved)
}
