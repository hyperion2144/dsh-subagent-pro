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

// ---------------------------------------------------------------------------
// Pure helpers (unchanged semantics)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// New catalog-style validation
// ---------------------------------------------------------------------------

test('validateLlmInfoArgs: no params is valid (full catalog)', () => {
  assert.equal(validateLlmInfoArgs({}), undefined)
  assert.equal(validateLlmInfoArgs({ provider: '' }), undefined)
  assert.equal(validateLlmInfoArgs({ provider: 'p1' }), undefined)
  assert.equal(validateLlmInfoArgs({ provider: 'p1', model: 'm1' }), undefined)
})

test('validateLlmInfoArgs: model without provider is rejected', () => {
  const first = validateLlmInfoArgs({ model: 'm1' })
  assert.ok(first !== undefined)
  assert.match(first ?? '', /model.*requires.*provider/)

  const second = validateLlmInfoArgs({ provider: '', model: 'm1' })
  assert.ok(second !== undefined)
  assert.match(second ?? '', /model.*requires.*provider/)
})

test('validateLlmInfoArgs: empty model without provider is fine', () => {
  assert.equal(validateLlmInfoArgs({ model: '' }), undefined)
})

// ---------------------------------------------------------------------------
// getLlmInfoService
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Full catalog (no params)
// ---------------------------------------------------------------------------

const fullSvc = (): LlmInfoService => ({
  listProviders: () => [
    { id: 'deepseek-official', name: 'DeepSeek' },
    { id: 'minimax-cn', name: 'MiniMax CN' },
  ],
  listModels: async (provider) => {
    if (provider === 'deepseek-official') {
      return [
        { id: 'deepseek-v4-flash', name: 'Flash' },
        { id: 'deepseek-v4-pro', name: 'Pro' },
      ]
    }
    return [{ id: 'MiniMax-M3', name: 'M3' }]
  },
  resolveModelInfo: async (provider, model) => {
    if (provider === 'deepseek-official' && model === 'deepseek-v4-pro') {
      return {
        reasoning: {
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'High' },
          ],
          defaultEffort: 'high',
        },
      }
    }
    return { reasoning: { efforts: [{ id: 'low', name: 'Low' }] } }
  },
})

const execOf = (ctx: unknown): ((a: LlmInfoToolArgs) => Promise<unknown>) => {
  const tool = createLlmInfoTool({ ctx: ctx as never, toolName: 'subagent_providers' })
  return (tool as unknown as { execute: (a: LlmInfoToolArgs) => Promise<unknown> }).execute
}

test('createLlmInfoTool: no params returns nested catalog (all providers → models → efforts)', async () => {
  const ctx = { get: (_name: string) => fullSvc(), logger: { info: () => undefined } }
  const exec = execOf(ctx)
  const result = (await exec({})) as {
    kind: string
    providers: Array<{
      id: string
      name: string
      models: Array<{ id: string; name: string; reasoningEfforts: Array<{ id: string; name: string }>; defaultEffort?: string }>
    }>
  }
  assert.equal(result.kind, 'catalog')
  assert.equal(result.providers.length, 2)

  const minimax = result.providers.find((p) => p.id === 'minimax-cn')!
  assert.equal(minimax.name, 'MiniMax CN')
  assert.equal(minimax.models.length, 1)
  assert.equal(minimax.models[0]!.id, 'MiniMax-M3')
  assert.deepEqual(minimax.models[0]!.reasoningEfforts, [{ id: 'low', name: 'Low' }])

  const deepseek = result.providers.find((p) => p.id === 'deepseek-official')!
  assert.equal(deepseek.models.length, 2)
  const pro = deepseek.models.find((m) => m.id === 'deepseek-v4-pro')!
  assert.deepEqual(pro.reasoningEfforts, [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
  ])
  assert.equal(pro.defaultEffort, 'high')
})

test('createLlmInfoTool: provider-scoped returns only that provider subtree', async () => {
  const ctx = { get: (_name: string) => fullSvc(), logger: { info: () => undefined } }
  const exec = execOf(ctx)
  const result = (await exec({ provider: 'minimax-cn' })) as { kind: string; providers: Array<{ id: string; models: unknown[] }> }
  assert.equal(result.providers.length, 1)
  assert.equal(result.providers[0]!.id, 'minimax-cn')
  assert.equal(result.providers[0]!.models.length, 1)
})

test('createLlmInfoTool: unknown provider scoped returns empty providers', async () => {
  const ctx = { get: (_name: string) => fullSvc(), logger: { info: () => undefined } }
  const exec = execOf(ctx)
  const result = (await exec({ provider: 'nope' })) as { providers: unknown[] }
  assert.deepEqual(result.providers, [])
})

test('createLlmInfoTool: provider + model returns only that model leaf', async () => {
  const seen: Array<{ provider: string; model: string }> = []
  const svc: LlmInfoService = {
    ...fullSvc(),
    resolveModelInfo: async (provider, model) => {
      seen.push({ provider, model })
      return fullSvc().resolveModelInfo(provider, model)
    },
  }
  const ctx = { get: (_name: string) => svc, logger: { info: () => undefined } }
  const exec = execOf(ctx)
  const result = (await exec({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })) as {
    providers: Array<{ id: string; models: Array<{ id: string; reasoningEfforts: unknown[]; defaultEffort?: string }> }>
  }
  assert.equal(result.providers.length, 1)
  assert.equal(result.providers[0]!.models.length, 1)
  assert.equal(result.providers[0]!.models[0]!.id, 'deepseek-v4-pro')
  assert.equal(result.providers[0]!.models[0]!.defaultEffort, 'high')
  assert.deepEqual(seen, [{ provider: 'deepseek-official', model: 'deepseek-v4-pro' }], 'only the exact model is resolved')
})

test('createLlmInfoTool: missing llm service returns empty catalog instead of throwing', async () => {
  const ctx = { get: (_name: string) => undefined, logger: { info: () => undefined } }
  const exec = execOf(ctx)
  const noParams = (await exec({})) as { kind: string; providers: unknown[] }
  assert.equal(noParams.kind, 'catalog')
  assert.deepEqual(noParams.providers, [])

  const scoped = (await exec({ provider: 'p1', model: 'm1' })) as { kind: string; providers: unknown[] }
  assert.equal(scoped.kind, 'catalog')
  assert.deepEqual(scoped.providers, [])
})

test('createLlmInfoTool: validation throws before touching llm when model lacks provider', async () => {
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
  const exec = execOf(ctx)
  await assert.rejects(() => exec({ model: 'm1' }), /model.*requires.*provider/)
  assert.equal(touched, false)
})

test('createLlmInfoTool: model with empty provider string degrades to full catalog', async () => {
  const ctx = { get: (_name: string) => fullSvc(), logger: { info: () => undefined } }
  const exec = execOf(ctx)
  const result = (await exec({ provider: '', model: '' })) as { providers: unknown[] }
  assert.equal(result.providers.length, 2, 'empty strings are treated as "no scope"')
})