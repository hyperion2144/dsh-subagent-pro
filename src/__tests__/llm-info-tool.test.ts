import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createLlmInfoTool,
  getLlmInfoService,
  toEffortEntry,
  toModelEntry,
  toProviderEntry,
  validateLlmInfoArgs,
  type LlmInfoService,
  type LlmInfoToolArgs,
} from '../llm-info-tool.js'

test('toProviderEntry falls back to id when name missing', () => {
  assert.deepEqual(toProviderEntry({ id: 'opencode-go' }), { id: 'opencode-go', name: 'opencode-go' })
  assert.deepEqual(toProviderEntry({ id: 'x', name: 'X Provider' }), { id: 'x', name: 'X Provider' })
})

test('toModelEntry and toEffortEntry share the same id-fallback rule', () => {
  assert.deepEqual(toModelEntry({ id: 'm1' }), { id: 'm1', name: 'm1' })
  assert.deepEqual(toModelEntry({ id: 'm2', name: 'M2' }), { id: 'm2', name: 'M2' })
  assert.deepEqual(toEffortEntry({ id: 'high' }), { id: 'high', name: 'high' })
  assert.deepEqual(toEffortEntry({ id: 'low', name: 'Low' }), { id: 'low', name: 'Low' })
})

test('validateLlmInfoArgs: list_providers requires no params', () => {
  assert.equal(validateLlmInfoArgs({ action: 'list_providers' }), undefined)
})

test('validateLlmInfoArgs: list_models requires provider', () => {
  assert.equal(
    validateLlmInfoArgs({ action: 'list_models' })?.startsWith('dsh-subagent-pro:'),
    true,
  )
  assert.equal(validateLlmInfoArgs({ action: 'list_models', provider: '' })?.startsWith('dsh-subagent-pro:'), true)
  assert.equal(validateLlmInfoArgs({ action: 'list_models', provider: 'p1' }), undefined)
})

test('validateLlmInfoArgs: list_reasoning_efforts requires provider AND model', () => {
  assert.equal(
    validateLlmInfoArgs({ action: 'list_reasoning_efforts' })?.startsWith('dsh-subagent-pro:'),
    true,
  )
  assert.equal(
    validateLlmInfoArgs({ action: 'list_reasoning_efforts', provider: 'p1' })?.startsWith('dsh-subagent-pro:'),
    true,
  )
  assert.equal(
    validateLlmInfoArgs({ action: 'list_reasoning_efforts', provider: 'p1', model: '' })?.startsWith(
      'dsh-subagent-pro:',
    ),
    true,
  )
  assert.equal(
    validateLlmInfoArgs({ action: 'list_reasoning_efforts', provider: 'p1', model: 'm1' }),
    undefined,
  )
})

test('validateLlmInfoArgs: unknown action is rejected', () => {
  const msg = validateLlmInfoArgs({ action: 'list_everything' as unknown as 'list_providers' })
  assert.ok(msg !== undefined)
  assert.match(msg ?? '', /unknown action "list_everything"/)
})

test('getLlmInfoService returns undefined when ctx has no llm', () => {
  const ctx = { get: (_name: string) => undefined }
  assert.equal(getLlmInfoService(ctx as never), undefined)
})

test('getLlmInfoService returns undefined when ctx.llm lacks expected methods', () => {
  const ctx = { get: (_name: string) => ({ listProviders: () => [] }) }
  assert.equal(getLlmInfoService(ctx as never), undefined)
})

test('getLlmInfoService returns the service when methods are present', () => {
  const svc: LlmInfoService = {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => [],
    resolveModelInfo: async () => ({}),
  }
  const ctx = { get: (_name: string) => svc }
  assert.equal(getLlmInfoService(ctx as never), svc)
})

test('createLlmInfoTool: list_providers dispatches to llm.listProviders', async () => {
  const calls: string[] = []
  const svc: LlmInfoService = {
    listProviders: () => {
      calls.push('providers')
      return [
        { id: 'a', name: 'A' },
        { id: 'b' },
      ]
    },
    listModels: async () => {
      calls.push('models')
      return []
    },
    resolveModelInfo: async () => {
      calls.push('reasoning')
      return {}
    },
  }
  const ctx = { get: (_name: string) => svc, logger: { info: () => undefined } }
  const tool = createLlmInfoTool({ ctx: ctx as never, toolName: 'subagent_providers' })
  // Drive execute through the public surface — defineTool returns the
  // registry-bound tool but its execute is reachable via the .execute hook.
  // We cast through unknown to call it without the typed schema wrapper.
  const exec = (tool as unknown as { execute: (args: LlmInfoToolArgs) => Promise<unknown> }).execute
  const result = (await exec({ action: 'list_providers' })) as { kind: string; providers: Array<{ id: string; name: string }> }
  assert.equal(result.kind, 'providers')
  assert.deepEqual(result.providers, [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'b' },
  ])
  assert.deepEqual(calls, ['providers'])
})

