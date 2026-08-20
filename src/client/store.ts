/**
 * Page-local store — shared state between Toggle, Panel, and RoleEditor.
 *
 * Single source of truth per page; useSyncExternalStore delivers reliable
 * re-renders without prop drilling. Mirrors the monitor + HUD pattern: one
 * `state` object, `commit(patch)` immutably updates it, listeners fire on every
 * commit.
 *
 * Services the panel needs (sessions.open / openSubagent, roles.describe /
 * mutate) are injected loosely from the host runtime; missing services are
 * tolerated (the panel falls back to read-only behavior).
 */
import {
  useSyncExternalStore,
  type Dispatch,
} from 'react'

// ---- row shape (mirror of host MonitorRow) ----

export interface MonitorRow {
  id: string
  label?: string
  mode?: string
  depth?: number
  parentId?: string
  runId?: string
  provider?: string
  local?: boolean
  startedAt?: number
  endedAt?: number
  status: string
  sortKey?: number
}

export interface SnapshotPayload {
  sessionId?: string
  now?: number
  rows?: MonitorRow[]
}

// ---- page-local state ----

export interface StoreState {
  sessionId: string | undefined
  now: number
  rows: MonitorRow[]
  open: boolean
  minimized: boolean
  hidden: string[]
  /** Last fetch error (for footer display). */
  lastError: string | undefined
}

const listeners = new Set<() => void>()
let state: StoreState = {
  sessionId: undefined,
  now: Date.now(),
  rows: [],
  open: false,
  minimized: false,
  hidden: [],
  lastError: undefined,
}
let autoOpened = false
let polling = false

const commit = (patch: Partial<StoreState>): void => {
  state = { ...state, ...patch }
  for (const listener of [...listeners]) listener()
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

const getSnapshot = (): StoreState => state

export const useStore = (): StoreState => useSyncExternalStore(subscribe, getSnapshot)

/** Imperative commit; components call this from effects and handlers. */
export const dispatch = (patch: Partial<StoreState>): void => commit(patch)

/** React-style setter for ergonomics. */
export const useDispatch = (): Dispatch<Partial<StoreState>> => commit

// ---- snapshot polling ----

async function refreshSnapshot(sessionId: string): Promise<void> {
  try {
    const res = await fetch('/api/dsh-subagent-pro/snapshot?sessionId=' + encodeURIComponent(sessionId))
    const data = (await res.json()) as SnapshotPayload
    if (data.sessionId !== state.sessionId) return
    commit({ rows: data.rows ?? [], now: data.now ?? Date.now(), lastError: undefined })
  } catch (err) {
    commit({ lastError: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Start polling for the given sessionId. Idempotent: a single 1-second interval
 * runs per page, regardless of how many components call this.
 */
export function ensurePolling(sessionId: string): void {
  if (state.sessionId !== sessionId) commit({ sessionId })
  if (polling) return
  polling = true
  void refreshSnapshot(sessionId)
  const timer = window.setInterval(() => {
    const sid = state.sessionId
    if (sid !== undefined) void refreshSnapshot(sid)
  }, 1000)
  // Store the timer for disposal — module-scoped cleanup.
  pollDisposer = (): void => {
    window.clearInterval(timer)
    polling = false
  }
}

let pollDisposer: (() => void) | undefined
export function stopPolling(): void {
  if (pollDisposer !== undefined) pollDisposer()
  pollDisposer = undefined
}

/** Open the panel automatically on first mount (desktop only). */
export function autoOpenIfDesktop(): void {
  if (autoOpened) return
  autoOpened = true
  if (!window.matchMedia('(max-width: 768px)').matches) commit({ open: true })
}

// ---- services injected from host runtime ----

export interface SessionsService {
  open(id: string): void
  openSubagent(address: { parentSessionId: string; childSessionId: string; mode: string }): void
}

export interface RolesService {
  describe(opts?: { redactSecrets?: boolean }): Array<{ ns: string; value: Record<string, unknown> }>
  mutate(ns: string, ops: ReadonlyArray<{ path: string; op: 'set' | 'unset'; value?: unknown }>, expectedRevision?: number): Promise<void>
}

let sessionsSvc: SessionsService | undefined
let rolesSvc: RolesService | undefined

export function setSessionsService(service: SessionsService | undefined): void {
  sessionsSvc = service
}
export function getSessionsService(): SessionsService | undefined {
  return sessionsSvc
}
export function setRolesService(service: RolesService | undefined): void {
  rolesSvc = service
}
export function getRolesService(): RolesService | undefined {
  return rolesSvc
}
