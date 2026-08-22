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
import type { SubagentRunEndInfo, SubagentRunInfo } from '@deepseek-ai/dsh-subagent'

import type { ResolvedSubagentProSettings } from './settings.js'

export interface MonitorRow {
  id: string
  label?: string
  mode?: string
  depth: number
  parentId?: string
  runId?: string
  provider?: string
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
  readonly provider?: string
  readonly local: boolean
  readonly rootId: string
  readonly startedAt: number
  status: string
  endedAt?: number
}

const MAX_PER_ROOT = 200

/** Loose context shape — we only use a few services, not the full Context type. */
interface MonitorCtx {
  sessions: { get(id: SessionId): { header: { parentSession?: SessionId } ; id: SessionId } | undefined }
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
}

export function mountMonitor(ctxIn: Context, _resolved: ResolvedSubagentProSettings): void {
  // The host's Context carries services we use; cast to our narrow structural type.
  const ctx = ctxIn as unknown as MonitorCtx
  const runs = new Map<string, RunRow>()
  const str = (value: unknown): string => (typeof value === 'string' ? value : String(value))

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

  const onEnd = (info: SubagentRunEndInfo): void => {
    const row = runs.get(str(info.runId))
    if (row === undefined) return
    row.status = info.stopReason
    row.endedAt = Date.now()
  }

  ctx.on('subagent/start', onStart, { global: true })
  ctx.on('subagent/end', onEnd, { global: true })

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
      if (ev !== undefined) {
        merged.push({ ...base, ...ev })
      } else {
        merged.push({
          ...base,
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

  // 注册 snapshot 路由——直接调用 ctx.webServer.register()（返回 disposer），
  // 不用 ctx.effect 包裹。cordis 4.x 的 fiber mixin 在某些插件激活时序下尚未就绪
  // （参见 refs/dsh-hud 的同款模式），导致 ctx.effect 偶发 undefined；直接调用更稳。
  // 路由仅在 webServer 服务可用时注册；插件整体不阻塞。
  if (ctx.webServer !== undefined) {
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
    })
  }
}
