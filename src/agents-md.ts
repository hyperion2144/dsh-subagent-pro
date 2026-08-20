/**
 * Agent md loader — Claude Code style .md subagent definitions.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import type { MergedRole } from './settings.js'

const MD_EXT = '.md'
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

interface FrontmatterShape {
  name?: string
  description?: string
  tools?: string
  model?: string
  [key: string]: unknown
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
    const byId = new Map<string, MergedRole>()
    for (const r of globalScan.roles) byId.set(r.filePath ?? '', r)
    for (const r of projectScan.roles) byId.set(r.filePath ?? '', r)
    return {
      roles: [...byId.values()],
      warnings: [...globalScan.warnings, ...projectScan.warnings],
    }
  }
  return { globalDir, projectDirName, resolveProjectDir, load }
}

export function refreshAgentMdRoles(
  handle: AgentMdHandle,
  _globalDir: string,
  _projectDirName: string,
  cwd: string | undefined,
): AgentMdLoadResult {
  const globalScan = scanDir(handle.globalDir, 'global-md')
  const projectScan = scanDir(handle.resolveProjectDir(cwd), 'project-md')
  const byId = new Map<string, MergedRole>()
  for (const r of globalScan.roles) byId.set(r.filePath ?? '', r)
  for (const r of projectScan.roles) byId.set(r.filePath ?? '', r)
  return {
    roles: [...byId.values()],
    warnings: [...globalScan.warnings, ...projectScan.warnings],
  }
}

export const _internal = { parseFrontmatter, parseModel, parseTools, readOne, scanDir, isKebabCase, lastSegment, stripMdExt, fileIdFromPath }
