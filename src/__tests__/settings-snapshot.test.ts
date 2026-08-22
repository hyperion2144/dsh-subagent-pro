import test from 'node:test'
import assert from 'node:assert/strict'

import { createSettingsSnapshot } from '../settings.js'
import type { SubagentProSettings } from '../route-resolver.js'

/**
 * createSettingsSnapshot is the bridge between installSettingsSection's
 * `setSource` hook and the consumer-facing get(). The source getter returns
 * the LIVE registered value on every invocation (settings.yaml hot reload +
 * UI writes both flow through it), so the snapshot must NOT cache.
 *
 * These tests lock down that contract because an earlier build subscribed to a
 * non-existent `settings/change` event and cached the initial value, so the
 * seam never saw user-edited defaults.
 */

test('snapshot falls back to the initial composition entry before setSource', () => {
  const initial: SubagentProSettings = { defaultProvider: 'p', defaultModel: 'm' }
  const snap = createSettingsSnapshot(initial)
  assert.deepEqual(snap.get(), initial)
})

test('snapshot.hooks.setSource replaces the live source and onChange refreshes the cache', () => {
  // Director pattern: setSource installs the live getter, onChange is fired by
  // the settings service after each commit and triggers a cache refresh. Until
  // onChange fires the cached snapshot stays put; the previous "re-read on every
  // get" pattern was masking the missing-event-subscription bug.
  const snap = createSettingsSnapshot({})
  let live: SubagentProSettings = { defaultProvider: 'first', defaultModel: 'm1' }
  snap.hooks.setSource(() => live)
  assert.deepEqual(snap.get(), live)

  live = { defaultProvider: 'second', defaultModel: 'm2' }
  assert.deepEqual(
    snap.get(),
    { defaultProvider: 'first', defaultModel: 'm1' },
    'cache is stable until onChange fires (the runtime fires it on every commit)',
  )

  snap.hooks.onChange()
  assert.deepEqual(snap.get(), live, 'after onChange the cache reflects the new source value')

  live = { defaultProvider: 'third', defaultModel: 'm3', defaultReasoningEffort: 'high' }
  snap.hooks.onChange()
  assert.deepEqual(snap.get(), live)
})

test('snapshot tracks the settings service detach fallback (entry back to composition)', () => {
  const composition: SubagentProSettings = { defaultProvider: 'comp', defaultModel: 'cm' }
  const snap = createSettingsSnapshot(composition)
  let live: SubagentProSettings | undefined = { defaultProvider: 'live', defaultModel: 'lm' }
  snap.hooks.setSource(() => live as SubagentProSettings)
  assert.equal(snap.get().defaultProvider, 'live')

  // Simulate installSettingsSection handing back the entry getter when the
  // settings service detaches.
  live = undefined
  snap.hooks.setSource(() => composition)
  assert.deepEqual(snap.get(), composition)
})

test('snapshot.hooks.onChange re-reads the captured source (settings commit)', () => {
  // Regression: the previous wiring subscribed to a non-existent
  // `settings/change` event and cached the initial value, so the seam
  // never saw user-edited defaults. The director-style fix is to refresh
  // from the captured source on every onChange() callback.
  const initial: SubagentProSettings = { defaultProvider: 'minimax-cn', defaultModel: 'MiniMax-M3' }
  const snap = createSettingsSnapshot(initial)

  let live: SubagentProSettings = { defaultProvider: 'opencode-go', defaultModel: 'deepseek-v4-flash' }
  snap.hooks.setSource(() => live)
  assert.deepEqual(snap.get(), live, 'after setSource the cached snapshot reflects the source')

  // User edits again. The dsh-settings commit fires onChange; the snapshot
  // re-reads source on each call to refresh the cache.
  live = { defaultProvider: 'deepseek-official', defaultModel: 'deepseek-v4-flash' }
  snap.hooks.onChange()
  assert.deepEqual(snap.get(), live, 'edited defaults visible to the seam after onChange')
})