test('createLlmInfoTool: list_models requires provider and dispatches', async () => {
  const calls: Array<{ method: string; provider?: string }> = []
  const svc: LlmInfoService = {
    listProviders: () => {
      calls.push({ method: 'providers' })
      return []
    },
    listModels: async (provider) => {
      calls.push({ method: 'models', provider })
      return [{ id: 'm1', name: 'M1' }]
    },
    resolveModelInfo: async () => {
      calls.push({ method: 'reasoning' })
      return {}
    },
  }
  const ctx = { get: (_name: string) => svc, logger: { info: () => undefined } }
  const tool = createLlmInfoTool({ ctx: ctx as never })
  const exec = (tool as unknown as { execute: (args: LlmInfoToolArgs) => Promise<unknown> }).execute
  const result = (await exec({ action: 'list_models', provider: 'p1' })) as { kind: string; provider: string; models: Array<{ id: string; name: string }> }
  assert.equal(result.kind, 'models')
  assert.equal(result.provider, 'p1')
  assert.deepEqual(result.models, [{ id: 'm1', name: 'M1' }])
  assert.deepEqual(calls, [{ method: 'models', provider: 'p1' }])
})

test('createLlmInfoTool: list_reasoning_efforts forwards provider + model', async () => {
  let lastResolve: { provider: string; model: string } | undefined
  const svc: LlmInfoService = {
    listProviders: () => [],
    listModels: async () => [],
    resolveModelInfo: async (provider, model) => {
      lastResolve = { provider, model }
      return {
        reasoning: {
          efforts: [
            { id: 'low', name: 'Low' },
            { id: 'high' },
          ],
          defaultEffort: 'low',
        },
      }
    },
  }
  const ctx = { get: (_name: string) => svc, logger: { info: () => undefined } }
  const tool = createLlmInfoTool({ ctx: ctx as never })
  const exec = (tool as unknown as { execute: (args: LlmInfoToolArgs) => Promise<unknown> }).execute
  const result = (await exec({ action: 'list_reasoning_efforts', provider: 'p1', model: 'm1' })) as {
    kind: string
    provider: string
    model: string
    efforts: Array<{ id: string; name: string }>
    defaultEffort: string | undefined
  }
  assert.equal(result.kind, 'reasoning')
  assert.deepEqual(lastResolve, { provider: 'p1', model: 'm1' })
  assert.deepEqual(result.efforts, [
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'high' },
  ])
  assert.equal(result.defaultEffort, 'low')
})

test('createLlmInfoTool: missing reasoning block returns empty efforts and no default', async () => {
  const svc: LlmInfoService = {
    listProviders: () => [],
    listModels: async () => [],
    resolveModelInfo: async () => ({}) as never,
  }
  const ctx = { get: (_name: string) => svc, logger: { info: () => undefined } }
  const tool = createLlmInfoTool({ ctx: ctx as never })
  const exec = (tool as unknown as { execute: (args: LlmInfoToolArgs) => Promise<unknown> }).execute
  const result = (await exec({ action: 'list_reasoning_efforts', provider: 'p1', model: 'm1' })) as {
    kind: string
    efforts: Array<{ id: string; name: string }>
    defaultEffort: string | undefined
  }
  assert.equal(result.kind, 'reasoning')
  assert.deepEqual(result.efforts, [])
  assert.equal(result.defaultEffort, undefined)
})

test('createLlmInfoTool: missing llm service returns empty results instead of throwing', async () => {
  const ctx = { get: (_name: string) => undefined, logger: { info: () => undefined } }
  const tool = createLlmInfoTool({ ctx: ctx as never })
  const exec = (tool as unknown as { execute: (args: LlmInfoToolArgs) => Promise<unknown> }).execute

  const providers = (await exec({ action: 'list_providers' })) as { kind: string; providers: unknown[] }
  assert.equal(providers.kind, 'providers')
  assert.deepEqual(providers.providers, [])

  const models = (await exec({ action: 'list_models', provider: 'p1' })) as { kind: string; provider: string; models: unknown[] }
  assert.equal(models.kind, 'models')
  assert.equal(models.provider, 'p1')
  assert.deepEqual(models.models, [])

  const reasoning = (await exec({ action: 'list_reasoning_efforts', provider: 'p1', model: 'm1' })) as {
    kind: string
    provider: string
    model: string
    efforts: unknown[]
    defaultEffort: undefined
  }
  assert.equal(reasoning.kind, 'reasoning')
  assert.equal(reasoning.provider, 'p1')
  assert.equal(reasoning.model, 'm1')
  assert.deepEqual(reasoning.efforts, [])
  assert.equal(reasoning.defaultEffort, undefined)
})

test('createLlmInfoTool: validation throws before touching llm when args are bad', async () => {
  let touched = false
  const svc: LlmInfoService = {
    listProviders: () => {
      touched = true
      return []
    },
    listModels: async () => {
      touched = true
      return []
    },
    resolveModelInfo: async () => {
      touched = true
      return {}
    },
  }
  const ctx = { get: (_name: string) => svc, logger: { info: () => undefined } }
  const tool = createLlmInfoTool({ ctx: ctx as never })
  const exec = (tool as unknown as { execute: (args: LlmInfoToolArgs) => Promise<unknown> }).execute
  await assert.rejects(() => exec({ action: 'list_models' }), /list_models.*provider/)
  await assert.rejects(() => exec({ action: 'list_reasoning_efforts', provider: 'p1' }), /list_reasoning_efforts.*model/)
  // Unknown action is caught by the schema enum validator (dsh-tools) before
  // reaching our handler, so the message format comes from the framework.
  await assert.rejects(
    () => exec({ action: 'unknown' as unknown as 'list_providers' }),
    /(unknown action|invalid arguments)/,
  )
  assert.equal(touched, false)
})
