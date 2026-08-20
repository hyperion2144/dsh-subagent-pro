/**
 * Route resolver — pure-function core of role-based subagent routing.
 *
 * Resolves which LLM provider/model an agentOptions should carry for one
 * subagent delegation, walking the four-layer fallback chain:
 *
 *   1. call     — explicit arguments on the tool call (per-call override)
 *   2. role     — the role template bound by args.role (or defaultRole)
 *   3. default  — plugin default provider/model from settings
 *   4. inherit  — nothing configured: do NOT inject anything, let the seam
 *                 inherit the parent agent (zero intrusion)
 *
 * persona and toolFilter come ONLY from the role layer.
 *
 * Field resolution is independent: each of provider/model/reasoningEffort is
 * filled by the highest-priority layer that specifies it.
 *
 * Pure, synchronous, side-effect-free so it is trivially testable and replayable.
 *
 * Inherited from dsh-plugin-subagent-director (route-resolver.ts); extended here
 * to accept a `resolveRole` predicate so the role table can be the merged
 * project-md + global-md + settings view (no behavior change for the call site).
 */
import type { AgentOptions } from '@deepseek-ai/dsh-agent'

export type RouteLayer = 'call' | 'role' | 'default' | 'inherit'

export interface RoleTemplate {
  /** Required, non-empty display name. */
  displayName: string
  /** Required, non-empty delegation guidance shown to the main agent. */
  description: string
  /** Persona text injected into the subagent (role-layer only). */
  persona?: string
  /** LLM route provider override (role-layer only). */
  provider?: string
  /** Model id override (role-layer only). */
  model?: string
  /** Reasoning effort override (role-layer only; advisory). */
  reasoningEffort?: string
  /** Tool scoping (role-layer only). */
  toolFilter?: { allow?: string[]; deny?: string[] }
}

export interface SubagentProSettings {
  defaultProvider?: string
  defaultModel?: string
  defaultReasoningEffort?: string
  defaultRole?: string
  /** Whether an invalid role-bound model falls back to the parent (default true). */
  fallbackOnInvalid?: boolean
  roles?: Record<string, RoleTemplate>
}

export interface RouteCallArgs {
  role?: string
  provider?: string
  model?: string
  reasoningEffort?: string
}

export interface RouteParent {
  provider?: string
  model?: string
}

export interface RouteInput {
  args?: RouteCallArgs
  settings: SubagentProSettings
  parent?: RouteParent
}

export interface RouteToolFilter {
  allow?: string[]
  deny?: string[]
}

export interface RouteResult {
  layer: RouteLayer
  agentOptions?: Pick<AgentOptions, 'provider' | 'model'>
  reasoningEffort?: string
  roleId?: string
  persona?: string
  toolFilter?: RouteToolFilter
  warnings: string[]
}

/**
 * Role table lookup. The caller supplies the merged view (project-md > global-md >
 * settings); the resolver remains pure over the table.
 */
export interface RoleLookup {
  /** Returns the role bound to id, or undefined if absent. */
  byId(id: string): RoleTemplate | undefined
  /** Returns the role bound to displayName (first match wins), or undefined. */
  byDisplayName(name: string): { id: string; role: RoleTemplate } | undefined
}

function isEmpty(value: string | undefined): boolean {
  return value === undefined || value === ''
}

export function resolveRoute(input: RouteInput, lookup: RoleLookup): RouteResult {
  const { args = {}, settings } = input
  const warnings: string[] = []

  const callProvider = isEmpty(args.provider) ? undefined : args.provider
  const callModel = isEmpty(args.model) ? undefined : args.model
  const callEffort = isEmpty(args.reasoningEffort) ? undefined : args.reasoningEffort

  const explicitRole = isEmpty(args.role) ? undefined : args.role
  const roleIdRaw = explicitRole ?? settings.defaultRole

  let role: RoleTemplate | undefined
  let resolvedRoleId: string | undefined

  if (roleIdRaw !== undefined) {
    const byId = lookup.byId(roleIdRaw)
    if (byId !== undefined) {
      role = byId
      resolvedRoleId = roleIdRaw
    } else {
      const byDisplay = lookup.byDisplayName(roleIdRaw)
      if (byDisplay !== undefined) {
        role = byDisplay.role
        resolvedRoleId = byDisplay.id
        warnings.push(
          'subagent-pro: role "' + roleIdRaw + '" is not an id; resolved by displayName to id "' + resolvedRoleId + '" — prefer passing the id directly',
        )
      } else {
        warnings.push(
          'subagent-pro: role "' + roleIdRaw + '" does not exist; its binding (persona/provider/model) is skipped',
        )
      }
    }
  }

  const roleProvider = role === undefined || isEmpty(role.provider) ? undefined : role.provider
  const roleModel = role === undefined || isEmpty(role.model) ? undefined : role.model
  const roleEffort =
    role === undefined || isEmpty(role.reasoningEffort) ? undefined : role.reasoningEffort

  const defaultProvider = isEmpty(settings.defaultProvider) ? undefined : settings.defaultProvider
  const defaultModel = isEmpty(settings.defaultModel) ? undefined : settings.defaultModel
  const defaultEffort = isEmpty(settings.defaultReasoningEffort)
    ? undefined
    : settings.defaultReasoningEffort

  const provider = callProvider ?? roleProvider ?? defaultProvider
  const model = callModel ?? roleModel ?? defaultModel
  const reasoningEffort = callEffort ?? roleEffort ?? defaultEffort

  const agentOptions: Pick<AgentOptions, 'provider' | 'model'> | undefined =
    provider !== undefined || model !== undefined
      ? {
          ...(provider !== undefined ? { provider } : {}),
          ...(model !== undefined ? { model } : {}),
        }
      : undefined

  let layer: RouteLayer = 'inherit'
  if (provider !== undefined || model !== undefined) {
    if (callProvider !== undefined || callModel !== undefined) layer = 'call'
    else if (roleProvider !== undefined || roleModel !== undefined) layer = 'role'
    else layer = 'default'
  }

  return {
    layer,
    ...(agentOptions !== undefined ? { agentOptions } : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(resolvedRoleId !== undefined ? { roleId: resolvedRoleId } : {}),
    ...(role !== undefined && !isEmpty(role.persona) ? { persona: role.persona } : {}),
    ...(role !== undefined && role.toolFilter !== undefined ? { toolFilter: role.toolFilter } : {}),
    warnings,
  }
}
