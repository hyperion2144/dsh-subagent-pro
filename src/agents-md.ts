/**
 * Agent md loader — Claude Code style .md subagent definitions.
 *
 * Reads role definitions from two sources:
 *   1. Global: `${globalAgentDir}/*.md` (default `~/.dsh/agents/`)
 *   2. Project: `${workspace.path}/${projectDirName}/*.md` for every registered
 *      workspace (`ctx.workspaceRegistry.list()`) — host injects the registry
 *      in web profiles, so the panel sees one entry per opened project.
 *
 * Roles are merged into a single deduped list keyed by id (filename). When the
 * same id appears in both layers the **project** version wins (displayName,
 * description, persona, provider, model, reasoningEffort, toolFilter) — and
 * every layer that contributed is recorded on `altPaths[]` so the panel can
 * render an `also: 全局/项目` chip without losing the global copy.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MD_EXT = '.md'
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

interface FrontmatterShape {
  name?: string
  description?: string
  tools?: string
  model?: string
  [key: string]: unknown
}

/** Local mirror of {@link RoleTemplate} from route-resolver — duplicated here
 *  so this module has no `settings.js` import (it feeds `settings.js`, not
 *  the other way around). The shape is identical so callers can cast. */
export interface RoleTemplate {
  displayName: string
  description: string
  persona?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  toolFilter?: { allow?: string[]; deny?: string[] }
}

export type RoleSource = 'project-md' | 'global-md' | 'settings'

/** Local mirror of {@link MergedRole} from settings — same shape, kept
 *  standalone so this module's tests don't pull in the cordis boot graph.
 *  `altPaths` / `isOverride` are only set by `mergeRoles` when both layers
 *  define the same id (project always wins). */
export interface MergedRole extends RoleTemplate {
  source: RoleSource
  filePath?: string
  altPaths?: string[]
  isOverride?: boolean
}

interface ParsedAgentMd {
  id: string
  filePath: string
  source: 'project-md' | 'global-md'
  role: MergedRole
  warnings: string[]
}

export interface AgentMdLoadResult {
  roles: MergedRole[]
  warnings: string[]
}

export interface AgentMdHandle {
  globalDir: string
  projectDirName: string
  resolveProjectDir(cwd: string | undefined): string | undefined
  load(cwd: string | undefined): AgentMdLoadResult
}

/** Loose shape of the host workspace registry entry we depend on. */
interface WorkspaceEntryLike {
  path?: string
}

function isKebabCase(s: string): boolean {
  return KEBAB_CASE.test(s)
}

/** Strip .md suffix from a basename. Pure string op. */
export function stripMdExt(name: string): string {
  return name.endsWith('.md') ? name.slice(0, -3) : name
}

/** Extract the last path segment by scanning backward for / or \. Avoids regex. */
export function lastSegment(pathStr: string): string {
  let last = 0
  for (let i = pathStr.length - 1; i >= 0; i--) {
    const ch = pathStr.charCodeAt(i)
    if (ch === 47 || ch === 92) {
      last = i + 1
      break
    }
  }
  return pathStr.slice(last)
}

/** Strip .md suffix from a file basename (uses lastSegment + stripMdExt). */
export function fileIdFromPath(filePath: string): string {
  return stripMdExt(lastSegment(filePath))
}

function parseFrontmatter(raw: string): { fm: FrontmatterShape; body: string; warnings: string[] } {
  const warnings: string[] = []
  if (!raw.startsWith('---')) {
    return { fm: {}, body: raw, warnings }
  }
  const rest = raw.slice(3)
  const newlineIdx = rest.indexOf('\n')
  if (newlineIdx === -1) {
    return { fm: {}, body: raw, warnings: ['unterminated frontmatter (no closing ---)'] }
  }
  const afterFirstLine = rest.slice(newlineIdx + 1)
  const closeIdx = afterFirstLine.indexOf('\n---')
  if (closeIdx === -1) {
    return { fm: {}, body: raw, warnings: ['unterminated frontmatter (no closing ---)'] }
  }
  const fmRaw = afterFirstLine.slice(0, closeIdx)
  const body = afterFirstLine.slice(closeIdx + 4).replace(/^\n+/, '')
  const fm: FrontmatterShape = {}
  for (const line of fmRaw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const colon = line.indexOf(':')
    if (colon === -1) continue
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '')
    if (key === '' || value === '') continue
    fm[key] = value
  }
  return { fm, body, warnings }
}

