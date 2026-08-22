/**
 * Subagent run monitor (host half).
 *
 * Subscribes to subagent/start and subagent/end events globally, walks the
 * in-memory parent chain to attribute each run to its root session, and exposes
 * a merged view (event-driven rows + durable descendant catalog) at
 * /api/dsh-subagent-pro/snapshot for the browser panel.
 *
 * Design decisions inherited from @leetoners/dsh-ui-subagent-monitor (ARCH §2.3,
 * §2.4): events fire in the parent's scope, so the root-scoped observer must
 * use `{ global: true }` and walk parent sessions to find the top-level id; the
 * snapshot merges the catalog for durable label/mode/depth + free history
 * recovery after restart.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { foldRequestHeader } from '@deepseek-ai/dsh-session'
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'

import type { ResolvedSubagentProSettings } from './settings.js'

/** Custom event payload from delegation-tool with the resolved LLM route. */
export interface RunRouteInfo {
  /** Child session id (== `SubagentRun.id`, also == `SubagentRunInfo.id`). */
  childId: string
  provider?: string
  model?: string
  reasoningEffort?: string
}

/** Loose host logger surface for diagnostics. */
export interface MonitorLogger {
  debug?(message: string): void
  info?(message: string): void
  warn?(message: string): void
}

export interface MonitorRow {
  id: string
  label?: string
  mode?: string
  depth: number
  parentId?: string
  runId?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  local?: boolean
  startedAt?: number
  endedAt?: number
  status: string
  sortKey?: number
}

interface SnapshotPayload {
  sessionId?: string
  now: number
  rows: MonitorRow[]
}

interface RunRow {
  readonly runId: string
  readonly id: string
  // provider/model/reasoningEffort are mutable: `subagent/start` carries
  // only `provider`, and the resolved model + reasoningEffort arrive later
  // via the delegation tool's `dsh-subagent-pro/run-route` custom event.
  provider?: string
  model?: string
  reasoningEffort?: string
  readonly local: boolean
  readonly rootId: string
  readonly startedAt: number
  status: string
  endedAt?: number
}

const MAX_PER_ROOT = 200

/** Loose context shape — we only use a few services, not the full Context type. */
interface MonitorCtx {
  sessions: {
    get(id: SessionId): {
      header: { parentSession?: SessionId }
      id: SessionId
      /** Fold of the session's `request/header` events — has provider/model. */
      requestHeader(): {
        config?: { provider?: string; model?: string; reasoningEffort?: string }
      } | undefined
    } | undefined
  }
  subagents: { listDescendants(id: SessionId): Promise<Array<{
    id: SessionId | string
    kind: 'child' | 'root'
    label?: string
    mode?: string
    depth: number
    parentId?: SessionId | string
    activity?: 'running' | 'idle' | string
  }>> }
  webServer: {
    register(spec: { kind: 'exact'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void }): () => void
  }
  effect: <T>(fn: () => T, name?: string) => T
  on(event: 'subagent/start', listener: (info: SubagentRunInfo) => void, opts?: { global?: boolean }): void
  on(event: 'subagent/end', listener: (info: SubagentRunEndInfo) => void, opts?: { global?: boolean }): void
  on(
    event: 'dsh-subagent-pro/run-route',
    listener: (info: RunRouteInfo) => void,
    opts?: { global?: boolean },
  ): void
}

