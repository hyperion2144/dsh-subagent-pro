/**
 * Delegation tool `subagent_role` — model-facing tool that delegates a
 * self-contained task to a subagent while selecting an LLM route (provider /
 * model) and/or a named role template.
 *
 * Resolution chain (4 layers): call > role > default > inherit.
 * persona and toolFilter come ONLY from the role layer and flow into
 * SubagentStartRequest verbatim — the agent md personas reach the child here.
 *
 * Execution modes: foreground (default for one-shot), background (one-shot,
 * via ctx.jobs.start), continuable background (returns durable child id).
 *
 * Inherited from dsh-plugin-subagent-director (delegation-tool.ts).
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { settleRun } from '@deepseek-ai/dsh-subagent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentProvider, SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'

import type { SubagentProConfig } from './index-types.js'
import type { MergedRole } from './settings.js'
import { resolveRoute, type RouteToolFilter, type SubagentProSettings } from './route-resolver.js'

export const DELEGATION_TOOL_PREFIX = 'dsh-subagent-pro'

const ERROR_PREFIX = 'dsh-subagent-pro:'

export interface DelegationToolArgs {
  description: string
  prompt: string
  role?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  run_in_background?: boolean
}

export interface DelegationResult { kind: 'background'; jobId: string }
export interface ContinuableDelegationResult { kind: 'continuable'; subagentId: string }
export interface ForegroundDelegationResult { kind: 'foreground'; runId: string; output: Array<string | number | boolean | null | { [k: string]: JsonValue } | JsonValue[]> }
type JsonValue = string | number | boolean | null | { [k: string]: JsonValue } | JsonValue[]
export type AnyDelegationResult = DelegationResult | ContinuableDelegationResult | ForegroundDelegationResult

function isEmpty(value: string | undefined | null): boolean {
  return value === undefined || value === null || value === ''
}

function stopReasonError(result: SubagentResult): string | undefined {
  switch (result.stopReason) {
    case 'completed':
      return undefined
    case 'aborted':
      return 'subagent run was cancelled'
    case 'error':
      return 'subagent run failed'
    case 'max-tokens':
      return 'subagent run hit its token limit before finishing'
    case 'refusal':
      return 'subagent declined the task'
    default:
      return 'subagent run ended abnormally (' + String(result.stopReason) + ')'
  }
}

function withPartialText(error: string, output: readonly ContentBlock[]): string {
  const text = output
    .filter((block) => block.type === 'text')
    .map((block) => block.text as string)
    .join('')
  return text.length === 0 ? error : error + '\nPartial output before the run ended:\n' + text
}

async function settleForegroundRun(run: SubagentRun): Promise<ForegroundDelegationResult> {
  try {
    const result = await run.result
    const error = stopReasonError(result)
    if (error !== undefined) throw new Error(withPartialText(error, result.output))
    run.dispose()
    return {
      kind: 'foreground',
      runId: String(run.id),
      output: result.output as unknown as ForegroundDelegationResult['output'],
    }
  } catch (err) {
    run.dispose()
    throw err
  }
}

async function settleBackgroundRun(
  start: Promise<SubagentRun>,
  signal: AbortSignal,
): Promise<{ status: 'completed' } | { status: 'killed' } | { status: 'failed'; detail: string }> {
  try {
    const result = await settleRun(await start)
    return result as unknown as { status: 'completed' }
  } catch (error) {
    return signal.aborted
      ? { status: 'killed' }
      : { status: 'failed', detail: String(error) }
  }
}

function isProviderRoutable(ctx: Context, provider: string): boolean {
  const llm = ctx.get('llm') as { listProviders(): Array<{ id: string }> } | undefined
  if (llm === undefined) return true
  return llm.listProviders().some((entry) => entry.id === provider)
}

function invalidProviderError(provider: string, available: string[]): Error {
  const list = available.length > 0 ? available.join(', ') : '(none)'
  return new Error(
    ERROR_PREFIX +
      ' LLM provider route ' +
      provider +
      ' is not routable (no adapter serves it). Available providers: ' +
      list,
  )
}

export interface SubagentRequestParts {
  description: string
  prompt: ContentBlock[]
  parent: Agent
  agentOptions?: Pick<AgentOptions, 'provider' | 'model'> | undefined
  persona?: string | undefined
  toolFilter?: RouteToolFilter | undefined
  maxDepth?: number | undefined
}

export function buildSubagentRequest(parts: SubagentRequestParts): {
  label: string
  prompt: ContentBlock[]
  parent: Agent
  agentOptions?: Pick<AgentOptions, 'provider' | 'model'>
  persona?: string
  toolFilter?: RouteToolFilter
  maxDepth?: number
} {
  return {
    label: parts.description,
    prompt: parts.prompt,
    parent: parts.parent,
    ...(parts.agentOptions !== undefined ? { agentOptions: parts.agentOptions } : {}),
    ...(parts.persona !== undefined ? { persona: parts.persona } : {}),
    ...(parts.toolFilter !== undefined ? { toolFilter: parts.toolFilter } : {}),
    ...(parts.maxDepth !== undefined ? { maxDepth: parts.maxDepth } : {}),
  }
}

export interface CreateDelegationToolOptions {
  ctx: Context
  config: SubagentProConfig
  provider: SubagentProvider
  getSettings: () => SubagentProSettings
  getRoles: () => MergedRole[]
}

/** Strip .md suffix from a file basename (path string ops only). */
function roleFileId(filePath: string): string {
  let last = 0
  for (let i = filePath.length - 1; i >= 0; i--) {
    const ch = filePath.charCodeAt(i)
    if (ch === 47 || ch === 92) {
      last = i + 1
      break
    }
  }
  const base = filePath.slice(last)
  return base.endsWith('.md') ? base.slice(0, -3) : base
}

