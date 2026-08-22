/**
 * LLM info tool `subagent_providers` — model-facing tool that lets the agent
 * discover which LLM providers, models, and reasoning-effort levels are
 * routable through the host `llm` service.
 *
 * Three actions (mutually exclusive, dispatched by `action`):
 *   - `list_providers`            → array of { id, name }
 *   - `list_models`               → requires `provider`, returns models
 *   - `list_reasoning_efforts`    → requires `provider` + `model`, returns efforts
 *
 * The shape mirrors the HTTP bridge at `/api/dsh-subagent-pro/llm/*` (same
 * service calls, identical output) so UI consumers (role editor) and the model
 * see the same data. The tool tolerates a missing `llm` service: every action
 * returns an empty result rather than throwing, so removing the llm service
 * mid-session does not break open agent runs.
 *
 * No subagent transport dependency — this tool only reads the host `llm`
 * service, so it can register as soon as `ctx.llm` is mounted.
 *
 * Inherited from dsh-plugin-subagent-director (delegation-tool.ts pattern).
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const LLM_INFO_TOOL_PREFIX = 'dsh-subagent-pro'

const ERROR_PREFIX = 'dsh-subagent-pro:'

/** Action enum — matches the bridge endpoints at /api/dsh-subagent-pro/llm/*. */
export type LlmInfoAction = 'list_providers' | 'list_models' | 'list_reasoning_efforts'

export interface LlmInfoToolArgs {
  action: LlmInfoAction
  provider?: string
  model?: string
}

export interface ProviderEntry {
  id: string
  name: string
}

export interface ModelEntry {
  id: string
  name: string
}

export interface ReasoningEffortEntry {
  id: string
  name: string
}

export interface ProvidersResult {
  kind: 'providers'
  providers: ProviderEntry[]
}

export interface ModelsResult {
  kind: 'models'
  provider: string
  models: ModelEntry[]
}

export interface ReasoningResult {
  kind: 'reasoning'
  provider: string
  model: string
  efforts: ReasoningEffortEntry[]
  /** Adapter-declared default effort (omitted when the adapter has none). */
  defaultEffort?: string
}

export type AnyLlmInfoResult = ProvidersResult | ModelsResult | ReasoningResult

/** Minimal host llm surface — the same one bridge-entry.ts relies on. */
export interface LlmInfoService {
  listProviders(): Array<{ id: string; name?: string }>
  listModels(provider: string): Promise<Array<{ id: string; name?: string }>>
  resolveModelInfo(
    provider: string,
    model: string,
  ): Promise<{
    reasoning?: { efforts: Array<{ id: string; name?: string }>; defaultEffort?: string }
  }>
}

function emptyProviders(): ProvidersResult {
  return { kind: 'providers', providers: [] }
}

function emptyModels(provider: string): ModelsResult {
  return { kind: 'models', provider, models: [] }
}

function emptyReasoning(provider: string, model: string): ReasoningResult {
  return { kind: 'reasoning', provider, model, efforts: [] }
}

/**
 * Map a raw provider descriptor to the public ProviderEntry shape. Falls back
 * to the id when the service omits a display name (forward-compat for adapters
 * that only ship an id).
 */
export function toProviderEntry(raw: { id: string; name?: string }): ProviderEntry {
  return { id: raw.id, name: raw.name ?? raw.id }
}

export function toModelEntry(raw: { id: string; name?: string }): ModelEntry {
  return { id: raw.id, name: raw.name ?? raw.id }
}

export function toEffortEntry(raw: { id: string; name?: string }): ReasoningEffortEntry {
  return { id: raw.id, name: raw.name ?? raw.id }
}

/**
 * Validate the action/params contract. Centralized so tests can exercise it
 * without spinning up a real `llm` service.
 */
export function validateLlmInfoArgs(args: { action: string; provider?: string; model?: string }): string | undefined {
  switch (args.action) {
    case 'list_providers':
      return undefined
    case 'list_models':
      if (typeof args.provider !== 'string' || args.provider === '') {
        return ERROR_PREFIX + ' action "list_models" requires a non-empty "provider" argument'
      }
      return undefined
    case 'list_reasoning_efforts':
      if (typeof args.provider !== 'string' || args.provider === '') {
        return ERROR_PREFIX + ' action "list_reasoning_efforts" requires a non-empty "provider" argument'
      }
      if (typeof args.model !== 'string' || args.model === '') {
        return ERROR_PREFIX + ' action "list_reasoning_efforts" requires a non-empty "model" argument'
      }
      return undefined
    default:
      return (
        ERROR_PREFIX +
        ' unknown action "' +
        String(args.action) +
        '" — expected one of: list_providers, list_models, list_reasoning_efforts'
      )
  }
}

export interface CreateLlmInfoToolOptions {
  ctx: Context
  toolName?: string
}