export function mountMonitor(ctxIn: Context, _resolved: ResolvedSubagentProSettings): void {
  // The host's Context carries services we use; cast to our narrow structural type.
  const ctx = ctxIn as unknown as MonitorCtx
  const logger = (ctxIn as unknown as { logger?: MonitorLogger }).logger
  const runs = new Map<string, RunRow>()
  const str = (value: unknown): string => (typeof value === 'string' ? value : String(value))

  /**
   * Resolve the model for one session id from its OWN persisted event log —
   * `request/header` events are appended on every LLM request and fold into
   * `EpochHeader.config { provider, model, reasoningEffort }`. This works for
   * ANY session state:
   *
   *   1. live (running / just ended in this process): `session.requestHeader()`
   *      — incremental fold over the in-memory log, O(new events).
   *   2. cold (ended in a previous process / host restart): a bounded
   *      persistence inspection (`inspectApiRemoteSession`) then
   *      `foldRequestHeader(events)` — the same detached-recipe the
   *      dsh-subagent listing / api-proxy cold resume use, without the
   *      `hasApiRemoteSubagentOwner` fence that makes `apiProxy.sessions.models`
   *      reject subagent-owned sessions.
   *
   * No custom persistence — everything is read from the session's durable log.
   * Returns undefined when the session never made a request (no header yet).
   */
  const sessionModel = async (sessionId: string): Promise<
    { provider?: string; model?: string; reasoningEffort?: string } | undefined
  > => {
    const extract = (
      config: { provider?: string; model?: string; reasoningEffort?: string } | undefined,
    ): { provider?: string; model?: string; reasoningEffort?: string } | undefined => {
      if (config === undefined || typeof config.model !== 'string' || config.model === '') {
        return undefined
      }
      return {
        ...(typeof config.provider === 'string' && config.provider !== ''
          ? { provider: config.provider }
          : {}),
        model: config.model,
        ...(typeof config.reasoningEffort === 'string' && config.reasoningEffort !== ''
          ? { reasoningEffort: config.reasoningEffort }
          : {}),
      }
    }

    // 1. live fast path — in-memory session's incremental header fold.
    let liveResult: string | undefined
    try {
      const live = ctx.sessions.get(sessionId as SessionId)
      const header = live?.requestHeader()
      liveResult = header?.config?.model
      const fromLive = extract(header?.config)
      if (fromLive !== undefined) return fromLive
    } catch (err) {
      logger?.debug?.('[dsh-subagent-pro] sessionModel live path failed: ' + String(err))
    }

    // 2. cold path — persisted log via the api-remotes inspection recipe
    //    (no subagent-ownership fence). Bounded single-session read.
    let coldResult: string | undefined
    let coldError: string | undefined
    try {
      const inspected = await inspectColdSession(sessionId)
      // The api-remotes inspection returns plain events; foldRequestHeader
      // accepts the full session-event vocabulary, so we trust the shape and
      // cast through unknown (the durable log validates envelope+payload at
      // write time).
      const header = foldRequestHeader(
        inspected.events as unknown as Parameters<typeof foldRequestHeader>[0],
      )
      coldResult = header?.config?.model
      const fromCold = extract(header?.config)
      if (fromCold !== undefined) return fromCold
    } catch (err) {
      coldError = err instanceof Error ? err.message : String(err)
    }
    logger?.debug?.(
      '[dsh-subagent-pro] sessionModel "' + sessionId.slice(0, 8) + '" live=' +
        JSON.stringify(liveResult ?? null) + ' cold=' + JSON.stringify(coldResult ?? null) +
        ' coldError=' + JSON.stringify(coldError ?? null),
    )
    return undefined
  }

  /**
   * Cold-inspect one session's durable log through the api-remotes recipe,
   * tolerating an absent persistence backend. The direct import stays in a
   * closure so the host bundle's import graph remains open to runtime
   * interop (the loader resolves @deepseek-ai/dsh-api-remotes from the host
   * tree, which ships it).
   */
  const inspectColdSession = async (sessionId: string): Promise<{ events: readonly unknown[] }> => {
    const apiRemotes = (await import('@deepseek-ai/dsh-api-remotes')) as {
      inspectApiRemoteSession(ctx: unknown, sessionId: string): Promise<{ events: readonly unknown[] }>
    }
    return apiRemotes.inspectApiRemoteSession(ctxIn, sessionId)
  }

  const rootOf = (childId: string): string | undefined => {
    let cur = ctx.sessions.get(childId as SessionId)
    let hops = 0
    while (cur !== undefined && hops < 32) {
      const pid = cur.header.parentSession
      if (pid === undefined) return str(cur.id)
      cur = ctx.sessions.get(pid)
      hops += 1
    }
    return undefined
  }

  const prune = (): void => {
    const counts = new Map<string, number>()
    for (const row of runs.values()) counts.set(row.rootId, (counts.get(row.rootId) ?? 0) + 1)
    for (const [rootId, count] of counts) {
      if (count <= MAX_PER_ROOT) continue
      let excess = count - MAX_PER_ROOT
      const rows = [...runs.values()]
        .filter((row) => row.rootId === rootId && row.status !== 'running')
        .sort((a, b) => a.startedAt - b.startedAt)
      for (const row of rows) {
        if (excess <= 0) break
        runs.delete(row.runId)
        excess -= 1
      }
    }
  }

  const onStart = (info: SubagentRunInfo): void => {
    const childId = str(info.id)
    const root = rootOf(childId)
    if (root === undefined) return
    runs.set(str(info.runId), {
      runId: str(info.runId),
      id: childId,
      provider: info.provider,
      local: info.local,
      rootId: root,
      startedAt: Date.now(),
      status: 'running',
    })
    prune()
  }

  // Custom event from the delegation tool — fires right after
  // `ctx.subagents.start(...)` resolves and carries the resolved
  // provider/model/reasoningEffort that the tool computed. We attach it to
  // the run row so the panel can show what model each subagent used, even
  // though the runtime's `subagent/start` event only carries `provider`.
  // The lookup key is the child session id (== `SubagentRun.id`) — the
  // runtime's internal `runId` is not exposed through `SubagentRun`.
  const onRunRoute = (info: RunRouteInfo): void => {
    const childId = str(info.childId)
    for (const row of runs.values()) {
      if (row.id !== childId) continue
      if (info.provider !== undefined) row.provider = info.provider
      if (info.model !== undefined) row.model = info.model
      if (info.reasoningEffort !== undefined) row.reasoningEffort = info.reasoningEffort
      return
    }
  }

  const onEnd = (info: SubagentRunEndInfo): void => {
    const row = runs.get(str(info.runId))
    if (row === undefined) return
    row.status = info.stopReason
    row.endedAt = Date.now()
  }

  ctx.on('subagent/start', onStart, { global: true })
  ctx.on('subagent/end', onEnd, { global: true })
  ctx.on('dsh-subagent-pro/run-route', onRunRoute, { global: true })

  const enrich = async (sessionId: string): Promise<MonitorRow[]> => {
    let desc: Awaited<ReturnType<typeof ctx.subagents.listDescendants>> = []
    try {
      desc = await ctx.subagents.listDescendants(sessionId as SessionId)
    } catch {
      desc = []
    }
    const eventRows: RunRow[] = []
    for (const row of runs.values()) {
      if (row.rootId === sessionId) eventRows.push({ ...row })
    }
    eventRows.sort((a, b) => a.startedAt - b.startedAt)
    // Resolve the model per child from its OWN persisted session log — works
    // for live AND cold children (restart survivors) because the events live
    // in the session store. The id set comes from the DESCENDANT CATALOG
    // (`desc`), not from the in-memory `eventRows`: after a host restart the
    // runs map is empty, so eventRows-only iteration would never query the
    // historical children. Failures degrade to no model chip.
    const modelByChild = new Map<string, { provider?: string; model?: string; reasoningEffort?: string }>()
    const catalogIds: string[] = []
    for (const entry of desc) {
      if (entry === undefined) continue
      if (entry.kind !== 'child') continue
      const id = str(entry.id)
      if (!catalogIds.includes(id)) catalogIds.push(id)
    }
    for (const id of catalogIds) {
      if (modelByChild.has(id)) continue
      const modelInfo = await sessionModel(id)
      if (modelInfo !== undefined) modelByChild.set(id, modelInfo)
    }
    const merged: MonitorRow[] = []
    const seen = new Set<string>()
    for (let index = 0; index < desc.length; index++) {
      const entry = desc[index]
      if (entry === undefined) continue
      const id = str(entry.id)
      seen.add(id)
      const base = {
        id,
        ...(entry.kind === 'child' && entry.label !== undefined ? { label: entry.label } : {}),
        ...(entry.kind === 'child' ? { mode: entry.mode } : {}),
        depth: entry.depth,
        parentId: str(entry.parentId),
      }
      const ev = eventRows.find((row) => row.id === id)
      const liveModel = modelByChild.get(id)
      const modelAttach =
        liveModel !== undefined
          ? {
              ...(liveModel.provider !== undefined ? { provider: liveModel.provider } : {}),
              ...(liveModel.model !== undefined ? { model: liveModel.model } : {}),
              ...(liveModel.reasoningEffort !== undefined
                ? { reasoningEffort: liveModel.reasoningEffort }
                : {}),
            }
          : {}
      if (ev !== undefined) {
        merged.push({ ...base, ...ev, ...modelAttach })
      } else {
        merged.push({
          ...base,
          ...modelAttach,
          local: true,
          sortKey: -(desc.length - index),
          status: entry.kind === 'child' && entry.activity === 'running' ? 'running' : 'unknown',
        })
      }
    }
    for (const ev of eventRows) {
      if (!seen.has(ev.id)) merged.push({ ...ev, depth: 0 })
    }
    merged.sort((a, b) => {
      const ka = a.startedAt ?? a.sortKey ?? Number.NEGATIVE_INFINITY
      const kb = b.startedAt ?? b.sortKey ?? Number.NEGATIVE_INFINITY
      return kb - ka
    })
    return merged
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/dsh-subagent-pro/snapshot',
        handler: async (req: IncomingMessage, res: ServerResponse) => {
          const url = new URL(req.url ?? '/', 'http://localhost')
          const sessionId = url.searchParams.get('sessionId')
          const payload: SnapshotPayload =
            sessionId === null
              ? { now: Date.now(), rows: [] }
              : { sessionId, now: Date.now(), rows: await enrich(sessionId) }
          res.writeHead(200, {
            'content-type': 'application/json',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify(payload))
        },
      }),
    'dsh-subagent-pro: snapshot route',
  )
}
