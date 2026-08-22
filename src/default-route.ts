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
  events?: {
    dispatch(type: string, args: unknown[]): Array<(payload: unknown) => void>
  }
  subagents: {
    start: (name: string, request: Record<string, unknown>) => Promise<unknown>
    startContinuable: (spec: { request: Record<string, unknown> }) => Promise<unknown>
  }
}

/**
 * Dispatch the `dsh-subagent-pro/run-route` custom event (same plumbing as the
 * delegation tool) so the monitor panel can show which model a subagent used.
 * The runtime's `subagent/start` event only carries the transport provider
 * name, never the resolved LLM model.
 */
export function emitRunRoute(
  ctx: DefaultRouteSeamContext,
  payload: {
    childId: string
    provider?: string | undefined
    model?: string | undefined
    reasoningEffort?: string | undefined
  },
): void {
  const events = ctx.events
  if (events === undefined) return
  const callbacks = events.dispatch('emit', [
    'dsh-subagent-pro/run-route',
    payload,
  ]) as Array<(p: typeof payload) => void>
  for (const cb of callbacks) cb(payload)
}

/** Extract the child session id from the run handle any start path returns. */
function runChildId(run: unknown): string | undefined {
  if (typeof run !== 'object' || run === null) return undefined
  // `start` returns SubagentRun `{ id }`; `startContinuable` returns
  // ContinuableStart `{ childId }`.
  const id = (run as { id?: unknown }).id ?? (run as { childId?: unknown }).childId
  return id === undefined ? undefined : String(id)
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
      const run = originalStart.call(subagents, name, { ...request, agentOptions })
      // Surface the resolved route for the panel even though the built-in
      // subagent tools don't go through our delegation tool.
      void Promise.resolve(run).then((resolved) => {
        const childId = runChildId(resolved)
        if (childId !== undefined) {
          emitRunRoute(ctx, {
            childId,
            provider: agentOptions.provider,
            model: agentOptions.model,
          })
        }
      })
      return run
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
      const run = originalStartContinuable.call(subagents, { ...spec, request: { ...spec.request, agentOptions } })
      void Promise.resolve(run).then((resolved) => {
        const childId = runChildId(resolved)
        if (childId !== undefined) {
          emitRunRoute(ctx, {
            childId,
            provider: agentOptions.provider,
            model: agentOptions.model,
          })
        }
      })
      return run
    }
    return originalStartContinuable.call(subagents, spec)
  }

  return () => {
    subagents.start = originalStart
    subagents.startContinuable = originalStartContinuable
  }
}
