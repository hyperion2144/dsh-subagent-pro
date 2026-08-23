import test from 'node:test'
import assert from 'node:assert/strict'

import { createRolesTool, toRoleEntry, roleIdFromPath, type RolesToolArgs } from '../roles-info-tool.js'
import type { MergedRole } from '../agents-md.js'

const mdRole = (path: string, overrides: Partial<MergedRole> = {}): MergedRole => ({
  displayName: 'Display',
  description: 'desc',
  source: 'project-md',
  filePath: '/ws/proj/.dsh/agents/' + path + '.md',
  ...overrides,
})

test('toRoleEntry maps fields + source label', () => {
  const entry = toRoleEntry(
    {
      displayName: 'Code Reviewer',
      description: 'reviews code',
      source: 'project-md',
      filePath: '/ws/.dsh/agents/code-reviewer.md',
      provider: 'minimax-cn',
      model: 'MiniMax-M3',
      persona: 'you are a reviewer',
      toolFilter: { allow: ['Read', 'Grep'] },
      isOverride: true,
    },
    'code-reviewer',
  )
  assert.deepEqual(entry, {
    id: 'code-reviewer',
    displayName: 'Code Reviewer',
    description: 'reviews code',
    source: '项目',
    filePath: '/ws/.dsh/agents/code-reviewer.md',
    provider: 'minimax-cn',
    model: 'MiniMax-M3',
    hasPersona: true,
    toolAllow: ['Read', 'Grep'],
    isOverride: true,
  })
})

test('toRoleEntry: settings source label + optional fields omitted when absent', () => {
  const entry = toRoleEntry(
    { displayName: 'Custom', description: 'x', source: 'settings', filePath: 'settings:custom-role' },
    'custom-role',
  )
  assert.equal(entry.source, '设置')
  assert.equal(entry.filePath, 'settings:custom-role')
  assert.equal(entry.hasPersona, undefined)
  assert.equal(entry.provider, undefined)
  assert.equal(entry.model, undefined)
  assert.equal(entry.reasoningEffort, undefined)
  assert.equal(entry.toolAllow, undefined)
  assert.equal(entry.isOverride, undefined)
})

test('roleIdFromPath: md file path → basename without .md (posix + windows)', () => {
  assert.equal(roleIdFromPath('/ws/.dsh/agents/code-reviewer.md'), 'code-reviewer')
  assert.equal(roleIdFromPath('C:/ws/.dsh/agents/tester.md'), 'tester')
  assert.equal(roleIdFromPath('C:\\ws\\.dsh\\agents\\tester.md'), 'tester')
})

test('roleIdFromPath: settings synthetic path strips the settings: prefix → raw key', () => {
  assert.equal(roleIdFromPath('settings:custom-role'), 'custom-role')
  assert.equal(roleIdFromPath('settings:'), '')
  assert.equal(roleIdFromPath(undefined), '')
  assert.equal(roleIdFromPath(''), '')
})

test('toRoleEntry: settings roles expose the RAW settings key as id (delegation contract)', () => {
  const entry = toRoleEntry(
    { displayName: 'Custom', description: 'x', source: 'settings', filePath: 'settings:custom-role' },
  )
  assert.equal(entry.id, 'custom-role')
  assert.equal(entry.source, '设置')
  assert.equal(entry.filePath, 'settings:custom-role')
})

test('toRoleEntry: explicit id argument still wins (back-compat)', () => {
  const entry = toRoleEntry(
    { displayName: 'Custom', description: 'x', source: 'settings', filePath: 'settings:custom-role' },
    'custom-role',
  )
  assert.equal(entry.id, 'custom-role')
})

function rolesToolOf(getRoles: () => MergedRole[]) {
  const tool = createRolesTool({ ctx: { logger: { info: () => undefined } } as never, toolName: 'subagent_roles', getRoles })
  return (tool as unknown as { execute: (a: RolesToolArgs) => Promise<unknown> }).execute
}

test('createRolesTool: no params returns every merged role, scoped by source, settings id unwrapped', async () => {
  const roles: MergedRole[] = [
    mdRole('code-reviewer', {
      displayName: 'Code Reviewer',
      description: 'reviews',
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
    }),
    mdRole('tester', { displayName: 'Tester', description: 'tests', source: 'global-md', isOverride: true }),
    { displayName: 'Custom', description: 'settings role', source: 'settings', filePath: 'settings:custom' },
  ]
  const exec = rolesToolOf(() => roles)
  const result = (await exec({})) as { kind: string; roles: Array<{ id: string; source: string }> }
  assert.equal(result.kind, 'roles')
  assert.equal(result.roles.length, 3)
  assert.equal(result.roles[0]!.source, '项目')
  assert.equal(result.roles[1]!.source, '全局')
  assert.equal(result.roles[2]!.source, '设置')
  // The settings role id MUST be the raw settings key ('custom'), NOT
  // 'settings:custom' — otherwise `subagent_role({ role })` can never
  // resolve it through the delegation lookup.
  assert.deepEqual(
    result.roles.map((r) => r.id),
    ['code-reviewer', 'tester', 'custom'],
  )
})

test('createRolesTool: role arg filters by id or displayName', async () => {
  const roles: MergedRole[] = [
    mdRole('code-reviewer', { displayName: 'Code Reviewer', description: 'reviews' }),
    mdRole('tester', { displayName: 'Tester', description: 'tests', source: 'global-md' }),
  ]
  const exec = rolesToolOf(() => roles)

  const byId = (await exec({ role: 'tester' })) as { roles: Array<{ id: string }> }
  assert.equal(byId.roles.length, 1)
  assert.equal(byId.roles[0]!.id, 'tester')

  const byDisplay = (await exec({ role: 'Code Reviewer' })) as { roles: Array<{ id: string }> }
  assert.equal(byDisplay.roles.length, 1)
  assert.equal(byDisplay.roles[0]!.id, 'code-reviewer')
})

test('createRolesTool: unknown role returns empty list, not throw', async () => {
  const roles: MergedRole[] = [mdRole('code-reviewer', { displayName: 'Code Reviewer', description: 'reviews' })]
  const exec = rolesToolOf(() => roles)
  const result = (await exec({ role: 'missing' })) as { roles: unknown[] }
  assert.deepEqual(result.roles, [])
})

test('createRolesTool: missing/empty role table returns empty list', async () => {
  const exec = rolesToolOf(() => [])
  const result = (await exec({})) as { kind: string; roles: unknown[] }
  assert.equal(result.kind, 'roles')
  assert.deepEqual(result.roles, [])
})