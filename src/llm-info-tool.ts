/**
 * LLM info tool `subagent_providers` — model-facing tool that lets the agent
 * discover which LLM providers, models, and reasoning-effort levels are
 * routable through the host `llm` service, organized as a nested catalog:
 *
 *   subagent_providers()
 *     → all providers: [ { id, name, models: [ { id, name,
 *         reasoningEfforts: [ {id,name} ], defaultEffort? } ] } ]
 *   subagent_providers({ provider: "deepseek-official" })
 *     → only that provider's subtree (empty array if unknown)
 *   subagent_providers({ provider: "deepseek-official", model: "deepseek-v4-pro" })
 *     → only that model's leaf under the provider
 *
 * All parameters are OPTIONAL — no action enum. The catalog is resolved
 * lazily per call (listProviders → listModels → resolveModelInfo per model),
 * so a provider-scoped or model-scoped call skips the extra enumeration work.
 *
 * The tool tolerates a missing `llm` service: every call returns an empty
 * catalog rather than throwing, so removing the llm service mid-session does
 * not break open agent runs.
 */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const LLM_INFO_TOOL_PREFIX = 'dsh-subagent-pro'

const ERROR_PREFIX = 'dsh-subagent-pro:'

export interface LlmInfoToolArgs {
  /** Optional provider scope. Empty → all providers. */
  provider?: string
  /** Optional exact model scope under `provider`. Ignored when `provider` empty. */
  model?: string
}

export interface ReasoningEffortEntry {
  id: string
  name: string
}

export interface CatalogModel {
  id: string
  name: string
  /** Adapter-declared selectable reasoning levels, in adapter order. */
  reasoningEfforts: ReasoningEffortEntry[]
  /** Adapter-declared default effort, when one exists. */
  defaultEffort?: string
}

export interface CatalogProvider {
  id: string
  name: string
  /** Models under this provider, each carrying its own reasoning levels. */
  models: CatalogModel[]
}

export interface CatalogResult {
  kind: 'catalog'
  providers: CatalogProvider[]
}

export type AnyLlmInfoResult = CatalogResult

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

export function toProviderEntry(raw: { id: string; name?: string }): { id: string; name: string } {
  return { id: raw.id, name: raw.name ?? raw.id }
}

export function toModelEntry(raw: { id: string; name?: string }): { id: string; name: string } {
  return { id: raw.id, name: raw.name ?? raw.id }
}

export function toEffortEntry(raw: { id: string; name?: string }): ReasoningEffortEntry {
  return { id: raw.id, name: raw.name ?? raw.id }
}

/**
 * Validate the (now optional) params: a `model` without a `provider` is the
 * only invalid shape. No `provider`/`model` → full catalog (valid).
 */
