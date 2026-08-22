/**
 * Integration test: what does resolveRoute return when fed the actual settings
 * shape we just persisted via the bridge?
 *
 * Simulates the user's scenario:
 *   settings.defaultProvider = 'minimax-cn'
 *   settings.defaultModel = 'MiniMax-M3'
 *   settings.defaultReasoningEffort = 'high'
 * And calls resolveRoute with no args (the case the user is hitting).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveRoute, type RoleLookup, type RouteInput } from '../route-resolver.js'

const lookup: RoleLookup = {
  byId: () => undefined,
  byDisplayName: () => undefined,
}

test('default-minimax-cn + MiniMax-M3 produces expected agentOptions', () => {
  // 1) the live settings as fetched from the bridge in our smoke test:
  const liveView = {
    defaultProvider: 'minimax-cn',
    defaultModel: 'MiniMax-M3',
    defaultReasoningEffort: 'high',
  }

  // 2) the parent options as they exist for the user's session
  //    (DSH default + whatever the user picked in the chat composer)
  const parent = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }

  // 3) tool called with NO provider/model/reasoningEffort args
  const args = {}

  const input: RouteInput = { args, settings: liveView, parent }
  const result = resolveRoute(input, lookup)

  console.log('[route]', JSON.stringify(result, null, 2))

  assert.equal(result.layer, 'default', 'should fall to default layer')
  assert.deepEqual(result.agentOptions, {
    provider: 'minimax-cn',
    model: 'MiniMax-M3',
  }, 'agentOptions must reflect settings defaults')
  assert.equal(result.reasoningEffort, 'high')
})

test('default-not-set falls to inherit', () => {
  const liveView = {}  // no defaults set
  const parent = { provider: 'deepseek-official', model: 'deepseek-v4-pro' }
  const args = {}

  const result = resolveRoute({ args, settings: liveView, parent }, lookup)

  assert.equal(result.layer, 'inherit')
  assert.equal(result.agentOptions, undefined)
})