/** Resolve the llm service from a context, returning undefined when absent. */
export function getLlmInfoService(ctx: Context): LlmInfoService | undefined {
  const raw = (ctx as unknown as { get(name: string): unknown }).get('llm')
  if (raw === undefined || raw === null) return undefined
  const candidate = raw as Partial<LlmInfoService>
  if (
    typeof candidate.listProviders !== 'function' ||
    typeof candidate.listModels !== 'function' ||
    typeof candidate.resolveModelInfo !== 'function'
  ) {
    return undefined
  }
  return candidate as LlmInfoService
}

export function createLlmInfoTool(opts: CreateLlmInfoToolOptions): unknown {
  const { ctx } = opts
  const toolName = opts.toolName ?? 'subagent_providers'

  const tool = defineTool({
    name: toolName,
    description:
      'Discover routable LLM providers, models, and reasoning-effort levels available to the host `llm` service. ' +
      'Use `action: "list_providers"` to enumerate providers; `action: "list_models"` (requires `provider`) to enumerate models under a provider; `action: "list_reasoning_efforts"` (requires `provider` + `model`) to enumerate supported reasoning-effort levels and the model default. ' +
      'Tolerates a missing `llm` service: returns an empty result rather than throwing.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list_providers', 'list_models', 'list_reasoning_efforts'],
        description:
          'Which info slice to fetch. "list_providers" enumerates providers; "list_models" requires a provider; "list_reasoning_efforts" requires both provider and model.',
      },
      provider: {
        type: 'string',
        description: 'Provider id (required for list_models and list_reasoning_efforts).',
      },
      model: {
        type: 'string',
        description: 'Model id (required for list_reasoning_efforts).',
      },
    },
    output: {
      schema: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'providers' },
              providers: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'models' },
              provider: { type: 'string', required: true },
              models: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              kind: { type: 'string', required: true, const: 'reasoning' },
              provider: { type: 'string', required: true },
              model: { type: 'string', required: true },
              efforts: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                  },
                },
              },
              defaultEffort: { type: 'string' },
            },
          },
        ],
      },
      render: (_args: LlmInfoToolArgs, value: AnyLlmInfoResult) => {
        let text: string
        switch (value.kind) {
          case 'providers':
            text =
              value.providers.length === 0
                ? 'no providers available'
                : value.providers.map((p) => p.id + (p.name === p.id ? '' : ' (' + p.name + ')')).join(', ')
            break
          case 'models':
            text =
              value.models.length === 0
                ? 'no models under provider ' + value.provider
                : value.models.map((m) => m.id + (m.name === m.id ? '' : ' (' + m.name + ')')).join(', ')
            break
          case 'reasoning': {
            const effortList =
              value.efforts.length === 0
                ? 'no reasoning efforts'
                : value.efforts.map((e) => e.id + (e.name === e.id ? '' : ' (' + e.name + ')')).join(', ')
            text =
              value.provider +
              '/' +
              value.model +
              ': efforts=[' +
              effortList +
              '] default=' +
              (value.defaultEffort ?? '(none)')
            break
          }
        }
        return [{ type: 'text', text }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: LlmInfoToolArgs) {
      const validation = validateLlmInfoArgs(args)
      if (validation !== undefined) throw new Error(validation)

      const llm = getLlmInfoService(ctx)
      if (llm === undefined) {
        // Tolerate missing service: return the same shape with empty arrays.
        if (args.action === 'list_providers') return emptyProviders()
        if (args.action === 'list_models') return emptyModels(args.provider ?? '')
        return emptyReasoning(args.provider ?? '', args.model ?? '')
      }

      ctx.logger?.info?.(
        '[' + LLM_INFO_TOOL_PREFIX + '] action=' + args.action + ' provider=' + (args.provider ?? '') + ' model=' + (args.model ?? ''),
      )

      if (args.action === 'list_providers') {
        const providers = llm.listProviders().map(toProviderEntry)
        return { kind: 'providers' as const, providers }
      }

      if (args.action === 'list_models') {
        const provider = args.provider as string
        const models = (await llm.listModels(provider)).map(toModelEntry)
        return { kind: 'models' as const, provider, models }
      }

      const provider = args.provider as string
      const model = args.model as string
      const resolved = await llm.resolveModelInfo(provider, model)
      const efforts = (resolved.reasoning?.efforts ?? []).map(toEffortEntry)
      const reasoning = resolved.reasoning
      return {
        kind: 'reasoning' as const,
        provider,
        model,
        efforts,
        ...(reasoning?.defaultEffort !== undefined ? { defaultEffort: reasoning.defaultEffort } : {}),
      }
    },
  })
  // Cast the strict defineTool return to a structural unknown so the caller
  // (ctx.tools.register) accepts it without a schema mismatch.
  return tool as unknown as never
}