export function createDelegationTool(opts: CreateDelegationToolOptions): unknown {
  const { ctx, config, provider, getSettings, getRoles } = opts
  const backgroundEnabled = config.enableRunInBackground !== false
  const continuable = (config.backgroundMode ?? 'one-shot') === 'continuable'
  const toolName = config.toolName ?? 'subagent_role'
  const providerName = config.subagentProvider ?? 'spawn'

  const lookup = {
    byId: (id: string) => {
      for (const r of getRoles()) {
        if ((r.source === 'project-md' || r.source === 'global-md') && r.filePath !== undefined) {
          const rid = roleFileId(r.filePath)
          if (rid === id) return r
        }
      }
      const settings = getSettings().roles ?? {}
      return settings[id]
    },
    byDisplayName: (name: string) => {
      for (const r of getRoles()) {
        if (r.displayName !== name) continue
        if ((r.source === 'project-md' || r.source === 'global-md') && r.filePath !== undefined) {
          const rid = roleFileId(r.filePath)
          if (rid !== '') return { id: rid, role: r }
        } else {
          const settings = getSettings().roles ?? {}
          for (const [k, v] of Object.entries(settings)) {
            if (v?.displayName === name) return { id: k, role: r }
          }
        }
      }
      const settings = getSettings().roles ?? {}
      for (const [id, role] of Object.entries(settings)) {
        if (role?.displayName === name) return { id, role }
      }
      return undefined
    },
  }

  const tool = defineTool({
    name: toolName,
    description:
      'Delegate a self-contained task to a role-bound subagent with an optional LLM route (provider/model) override. ' +
      'Resolves the model through configure > role > default > inherit; role persona and tool filtering are applied when supported. ' +
      (backgroundEnabled
        ? continuable
          ? ' This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; send_message starts a later turn in the same child conversation. Set run_in_background: false only when your next action depends on receiving the result.'
          : ' This call waits for the result by default. Set run_in_background: true to return a job id; collect with job_output and stop with job_kill.'
        : ' This call waits for the subagent and returns its result.'),
    parameters: {
      description: {
        type: 'string',
        required: true,
        description: 'A short (3-5 word) description of the delegated task, for display.',
      },
      prompt: {
        type: 'string',
        required: true,
        description:
          "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs.",
      },
      role: {
        type: 'string',
        description: 'Role template id (optional). Falls back to the configured default role when unset.',
      },
      provider: {
        type: 'string',
        description:
          'LLM provider route override (optional). Explicit provider/model win over a role binding. Must match a route with a registered adapter.',
      },
      model: {
        type: 'string',
        description: 'Model id override (optional). Explicit provider/model win over a role binding.',
      },
      reasoningEffort: {
        type: 'string',
        description:
          'Reasoning-effort override (optional). Adapter serving the route decides support.',
      },
      ...(backgroundEnabled
        ? {
            run_in_background: {
              type: 'boolean',
              description: continuable
                ? 'Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it.'
                : 'Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill.',
            },
          }
        : {}),
    },
    output: {
      schema: {
        oneOf: [
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'background' }, jobId: { type: 'string', required: true } } },
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'continuable' }, subagentId: { type: 'string', required: true } } },
          { type: 'object', additionalProperties: false, properties: { kind: { type: 'string', required: true, const: 'foreground' }, runId: { type: 'string', required: true }, output: { type: 'array', required: true, items: { type: 'json' } } } },
        ],
      },
      render: (_args: unknown, value: AnyDelegationResult) => [
        {
          type: 'text',
          text:
            value.kind === 'background'
              ? 'started background ' + toolName + ' task ' + value.jobId
              : value.kind === 'continuable'
                ? 'started subagent ' + value.subagentId
                : (value.output as Array<{ type?: unknown; text?: unknown }>)
                    .filter((b) => typeof b === 'object' && b !== null && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
                    .map((b) => (b as { text: string }).text)
                    .join(''),
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args: DelegationToolArgs, exec: { agent?: Agent; signal: AbortSignal }) {
      const parent = exec.agent
      if (!parent) throw new Error(ERROR_PREFIX + ' tool requires a calling agent (exec.agent was undefined)')

      const settings = getSettings()
      const route = resolveRoute({ args, settings, parent: parent.options }, lookup)
      const warnings = [...route.warnings]
      // [DIAG] dump every input that affects route + reasoningEffort propagation
      ctx.logger.info(
        '[' + DELEGATION_TOOL_PREFIX + '] DIAG: parentOptions=' +
          JSON.stringify(parent.options) +
          ' settings=' + JSON.stringify(settings) +
          ' args.provider=' + JSON.stringify(args.provider) +
          ' args.model=' + JSON.stringify(args.model),
      )
      ctx.logger.info(
        '[' + DELEGATION_TOOL_PREFIX + '] delegate layer=' + route.layer + ' mode=' + (continuable ? 'continuable' : 'one-shot') + ' transport=' + providerName + ' route=' + JSON.stringify(route.agentOptions ?? null) + ' reasoningEffort=' + JSON.stringify(route.reasoningEffort) + ' persona=' + (route.persona ? 'yes' : 'no') + ' warnings=' + JSON.stringify(warnings),
      )

      const explicitProvider = isEmpty(args.provider) ? undefined : args.provider
      if (explicitProvider !== undefined && !isProviderRoutable(ctx, explicitProvider)) {
        const llm = ctx.get('llm') as { listProviders(): Array<{ id: string }> } | undefined
        const available = llm === undefined ? [] : llm.listProviders().map((e) => e.id)
        throw invalidProviderError(explicitProvider, available)
      }

      let agentOptions = route.agentOptions
      const routeProvider = agentOptions?.provider
      if (routeProvider !== undefined && explicitProvider === undefined && !isProviderRoutable(ctx, routeProvider)) {
        const fallBack = settings.fallbackOnInvalid !== false
        if (fallBack) {
          agentOptions = undefined
          warnings.push(ERROR_PREFIX + ' role/default provider ' + routeProvider + ' is not routable; fell back to the parent model (fallbackOnInvalid: true)')
          ctx.logger.warn('[' + DELEGATION_TOOL_PREFIX + '] fell back to parent model for un-routable provider ' + routeProvider)
        } else {
          const llm = ctx.get('llm') as { listProviders(): Array<{ id: string }> } | undefined
          const available = llm === undefined ? [] : llm.listProviders().map((e) => e.id)
          throw invalidProviderError(routeProvider, available)
        }
      }

      const maxDepth = typeof config.maxDepth === 'number' ? config.maxDepth : undefined
      if (route.persona !== undefined && !provider.capabilities.persona) {
        throw new Error(ERROR_PREFIX + ' role binds a persona but transport provider "' + providerName + '" does not support the persona capability — switch the subagent provider or drop the role persona')
      }
      if (route.toolFilter !== undefined && !provider.capabilities.toolFilter) {
        throw new Error(ERROR_PREFIX + ' role binds a tool filter but transport provider "' + providerName + '" does not support the toolFilter capability — switch the subagent provider or drop the role filter')
      }
      if (typeof maxDepth === 'number' && !provider.capabilities.depthLimit) {
        throw new Error(ERROR_PREFIX + ' transport provider "' + providerName + '" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: "provider-managed" to leave the recursion budget to the provider')
      }

      if (route.reasoningEffort !== undefined) {
        ctx.logger.info('[' + DELEGATION_TOOL_PREFIX + '] reasoningEffort=' + route.reasoningEffort + ' is advisory and logged only (not injectable via AgentOptions)')
      }

      const request = buildSubagentRequest({
        description: args.description,
        prompt: [{ type: 'text' as const, text: args.prompt }],
        parent,
        agentOptions,
        persona: route.persona,
        toolFilter: route.toolFilter,
        maxDepth,
      })

      const runInBackground = backgroundEnabled ? args.run_in_background ?? continuable : false

      // After resolving the route, emit `dsh-subagent-pro/run-route` with the
      // resolved provider/model/reasoningEffort so the monitor panel can show
      // what model each subagent actually used. The runtime's `subagent/start`
      // event only carries `provider`, so we round-trip the route through
      // cordis here. Fired for foreground + continuable + background — all
      // three start paths flow through here. The lookup key on the monitor
      // side is the child session id (== `SubagentRun.id`), the only handle
      // every start path actually exposes.
      //
      // IMPORTANT: the cordis events API lives on `ctx.events`, NOT on `ctx`
      // itself — `ctx.emit` is undefined. Verified by reading
      // @deepseek-ai/dsh-subagent/lib/index.js:173 which uses
      // `ctx.events.dispatch("emit", ...)`. The earlier `cordisEmit?.(...)`
      // pattern silently no-op'd because `(ctx as any).emit === undefined`.
      const ctxEvents = (ctx as unknown as {
        events?: { dispatch(type: string, args: unknown[]): unknown[] }
      }).events
      const emitRoute = (payload: {
        childId: string
        provider?: string | undefined
        model?: string | undefined
        reasoningEffort?: string | undefined
      }): void => {
        if (ctxEvents === undefined) return
        // dispatch("emit", [name, ...args]) — listeners receive the trailing
        // args as their positional parameters.
        const callbacks = ctxEvents.dispatch('emit', [
          'dsh-subagent-pro/run-route',
          payload,
        ]) as Array<(p: typeof payload) => void>
        for (const cb of callbacks) cb(payload)
      }
      const routeSnapshot = {
        childId: '',
        provider: route.agentOptions?.provider,
        model: route.agentOptions?.model,
        reasoningEffort: route.reasoningEffort,
      }

      if (runInBackground && continuable) {
        if (provider.prepareContinuable === undefined) {
          throw new Error(ERROR_PREFIX + ' transport provider "' + providerName + '" does not support backgroundMode: continuable — switch the subagent provider or use backgroundMode: "one-shot"')
        }
        const start = await ctx.subagents.startContinuable({ provider: providerName, label: args.description, request, signal: exec.signal })
        emitRoute({ ...routeSnapshot, childId: String(start.childId) })
        return { kind: 'continuable' as const, subagentId: start.childId }
      }

      if (runInBackground) {
        const jobs = ctx.get('jobs') as
          | { start: (spec: { kind: string; label: string; owner: Agent; run: () => { cancel: (reason?: string) => void; done: Promise<unknown> } }) => string }
          | undefined
        if (jobs === undefined) {
          throw new Error(ERROR_PREFIX + ' background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs')
        }
        return {
          kind: 'background' as const,
          jobId: jobs.start({
            kind: 'subagent',
            label: args.description,
            owner: parent,
            run: () => {
              const controller = new AbortController()
              return {
                cancel: (reason?: string) => controller.abort(reason ?? 'background subagent task killed'),
                done: (async () => {
                  const sub = await ctx.subagents.start(providerName, { ...request, signal: controller.signal })
                  emitRoute({ ...routeSnapshot, childId: String(sub.id) })
                  return settleBackgroundRun(Promise.resolve(sub), controller.signal)
                })(),
              }
            },
          }),
        }
      }

      const foregroundSub = await ctx.subagents.start(providerName, { ...request, signal: exec.signal })
      emitRoute({ ...routeSnapshot, childId: String(foregroundSub.id) })
      return settleForegroundRun(foregroundSub)
    },
  })
  // Cast the strict defineTool return to a structural unknown so the caller
  // (ctx.tools.register) accepts it without a schema mismatch.
  return tool as unknown as never
}