function parseModel(spec: string | undefined): { provider?: string | undefined; model?: string | undefined } {
  if (spec === undefined || spec.trim() === '') return {}
  const parts = spec.split('/').map((p) => p.trim()).filter((p) => p !== '')
  if (parts.length === 2) return { provider: parts[0], model: parts[1] }
  return { model: parts[0] }
}

function parseTools(spec: string | undefined): string[] | undefined {
  if (spec === undefined || spec.trim() === '') return undefined
  const out: string[] = []
  for (const tok of spec.split(/\s+/)) {
    if (tok === '') continue
    out.push(tok)
  }
  return out.length > 0 ? out : undefined
}

function readOne(filePath: string, source: 'project-md' | 'global-md'): ParsedAgentMd {
  const fileBase = stripMdExt(lastSegment(filePath))
  const id = fileBase

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch (err) {
    return {
      id: '',
      filePath,
      source,
      role: { displayName: '', description: '', source, filePath },
      warnings: [
        'subagent-pro: failed to read agent md ' + filePath + ': ' + (err instanceof Error ? err.message : String(err)),
      ],
    }
  }

  if (!isKebabCase(id)) {
    return {
      id,
      filePath,
      source,
      role: { displayName: '', description: '', source, filePath },
      warnings: [
        'subagent-pro: agent md file "' + filePath + '" has a non-kebab-case base name; skipping (id="' + id + '")',
      ],
    }
  }

  const { fm, body, warnings: fmWarnings } = parseFrontmatter(raw)
  const displayName = typeof fm.name === 'string' && fm.name.trim() !== '' ? fm.name.trim() : fileBase
  const description = typeof fm.description === 'string' && fm.description.trim() !== ''
    ? fm.description.trim()
    : fileBase
  const providerModel = parseModel(typeof fm.model === 'string' ? fm.model : undefined)
  const tools = parseTools(typeof fm.tools === 'string' ? fm.tools : undefined)

  const role: MergedRole = {
    displayName,
    description,
    ...(body.trim() !== '' ? { persona: body.trim() } : {}),
    ...(providerModel.provider !== undefined ? { provider: providerModel.provider } : {}),
    ...(providerModel.model !== undefined ? { model: providerModel.model } : {}),
    ...(tools !== undefined ? { toolFilter: { allow: tools } } : {}),
    source,
    filePath,
  }

  const warnings: string[] = [...fmWarnings]
  if (description === fileBase) {
    warnings.push(
      'subagent-pro: agent md "' + filePath + '" has no description; main agent guidance will fall back to the filename',
    )
  }

  return { id, filePath, source, role, warnings }
}

function scanDir(
  dir: string | undefined,
  source: 'project-md' | 'global-md',
): { roles: MergedRole[]; warnings: string[] } {
  if (dir === undefined) return { roles: [], warnings: [] }
  if (!existsSync(dir)) return { roles: [], warnings: [] }
  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(dir)
  } catch {
    return { roles: [], warnings: [] }
  }
  if (!stat.isDirectory()) return { roles: [], warnings: [] }

  const roles: MergedRole[] = []
  const warnings: string[] = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith(MD_EXT)) continue
    const filePath = join(dir, entry.name)
    const parsed = readOne(filePath, source)
    if (parsed.role.displayName === '' || parsed.role.description === '') {
      warnings.push(...parsed.warnings)
      continue
    }
    roles.push(parsed.role)
    warnings.push(...parsed.warnings)
  }
  return { roles, warnings }
}

/**
 * Merge roles from every contributing layer. Project always wins; the global
 * copy is preserved on `altPaths` so the UI can show `also: 全局` without
 * losing it. The `isOverride` flag tells the panel when project overrode
 * a same-named global (so the panel can label the role "项目" and add the
 * alt chip).
 */
function mergeRoles(globalRoles: MergedRole[], projectRoles: MergedRole[]): MergedRole[] {
  const idFromPath = (filePath: string | undefined): string => {
    if (filePath === undefined || filePath === '') return ''
    return stripMdExt(lastSegment(filePath))
  }
  const byId = new Map<string, MergedRole>()
  for (const g of globalRoles) {
    const id = idFromPath(g.filePath)
    if (id === '') continue
    byId.set(id, g)
  }
  for (const p of projectRoles) {
    const id = idFromPath(p.filePath)
    if (id === '') continue
    const existing = byId.get(id)
    const projectRole: MergedRole = {
      ...p,
      ...(existing !== undefined ? { altPaths: [existing.filePath ?? ''].filter((s) => s !== '') } : {}),
      source: 'project-md',
      ...(existing !== undefined ? { isOverride: true } : {}),
    }
    byId.set(id, projectRole)
  }
  return [...byId.values()]
}

