/**
 * Default route seam — makes settings.defaultProvider/defaultModel apply to ANY
 * subagent start that did not carry an explicit agentOptions, including starts
 * initiated by the built-in subagent / subagent_fork tools.
 *
 * Layering: explicit agentOptions (even partial) always wins; the seam is a
 * best-effort default. An un-routable default provider silently falls back to
 * inheritance (no throw).
 *
 * Inherited from dsh-plugin-subagent-director (default-route.ts); adapter is
 * typed loosely so host half can plug into the dsh-subagent service without
 * importing the full type tree.
 */
import type { AgentOptions } from '@deepseek-ai/dsh-agent'

export interface SeamResolveInput {
  agentOptions?: AgentOptions | undefined
  settings: { defaultProvider?: string; defaultModel?: string; fallbackOnInvalid?: boolean }
  isRoutable?: ((provider: string) => boolean) | undefined
}

function isEmpty(value: string | undefined): boolean {
  return value === undefined || value === ''
}

export function resolveSeamAgentOptions(input: SeamResolveInput): Pick<AgentOptions, 'provider' | 'model'> | undefined {
  const { agentOptions, settings, isRoutable } = input
  if (agentOptions !== undefined && (agentOptions.provider !== undefined || agentOptions.model !== undefined)) {
    return undefined
  }
  const provider = settings.defaultProvider
  const model = settings.defaultModel
  if (isEmpty(provider) || isEmpty(model)) return undefined
  if (isRoutable !== undefined && !isRoutable(provider!)) return undefined
  return { provider: provider!, model: model! }
}

export interface DefaultRouteSeamContext {
  get(name: string): unknown
  logger: { info(message: string): void; warn(message: string): void }
  subagents: {
    start: (name: string, request: Record<string, unknown>) => Promise<unknown>
    startContinuable: (spec: { request: Record<string, unknown> }) => Promise<unknown>
  }
}

export function applyDefaultRouteSeam(
  ctx: DefaultRouteSeamContext,
  getSettings: () => SeamResolveInput['settings'],
): () => void {
  const subagents = ctx.subagents
  const originalStart = subagents.start
  const originalStartContinuable = subagents.startContinuable
  const llm = ctx.get('llm') as { listProviders(): Array<{ id: string }> } | undefined
  const isRoutable =
    llm === undefined
      ? undefined
      : (provider: string) => llm.listProviders().some((entry) => entry.id === provider)

  const resolve = (request: { agentOptions?: AgentOptions | undefined }) =>
    resolveSeamAgentOptions({ agentOptions: request.agentOptions, settings: getSettings(), isRoutable })

  subagents.start = (name: string, request: Record<string, unknown>) => {
    const agentOptions = resolve(request as { agentOptions?: AgentOptions })
    if (agentOptions !== undefined) {
      ctx.logger.info(
        '[dsh-subagent-pro] default route seam: applying ' +
          agentOptions.provider +
          '/' +
          agentOptions.model +
          ' to ' +
          name +
          ' subagent',
      )
      return originalStart.call(subagents, name, { ...request, agentOptions })
    }
    return originalStart.call(subagents, name, request)
  }

  subagents.startContinuable = (spec: { request: Record<string, unknown> }) => {
    const agentOptions = resolve(spec.request as { agentOptions?: AgentOptions })
    if (agentOptions !== undefined) {
      ctx.logger.info(
        '[dsh-subagent-pro] default route seam: applying ' +
          agentOptions.provider +
          '/' +
          agentOptions.model +
          ' to continuable subagent',
      )
      return originalStartContinuable.call(subagents, { ...spec, request: { ...spec.request, agentOptions } })
    }
    return originalStartContinuable.call(subagents, spec)
  }

  return () => {
    subagents.start = originalStart
    subagents.startContinuable = originalStartContinuable
  }
}
