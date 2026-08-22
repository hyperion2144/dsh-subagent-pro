/**
 * Subagent Pro — public types shared between host half modules.
 *
 * Pulled out of index.ts so monitor.ts / roles.ts / agents-md.ts can import
 * without circular dependency.
 */

export interface SubagentProConfig {
  /**
   * Subagent TRANSPORT provider to start runs on (e.g. 'spawn', 'fork', 'acp').
   * Not an LLM route. Default 'spawn'.
   */
  subagentProvider?: string
  /** Model-facing tool name. Default 'subagent_role'. */
  toolName?: string
  /**
   * Model-facing tool name for the LLM info tool that exposes available
   * providers / models / reasoning-effort levels to the agent. Default
   * 'subagent_providers'.
   */
  infoToolName?: string
  /** Register the LLM info tool. Default true. Set false to disable. */
  enableLlmInfoTool?: boolean
  /** Expose `run_in_background` (default true). */
  enableRunInBackground?: boolean
  /** Background execution policy: 'one-shot' (default) or 'continuable'. */
  backgroundMode?: 'one-shot' | 'continuable'
  /** Maximum child delegation depth. 'provider-managed' (default) leaves the cap to the provider. */
  maxDepth?: number | 'provider-managed'
  /** Apply settings defaultProvider/defaultModel to every subagent start without explicit agentOptions. Default true. */
  applyDefaultRoute?: boolean
  /** Override the global agent directory (<homedir>/.dsh/agents by default). */
  globalAgentDir?: string
  /** Override the project agent directory name under cwd (default '.dsh/agents'). */
  projectAgentDirName?: string
}

