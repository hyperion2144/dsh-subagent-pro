/**
 * Roles info tool `subagent_roles` — model-facing tool that lets the agent
 * discover every role it can pass to `subagent_role({ role: ... })`.
 *
 * The list is the merged role table the router already uses: project agent md
 * (every registered workspace) > global agent md > settings.roles. Each entry
 * carries its source, optional LLM route binding, persona presence, and tool
 * scoping so the agent can pick a role id and describe its effect accurately.
 *
 *   subagent_roles()                          → every role
 *   subagent_roles({ role: "code-reviewer" }) → that role's details (or empty)
 *
 * The tool tolerates a missing role table (returns an empty list rather than
 * throwing).
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { MergedRole } from './agents-md.js'

export const ROLES_TOOL_PREFIX = 'dsh-subagent-pro'

export interface RolesToolArgs {
  /** Optional exact role id (or displayName) to look up. Omit for all roles. */
  role?: string
}

/** Public wire shape of one role — mirrors MergedRole but JSON-safe. */
export interface RoleInfoEntry {
  /** Role id (filename for md roles, settings key for settings roles). */
  id: string
  displayName: string
  description: string
  /** 'project-md' | 'global-md' | 'settings'. */
  source: string
  /** Absolute path for md roles; 'settings:<id>' for settings roles. */
  filePath?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  /** True when a persona body is attached (role binds a system-prompt section). */
  hasPersona?: boolean
  /** Tool allow-list, when the role scopes tools. */
  toolAllow?: string[]
  /** True when the same id exists in another layer and the project copy won. */
  isOverride?: boolean
}

export interface RolesResult {
  kind: 'roles'
  roles: RoleInfoEntry[]
}

/** Source label mapping for the wire. */
const SOURCE_LABEL: Record<string, string> = {
  'project-md': '项目',
  'global-md': '全局',
  settings: '设置',
}

/**
 * Derive the stable role id for the wire, mirroring exactly how the
 * delegation tool resolves roles:
 *
 *   - md roles   → file basename without `.md` (e.g. `code-reviewer`)
 *   - settings   → the raw settings key, i.e. the `settings:` prefix of the
 *                  synthetic `filePath` is STRIPPED (`settings:auditor` → `auditor`)
 *
 * The delegation tool's `byId` matches settings roles by the raw settings
 * key (`getSettings().roles[id]`), so exposing `settings:auditor` here would
 * hand the agent an id that can never resolve. This function keeps the two
 * contracts aligned.
 */
export function roleIdFromPath(filePath: string | undefined): string {
  if (filePath === undefined || filePath === '') return ''
  if (filePath.startsWith('settings:')) {
    return filePath.slice('settings:'.length)
  }
  const base = filePath.slice(Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')) + 1)
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

export function toRoleEntry(role: MergedRole, id?: string): RoleInfoEntry {
  return {
    id: id ?? roleIdFromPath(role.filePath),
    displayName: role.displayName,
    description: role.description,
    source: SOURCE_LABEL[role.source] ?? role.source,
    ...(role.filePath !== undefined ? { filePath: role.filePath } : {}),
    ...(role.provider !== undefined ? { provider: role.provider } : {}),
    ...(role.model !== undefined ? { model: role.model } : {}),
    ...(role.reasoningEffort !== undefined ? { reasoningEffort: role.reasoningEffort } : {}),
    ...(role.persona !== undefined && role.persona !== '' ? { hasPersona: true } : {}),
    ...(role.toolFilter?.allow !== undefined ? { toolAllow: role.toolFilter.allow } : {}),
    ...(role.isOverride === true ? { isOverride: true } : {}),
  }
}

export interface CreateRolesToolOptions {
  ctx: Context
  toolName?: string
  /** The merged role table the router uses (project md > global md > settings). */
  getRoles: () => MergedRole[]
}

export function createRolesTool(opts: CreateRolesToolOptions): unknown {
  const { getRoles } = opts
  const toolName = opts.toolName ?? 'subagent_roles'

  const tool = defineTool({
    name: toolName,
    description:
      'List every role that can be passed to the `subagent_role` tool, merged from project agent md files (each registered workspace’s .dsh/agents/*.md), global agent md files (~/.dsh/agents/*.md), and the subagent-pro settings namespace. ' +
      'Call with no arguments to list all roles; pass `role` (id or display name) to get one role\'s details. Each entry includes its source label, optional provider/model route binding, whether a persona is attached, and tool scoping.',
    parameters: {
      role: {
        type: 'string',
        description: 'Optional role id or display name to look up. Omit to list every role.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'roles' },
          roles: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                displayName: { type: 'string', required: true },
                description: { type: 'string', required: true },
                source: { type: 'string', required: true },
                filePath: { type: 'string' },
                provider: { type: 'string' },
                model: { type: 'string' },
                reasoningEffort: { type: 'string' },
                hasPersona: { type: 'boolean' },
                toolAllow: {
                  type: 'array',
                  items: { type: 'string' },
                },
                isOverride: { type: 'boolean' },
              },
            },
          },
        },
      },
      render: (_args: RolesToolArgs, value: RolesResult) => {
        if (value.roles.length === 0) {
          return [{ type: 'text', text: 'no roles available' }]
        }
        const lines = value.roles.map((r) => {
          const route =
            r.provider !== undefined || r.model !== undefined
              ? ' [' + [r.provider, r.model].filter((s) => s !== undefined).join('/') + ']'
              : ''
          const persona = r.hasPersona === true ? ' persona' : ''
          const tools = r.toolAllow !== undefined ? ' tools=' + r.toolAllow.join(',') : ''
          return r.id + ' (' + r.displayName + ') [' + r.source + ']' + route + persona + tools
        })
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: RolesToolArgs): Promise<RolesResult> {
      const all = getRoles()
      const entries = all.map((r) => toRoleEntry(r))
      const text = args.role === undefined || args.role === ''
        ? entries
        : entries.filter((r) => r.id === args.role || r.displayName === args.role)
      return { kind: 'roles' as const, roles: text }
    },
  })
  return tool as unknown as never
}