export function validateLlmInfoArgs(args: { provider?: string; model?: string }): string | undefined {
  if (args.model !== undefined && args.model !== '' && (args.provider === undefined || args.provider === '')) {
    return ERROR_PREFIX + ' argument "model" requires a non-empty "provider" argument'
  }
  return undefined
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

/**
 * Build the nested catalog for one provider (or all providers when `provider`
 * is empty). When `model` is set, only that model's leaf is enumerated.
 * Provider-looking-up is best-effort: if the choose provider id isn't
 * registered, the array is empty (caller renders "no such provider").
 */
async function buildProviderCatalog(
  llm: LlmInfoService,
  scopedProvider: string | undefined,
  scopedModel: string | undefined,
): Promise<CatalogProvider[]> {
  const rawProviders = llm.listProviders()
  const providers = rawProviders
    .filter((p) => scopedProvider === undefined || p.id === scopedProvider)
    .map(toProviderEntry)

  const out: CatalogProvider[] = []
  for (const provider of providers) {
    let rawModels: Array<{ id: string; name?: string }> = []
    try {
      rawModels = await llm.listModels(provider.id)
    } catch {
      rawModels = []
    }
    const models = rawModels
      .filter((m) => scopedModel === undefined || m.id === scopedModel)
      .map(toModelEntry)

    const modelEntries: CatalogModel[] = []
    for (const model of models) {
      let efforts: ReasoningEffortEntry[] = []
      let defaultEffort: string | undefined
      try {
        const resolved = await llm.resolveModelInfo(provider.id, model.id)
        efforts = (resolved.reasoning?.efforts ?? []).map(toEffortEntry)
        defaultEffort = resolved.reasoning?.defaultEffort
      } catch {
        efforts = []
        defaultEffort = undefined
      }
      modelEntries.push({
        id: model.id,
        name: model.name,
        reasoningEfforts: efforts,
        ...(defaultEffort !== undefined ? { defaultEffort } : {}),
      })
    }
    out.push({ id: provider.id, name: provider.name, models: modelEntries })
  }
  return out
}

export function createLlmInfoTool(opts: CreateLlmInfoToolOptions): unknown {
  const { ctx } = opts
  const toolName = opts.toolName ?? 'subagent_providers'

  const tool = defineTool({
    name: toolName,
    description:
      'Discover routable LLM providers, models, and reasoning-effort levels, organized as a nested catalog: each provider contains its models, each model contains its supported reasoning efforts and the adapter default. ' +
      'All arguments are optional: call with no arguments to get every provider; pass `provider` to scope to that provider only; pass `provider` + `model` to get only that exact model leaf. ' +
      'Tolerates a missing `llm` service: returns an empty catalog rather than throwing.',
    parameters: {
      provider: {
        type: 'string',
        description: 'Optional provider id to scope the catalog to. Omit for all providers.',
      },
      model: {
        type: 'string',
        description: 'Optional exact model id to scope to (requires `provider`). Omit for all models under the provider(s).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, const: 'catalog' },
          providers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                name: { type: 'string', required: true },
                models: {
                  type: 'array',
                  required: true,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      id: { type: 'string', required: true },
                      name: { type: 'string', required: true },
                      reasoningEfforts: {
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
                },
              },
            },
          },
        },
      },
      render: (_args: LlmInfoToolArgs, value: AnyLlmInfoResult) => {
        const lines: string[] = []
        if (value.providers.length === 0) {
          lines.push('no providers available')
        }
        for (const p of value.providers) {
          lines.push(p.id + (p.name === p.id ? '' : ' (' + p.name + ')'))
          if (p.models.length === 0) {
            lines.push('  (no models)')
          }
          for (const m of p.models) {
            const effortText =
              m.reasoningEfforts.length === 0
                ? 'no reasoning efforts'
                : m.reasoningEfforts
                    .map((e) => e.id + (e.name === e.id ? '' : ' (' + e.name + ')'))
                    .join(', ')
            lines.push(
              '  ' + m.id + (m.name === m.id ? '' : ' (' + m.name + ')') +
                ': efforts=[' + effortText + '] default=' + (m.defaultEffort ?? '(none)'),
            )
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args: LlmInfoToolArgs): Promise<AnyLlmInfoResult> {
      const validation = validateLlmInfoArgs(args)
      if (validation !== undefined) throw new Error(validation)

      const provider = args.provider === '' ? undefined : args.provider
      const model = args.model === '' ? undefined : args.model

      const llm = getLlmInfoService(ctx)
      if (llm === undefined) {
        return { kind: 'catalog' as const, providers: [] }
      }

      ctx.logger?.info?.(
        '[' + LLM_INFO_TOOL_PREFIX + '] catalog scoped provider=' + (provider ?? '') + ' model=' + (model ?? ''),
      )

      return {
        kind: 'catalog' as const,
        providers: await buildProviderCatalog(llm, provider, model),
      }
    },
  })
  // Cast the strict defineTool return to a structural unknown so the caller
  // (ctx.tools.register) accepts it without a schema mismatch.
  return tool as unknown as never
}