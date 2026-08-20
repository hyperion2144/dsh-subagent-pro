/**
 * Main-agent role guidance section.
 *
 * Registers a system-prompt section listing every role in the merged table
 * (project-md > global-md > settings). Each role shows displayName, optional
 * provider/model binding, description, and the Delegate line.
 *
 * Inherited from dsh-plugin-subagent-director (guidance.ts); the section text
 * function reads ResolvedSubagentProSettings.getRoles() so the listing tracks
 * md + settings live (no manual reload).
 */
import { fileIdFromPath } from './agents-md.js'
import type { MergedRole, ResolvedSubagentProSettings } from './settings.js'

/** Prompt order: just after dsh-tool-subagent's 116.5 tool section. */
export const GUIDANCE_SECTION_ORDER = 117

/** Stable, unique section name (configuration changes only affect new assemblies). */
export const GUIDANCE_SECTION_NAME = 'dsh-subagent-pro:roles'

/** Compute the role id used by the resolver (file basename for md roles; settings key for settings). */
function roleIdFor(role: MergedRole): string {
  if (role.source === 'settings') return ''  // settings roles are keyed by id, surfaced separately by UI
  return role.filePath !== undefined ? fileIdFromPath(role.filePath) : ''
}

export function renderRolesGuidance(resolved: ResolvedSubagentProSettings, toolName: string): string {
  const roles = resolved.getRoles()
  if (roles.length === 0) return ''

  const lines: string[] = [
    'Subagent Pro roles — delegate one of these role-bound subagents when the task matches its description. Each role may bind a model; when it does, the subagent runs on that model route.',
    'Reference roles by their id (the kebab-case file name or settings.roles key); the model can also reference roles by their displayName and the resolver will map it.',
  ]
  for (const role of roles) {
    const id = roleIdFor(role)
    const bound =
      role.provider !== undefined && role.provider !== ''
        ? role.model !== undefined && role.model !== ''
          ? ' (model: ' + role.provider + '/' + role.model + ')'
          : ' (provider: ' + role.provider + ')'
        : ''
    const src =
      role.source === 'project-md'
        ? ' · project-md'
        : role.source === 'global-md'
          ? ' · global-md'
          : ' · settings'
    const idText = id !== '' ? ' [' + id + ']' : ''
    lines.push('- ' + role.displayName + idText + bound + src + ': ' + role.description)
    if (id !== '') {
      lines.push('    Delegate with: ' + toolName + '({ role: "' + id + '", prompt: "..." })')
    } else {
      lines.push('    (this role is defined in settings; use its settings key as the role argument)')
    }
  }
  return lines.join('\n')
}

export function applyGuidance(
  ctx: { get(name: string): unknown; logger?: { debug?: (m: string) => void } },
  resolvedFactory: () => ResolvedSubagentProSettings,
  toolName: string,
): (() => void) | undefined {
  const systemPrompt = ctx.get('systemPrompt') as
    | { section: (spec: { name: string; order: number; text: () => string }) => () => void }
    | undefined
  if (systemPrompt === undefined) {
    ctx.logger?.debug?.('[dsh-subagent-pro] systemPrompt not mounted; skipping role guidance section')
    return undefined
  }
  return systemPrompt.section({
    name: GUIDANCE_SECTION_NAME,
    order: GUIDANCE_SECTION_ORDER,
    text: () => renderRolesGuidance(resolvedFactory(), toolName),
  })
}