export function loadAgentMdRoles(
  globalDir: string,
  projectDirName: string,
): AgentMdHandle {
  const resolveProjectDir = (cwd: string | undefined): string | undefined => {
    if (cwd === undefined || cwd === '') return undefined
    return join(cwd, projectDirName)
  }
  const load = (cwd: string | undefined): AgentMdLoadResult => {
    const globalScan = scanDir(globalDir, 'global-md')
    const projectScan = scanDir(resolveProjectDir(cwd), 'project-md')
    return {
      roles: mergeRoles(globalScan.roles, projectScan.roles),
      warnings: [...globalScan.warnings, ...projectScan.warnings],
    }
  }
  return { globalDir, projectDirName, resolveProjectDir, load }
}

/**
 * Load agent md roles for every registered workspace in addition to the
 * single project cwd path. Used by the host's `/api/dsh-subagent-pro/roles`
 * bridge endpoint so the panel can render file-backed roles for **every**
 * project the user has open, not just the current session's cwd.
 *
 * Tolerates an absent workspaceRegistry (headless / smoke without host spine):
 * falls back to the current cwd only.
 */
export function loadAgentMdRolesAcrossWorkspaces(
  ctx: unknown,
  globalDir: string,
  projectDirName: string,
): AgentMdLoadResult {
  // Read the workspace registry through the OPTIONAL-service path so this
  // loader is safe to call from entries that do NOT declare it in `inject`
  // (the host entry's apply() must boot even in headless profiles where the
  // registry is absent). Direct property access would throw "cannot get
  // property without inject" under cordis; `ctx.get()` resolves registered
  // services (bridge entry injects workspaceRegistry) and returns undefined
  // otherwise. Plain-object callers (tests) fall back to the property.
  const getFn = (ctx as { get?: (name: string) => unknown }).get
  const rawRegistry =
    getFn !== undefined ? getFn('workspaceRegistry') : (ctx as { workspaceRegistry?: unknown }).workspaceRegistry
  const registry = rawRegistry as { list?: () => WorkspaceEntryLike[] } | undefined
  const workspacePaths: string[] = []
  if (registry?.list !== undefined) {
    try {
      for (const ws of registry.list()) {
        if (typeof ws?.path === 'string' && ws.path !== '') {
          workspacePaths.push(ws.path)
        }
      }
    } catch {
      /* fall through to empty */
    }
  }
  // Documented fallback for headless / smoke profiles without the workspace
  // registry: scan the shell cwd's project agent dir instead, so project md
  // roles stay visible (matches the previous refreshAgentMdRoles(cwd) path).
  if (workspacePaths.length === 0) {
    const shell = (ctx as { get?: (name: string) => { cwd?: string } | undefined }).get?.('shell')
    if (typeof shell?.cwd === 'string' && shell.cwd !== '') {
      workspacePaths.push(shell.cwd)
    }
  }

  const globalScan = scanDir(globalDir, 'global-md')
  const projectRoles: MergedRole[] = []
  const warnings: string[] = [...globalScan.warnings]
  for (const wsPath of workspacePaths) {
    const scan = scanDir(join(wsPath, projectDirName), 'project-md')
    // Tag each role with its workspace path so the panel can show which
    // workspace it came from when multiple projects are open.
    for (const r of scan.roles) {
      projectRoles.push({ ...r, filePath: r.filePath ?? '' })
    }
    warnings.push(...scan.warnings)
  }

  return {
    roles: mergeRoles(globalScan.roles, projectRoles),
    warnings,
  }
}

export function refreshAgentMdRoles(
  handle: AgentMdHandle,
  _globalDir: string,
  _projectDirName: string,
  cwd: string | undefined,
): AgentMdLoadResult {
  const globalScan = scanDir(handle.globalDir, 'global-md')
  const projectScan = scanDir(handle.resolveProjectDir(cwd), 'project-md')
  return {
    roles: mergeRoles(globalScan.roles, projectScan.roles),
    warnings: [...globalScan.warnings, ...projectScan.warnings],
  }
}

export const _internal = { parseFrontmatter, parseModel, parseTools, readOne, scanDir, isKebabCase, lastSegment, stripMdExt, fileIdFromPath, mergeRoles }
