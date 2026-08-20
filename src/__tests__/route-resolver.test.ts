import test from 'node:test'
import assert from 'node:assert/strict'

import { resolveRoute, type RoleLookup, type RouteInput } from '../route-resolver.js'
import type { RoleTemplate } from '../route-resolver.js'

/** Lookup that round-trips the full RoleTemplate (mirrors the real merged table). */
function makeLookup(roles: Record<string, RoleTemplate & { id?: string }>): RoleLookup {
  return {
    byId: (id: string) => roles[id],
    byDisplayName: (name: string) => {
      for (const [id, r] of Object.entries(roles)) {
        if (r.displayName === name) return { id, role: r }
      }
      return undefined
    },
  }
}

test('call layer wins over role and default', () => {
  const lookup = makeLookup({
    'code-reviewer': { displayName: 'Code Reviewer', description: 'desc' },
  })
  const input: RouteInput = {
    args: { provider: 'explicit-provider', model: 'explicit-model', role: 'code-reviewer' },
    settings: { defaultProvider: 'default-provider', defaultModel: 'default-model' },
  }
  const result = resolveRoute(input, lookup)
  assert.equal(result.layer, 'call')
  assert.deepEqual(result.agentOptions, { provider: 'explicit-provider', model: 'explicit-model' })
  assert.equal(result.warnings.length, 0)
})

test('role layer wins over default when no call override', () => {
  const lookup = makeLookup({
    'code-reviewer': {
      displayName: 'Code Reviewer',
      description: 'desc',
      provider: 'role-provider',
      model: 'role-model',
    },
  })
  const input: RouteInput = {
    args: { role: 'code-reviewer' },
    settings: { defaultProvider: 'default-provider', defaultModel: 'default-model' },
  }
  const result = resolveRoute(input, lookup)
  assert.equal(result.layer, 'role')
  assert.deepEqual(result.agentOptions, { provider: 'role-provider', model: 'role-model' })
})

test('default layer when no role bound', () => {
  const lookup = makeLookup({})
  const input: RouteInput = {
    args: {},
    settings: { defaultProvider: 'default-provider', defaultModel: 'default-model' },
  }
  const result = resolveRoute(input, lookup)
  assert.equal(result.layer, 'default')
  assert.deepEqual(result.agentOptions, { provider: 'default-provider', model: 'default-model' })
})

test('inherit layer when nothing configured (zero intrusion)', () => {
  const lookup = makeLookup({})
  const result = resolveRoute({ args: {}, settings: {} }, lookup)
  assert.equal(result.layer, 'inherit')
  assert.equal(result.agentOptions, undefined)
  assert.equal(result.persona, undefined)
})

test('displayName fallback when role id miss', () => {
  const lookup = makeLookup({
    'code-reviewer': { displayName: '代码审查员', description: 'desc' },
  })
  const input: RouteInput = {
    args: { role: '代码审查员' },
    settings: {},
  }
  const result = resolveRoute(input, lookup)
  assert.equal(result.roleId, 'code-reviewer')
  assert.match(result.warnings[0] ?? '', /resolved by displayName/)
})

test('persona flows from role layer only', () => {
  const lookup: RoleLookup = {
    byId: (id: string) =>
      id === 'foo'
        ? { displayName: 'Foo', description: 'desc', persona: 'I am Foo' }
        : undefined,
    byDisplayName: () => undefined,
  }
  const result = resolveRoute({ args: { role: 'foo' }, settings: {} }, lookup)
  assert.equal(result.persona, 'I am Foo')
})

test('call model without call provider still routes correctly', () => {
  const lookup = makeLookup({})
  const result = resolveRoute(
    { args: { model: 'm-only' }, settings: { defaultProvider: 'p' } },
    lookup,
  )
  // defaultProvider fills provider, call fills model
  assert.equal(result.layer, 'call')
  assert.deepEqual(result.agentOptions, { provider: 'p', model: 'm-only' })
})

test('unknown role id produces warning, no provider/model injected', () => {
  const lookup = makeLookup({})
  const result = resolveRoute({ args: { role: 'nonexistent' }, settings: {} }, lookup)
  assert.equal(result.agentOptions, undefined)
  assert.equal(result.layer, 'inherit')
  assert.match(result.warnings[0] ?? '', /does not exist/)
})

test('reasoningEffort is advisory (not part of agentOptions)', () => {
  const lookup = makeLookup({
    'foo': { displayName: 'Foo', description: 'desc', reasoningEffort: 'low' },
  })
  const result = resolveRoute({ args: { role: 'foo' }, settings: {} }, lookup)
  assert.equal(result.reasoningEffort, 'low')
  assert.equal(result.agentOptions, undefined)
})
