/**
 * Role-based subagent routing — delegation tool, default route seam, and
 * system-prompt guidance.
 */
import type { Context } from '@deepseek-ai/cordis'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'

import { applyDefaultRouteSeam } from './default-route.js'
import { createDelegationTool } from './delegation-tool.js'
import { applyGuidance } from './guidance.js'
import { createLlmInfoTool } from './llm-info-tool.js'
import type { SubagentProConfig } from './index-types.js'
import type { ResolvedSubagentProSettings } from './settings.js'
import type { AgentMdHandle } from './agents-md.js'

export function mountRoles(
  ctx: Context,
  config: SubagentProConfig,
  resolved: ResolvedSubagentProSettings,
  _agentMd?: AgentMdHandle,
): void {
  const backgroundMode = config.backgroundMode ?? 'one-shot'
  const toolName = config.toolName ?? 'subagent_role'
  const providerName = config.subagentProvider ?? 'spawn'

  if (config.applyDefaultRoute !== false) {
    const seamCtx = ctx as unknown as import('./default-route.js').DefaultRouteSeamContext
    ctx.effect(
      () =>
        applyDefaultRouteSeam(seamCtx, () => {
          const s = resolved.get()
          return {
            ...(s.defaultProvider !== undefined && s.defaultProvider !== ''
              ? { defaultProvider: s.defaultProvider }
              : {}),
            ...(s.defaultModel !== undefined && s.defaultModel !== ''
              ? { defaultModel: s.defaultModel }
              : {}),
            fallbackOnInvalid: s.fallbackOnInvalid === false ? false : true,
          }
        }),
      'dsh-subagent-pro: default-route-seam',
    )
  }

  applyGuidance(
    ctx as unknown as { get(name: string): unknown; logger?: { debug?: (m: string) => void } },
    () => resolved,
    toolName,
  )

  // LLM info tool — independent of the subagent transport provider; registers
  // once at apply time and never disposes. The tool tolerates a missing `llm`
  // service (returns empty arrays) so it is safe to mount unconditionally.
  const infoToolName = config.infoToolName ?? 'subagent_providers'
  if (config.enableLlmInfoTool !== false) {
    ctx.logger.info('[dsh-subagent-pro] registering ' + infoToolName + ' on host llm service')
    const infoTool = createLlmInfoTool({ ctx, toolName: infoToolName })
    const infoSvc = ctx.tools as unknown as { register: (t: typeof infoTool) => () => void }
    infoSvc.register(infoTool)
  }

  if (typeof config.maxDepth === 'number') assertSubagentMaxDepth(config.maxDepth)
  let disposeTool: (() => void) | undefined

  const mount = (provider: SubagentProvider): void => {
    if (typeof config.maxDepth === 'number' && !provider.capabilities.depthLimit) {
      throw new Error(
        'dsh-subagent-pro: provider "' +
          provider.name +
          '" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: "provider-managed"',
      )
    }
    if (backgroundMode === 'continuable' && provider.prepareContinuable === undefined) {
      throw new Error(
        'dsh-subagent-pro: provider "' +
          provider.name +
          '" does not support backgroundMode: continuable — switch the subagent provider or use backgroundMode: "one-shot"',
      )
    }
    ctx.logger.info(
      '[dsh-subagent-pro] registering ' +
        toolName +
        ' on subagent transport "' +
        providerName +
        '" with backgroundMode "' +
        backgroundMode +
        '"',
    )
    const tool = createDelegationTool({
      ctx,
      config,
      provider,
      getSettings: resolved.get,
      getRoles: resolved.getRoles,
    })
    const toolsSvc = ctx.tools as unknown as {
      register: (t: typeof tool) => () => void
    }
    disposeTool = toolsSvc.register(tool)
  }

  const cordisCtx = ctx as unknown as {
    on: <T>(event: string, listener: (arg: T) => void) => void
  }
  cordisCtx.on<SubagentProvider>('subagent/provider-added', (provider) => {
    if (provider.name === providerName && disposeTool === undefined) mount(provider)
  })
  cordisCtx.on<string>('subagent/provider-removed', (name2) => {
    if (name2 !== providerName || disposeTool === undefined) return
    disposeTool()
    disposeTool = undefined
  })

  const subagentsSvc = ctx.subagents as unknown as { getProvider(name: string): SubagentProvider | undefined }
  const present = subagentsSvc.getProvider(providerName)
  if (present !== undefined) mount(present)
  else
    ctx.logger.info(
      '[dsh-subagent-pro] subagent provider "' +
        providerName +
        '" not registered yet; the "' +
        toolName +
        '" tool will register when it appears',
    )
}
