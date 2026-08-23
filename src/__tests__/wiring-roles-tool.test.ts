import test from 'node:test'
import assert from 'node:assert/strict'

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

/**
 * Real-wiring test for the md→tool pipeline:
 *
 *   index.ts reloadMd() → loadAgentMdRolesAcrossWorkspaces(ctx, ...)
 *     → resolved.setMdRoles(...) → getRoles() → subagent_roles tool execute()
 *
 * Mounts the ACTUAL plugin `apply()` on a minimal mock ctx, captures the
 * registered `subagent_roles` tool object, and drives its execute() — proving
 * the agent-facing tool surfaces md roles from registered workspaces, not
 * just the shell cwd. Regression guard for the cwd-only-scan bug.
 */

interface CapturedTool {
  name: string
  execute(args: unknown): Promise<unknown>
}

function buildMockCtx(options: {
  workspacePaths: string[]
  shellCwd?: string
  /** Registry visible via ctx.get from the start. Default true. */
  registryAvailable?: boolean
}): { ctx: Record<string, unknown>; tools: CapturedTool[] } {
  const tools: CapturedTool[] = []
  const logger = {
    info: () => undefined,
    warn: () => undefined,
    debug: () => undefined,
    error: () => undefined,
  }
  // Faithful to the cordis store semantics the plugin relies on: services are
  // read through ctx.get(name) WITHOUT an inject requirement, and an absent
  // service yields undefined — NOT a thrown "without inject" error. Direct
  // property access (ctx.workspaceRegistry) is intentionally NOT provided,
  // exactly like a host entry that never declares it in `inject`.
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  const registryState: {
    available: boolean
    list: () => { path: string }[]
  } = {
    available: options.registryAvailable ?? true,
    list: () => options.workspacePaths.map((path) => ({ path })),
  }
  const ctx: Record<string, unknown> = {
    logger,
    tools: {
      register: (tool: unknown) => {
        const t = tool as unknown as CapturedTool
        if (typeof t?.name === 'string' && typeof t.execute === 'function') {
          tools.push(t)
        }
        return () => undefined
      },
    },
    subagents: {
      getProvider: () => undefined,
      listDescendants: async () => [] as unknown[],
    },
    sessions: {
      get: () => undefined,
    },
    webServer: {
      register: () => undefined,
    },
    on: (event: string, listener: (...args: unknown[]) => void) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => undefined
    },
    effect: () => () => undefined,
    events: { dispatch: () => [] as unknown[] },
    get: (name: string) => {
      if (name === 'workspaceRegistry') return registryState.available ? registryState : undefined
      if (name === 'shell') return options.shellCwd !== undefined ? { cwd: options.shellCwd } : undefined
      return undefined
    },
    // Exposed for tests to simulate the registry appearing later.
    __registry: registryState,
    __listeners: listeners,
  }
  return { ctx, tools }
}

const ROLE_FM = (name: string, desc: string): string =>
  '---\nname: ' + name + '\ndescription: ' + desc + '\n---\n'

function writeRoleMd(dir: string, id: string, body: string): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, id + '.md'), body)
}

test('wiring: subagent_roles surfaces md roles from registered workspaces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-pro-wiring-'))
  try {
    const wsA = join(root, 'wsA')
    const wsB = join(root, 'wsB')
    writeRoleMd(join(wsA, '.dsh', 'agents'), 'code-reviewer', ROLE_FM('Code Reviewer', 'strict reviews'))
    writeRoleMd(join(wsB, '.dsh', 'agents'), 'bp-scanner', ROLE_FM('BP Scanner', 'scan contracts'))

    const { ctx, tools } = buildMockCtx({ workspacePaths: [wsA, wsB] })
    apply(ctx as never, {})

    const rolesTool = tools.find((t) => t.name === 'subagent_roles')
    assert.ok(rolesTool !== undefined, 'subagent_roles tool was registered')

    const result = (await rolesTool!.execute({})) as { kind: string; roles: Array<{ id: string; source: string }> }
    assert.equal(result.kind, 'roles')
    const ids = result.roles.map((r) => r.id).sort()
    assert.deepEqual(ids, ['bp-scanner', 'code-reviewer'], 'md roles from every workspace are listed')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('wiring: subagent_roles falls back to shell cwd when no workspace registry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-pro-wiring-cwd-'))
  try {
    // workspaceRegistry.list throws (simulates headless smoke) → the loader
    // must fall back to the shell cwd's .dsh/agents.
    const cwd = join(root, 'cwd-proj')
    writeRoleMd(join(cwd, '.dsh', 'agents'), 'cwd-role', ROLE_FM('Cwd Role', 'from cwd'))

    const { ctx, tools } = buildMockCtx({ workspacePaths: [], shellCwd: cwd })
    // workspaceRegistry list throws (simulates headless smoke) → the loader
    // must fall back to the shell cwd's .dsh/agents.
    ;(ctx.__registry as { list: () => never }).list = () => {
      throw new Error('no registry')
    }

    apply(ctx as never, {})

    const rolesTool = tools.find((t) => t.name === 'subagent_roles')
    assert.ok(rolesTool !== undefined)
    const result = (await rolesTool!.execute({})) as { roles: Array<{ id: string }> }
    assert.deepEqual(
      result.roles.map((r) => r.id),
      ['cwd-role'],
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('wiring: only subagent_roles uses file roles when cwd has none and no workspaces', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-pro-wiring-empty-'))
  try {
    const { ctx, tools } = buildMockCtx({ workspacePaths: [], shellCwd: join(root, 'no-agents') })
    apply(ctx as never, {})
    const rolesTool = tools.find((t) => t.name === 'subagent_roles')
    assert.ok(rolesTool !== undefined)
    const result = (await rolesTool!.execute({})) as { roles: unknown[] }
    assert.deepEqual(result.roles, [])
    // sanity: no stray temp dirs left inside the tmp root
    assert.equal(existsSync(join(root, 'no-agents', '.dsh')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('wiring: internal/service(workspaceRegistry) triggers md rescan for late registry', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-pro-wiring-late-'))
  try {
    const wsA = join(root, 'wsA')
    writeRoleMd(join(wsA, '.dsh', 'agents'), 'late-role', ROLE_FM('Late Role', 'appears after boot'))

    // The registry is NOT available at apply() time — mirrors dsh-workspace's
    // async Service.init bootstrap. subagent_roles must be empty at first…
    const { ctx, tools } = buildMockCtx({ workspacePaths: [wsA], registryAvailable: false })
    apply(ctx as never, {})

    const rolesTool = tools.find((t) => t.name === 'subagent_roles')
    assert.ok(rolesTool !== undefined)
    const before = (await rolesTool!.execute({})) as { roles: unknown[] }
    assert.deepEqual(before.roles, [], 'registry not ready at apply → no roles yet')

    // …then cordis emits internal/service when the registry activates. The
    // host entry listens and re-scans the md layer — roles must appear now.
    const registryState = ctx.__registry as { available: boolean }
    registryState.available = true
    const listeners = ctx.__listeners as Map<string, Array<(name: string) => void>>
    for (const listener of listeners.get('internal/service') ?? []) listener('workspaceRegistry')

    const after = (await rolesTool!.execute({})) as { roles: Array<{ id: string }> }
    assert.deepEqual(
      after.roles.map((r) => r.id),
      ['late-role'],
      'late registry triggers rescan → md roles appear without restart',
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})