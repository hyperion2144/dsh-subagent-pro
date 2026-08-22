/**
 * Subagent Pro — floating panel.
 *
 * Ported from @leetoners/dsh-ui-subagent-monitor's panel.tsx (status dots,
 * drag/resize, hide rows, clear completed, open child session). The trigger
 * button is now the HUD-style icon button in conversation.input.left; this
 * panel only mounts in `shell.overlay`.
 */
import {
  useEffect,
  useRef,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import { dispatch, getSessionsService, useStore } from './store'
import type { MonitorRow } from './store'

// ---- status markers (mirror monitor's StateDot spec) ----

const CHASE_CELLS: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [4, 0], [8, 0], [8, 4], [8, 8], [4, 8], [0, 8], [0, 4],
]

interface StatusMeta {
  cls: string
  label: string
}

const UNKNOWN: StatusMeta = { cls: 'dsp-dot-off', label: '已结束' }

const STATUS: Record<string, StatusMeta> = {
  running: { cls: 'dsp-dot-running', label: '运行中' },
  completed: { cls: 'dsp-dot-ok', label: '完成' },
  error: { cls: 'dsp-dot-error', label: '失败' },
  aborted: { cls: 'dsp-dot-warn', label: '已打断' },
  'max-tokens': { cls: 'dsp-dot-warn', label: '令牌上限' },
  refusal: { cls: 'dsp-dot-warn', label: '已拒绝' },
}

function StatusDot({ status }: { status: string }): ReactElement {
  if (status === 'running') {
    return (
      <svg
        className="dsp-dot dsp-dot-running"
        width={10}
        height={10}
        viewBox="0 0 10 10"
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        {CHASE_CELLS.map(([x, y], index) => (
          <rect
            key={x + '-' + y}
            className="dsp-dot-cell"
            x={x}
            y={y}
            width="2"
            height="2"
            style={{ animationDelay: (index - CHASE_CELLS.length) * 125 + 'ms' }}
          />
        ))}
      </svg>
    )
  }
  const meta = STATUS[status] ?? UNKNOWN
  return <span className={'dsp-dot ' + meta.cls} aria-hidden="true" />
}

function fmtDuration(start: number | undefined, end: number | undefined): string {
  if (start === undefined) return '—'
  const ms = (end ?? Date.now()) - start
  if (ms < 0) return '00:00'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? h + ':' + pad(m) + ':' + pad(sec) : pad(m) + ':' + pad(sec)
}

const shortId = (id: string | undefined): string =>
  id === undefined || id.length <= 8 ? id ?? '—' : id.slice(0, 8)

function rowLabel(row: MonitorRow): string {
  if (typeof row.label === 'string' && row.label !== '') return row.label
  if (typeof row.provider === 'string' && row.provider !== '') return '[' + row.provider + '] 子代理'
  return '子代理 ' + shortId(row.id)
}

// ---- persisted layout (drag / resize survive reloads) ----

interface PanelLayout {
  left: number | null
  top: number | null
  height: number | null
}

const POSITION_KEY = 'dsh-subagent-pro.panel-position.v1'
const HEIGHT_KEY_PREFIX = 'dsh-subagent-pro.panel-height.v2.'
const DEFAULT_TOP = 80
const EDGE = 8
const MIN_HEIGHT = 160

const heights = new Map<string, number | null>()
let heightKey = ''
let layout: PanelLayout = { left: null, top: null, height: null }
let positionLoaded = false

function loadPosition(): void {
  if (positionLoaded) return
  positionLoaded = true
  try {
    const raw = window.localStorage.getItem(POSITION_KEY)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { left?: number; top?: number }
      if (typeof parsed.left === 'number' && Number.isFinite(parsed.left)) layout.left = parsed.left
      if (typeof parsed.top === 'number' && Number.isFinite(parsed.top)) layout.top = parsed.top
      if (layout.left === null || layout.top === null) {
        layout.left = null
        layout.top = null
      }
    }
  } catch {
    /* corrupt layout: keep defaults */
  }
}

function bindHeight(sessionId: string | undefined): void {
  const key = sessionId ?? '__global__'
  if (key === heightKey) return
  heightKey = key
  const cached = heights.get(key)
  if (cached !== undefined) {
    layout.height = cached
    clampLayout()
    return
  }
  let h: number | null = null
  try {
    const raw = window.localStorage.getItem(HEIGHT_KEY_PREFIX + key)
    if (raw !== null) {
      const parsed = JSON.parse(raw) as { height?: number }
      if (typeof parsed.height === 'number' && Number.isFinite(parsed.height)) h = parsed.height
    }
  } catch {
    /* corrupt height: keep default */
  }
  heights.set(key, h)
  layout.height = h
  clampLayout()
}

function savePosition(): void {
  try {
    window.localStorage.setItem(
      POSITION_KEY,
      JSON.stringify({ left: layout.left, top: layout.top }),
    )
  } catch {
    /* storage unavailable */
  }
}

function saveHeight(): void {
  try {
    window.localStorage.setItem(
      HEIGHT_KEY_PREFIX + heightKey,
      JSON.stringify({ height: layout.height }),
    )
  } catch {
    /* storage unavailable */
  }
}

function clampLayout(): void {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (layout.left !== null) {
    layout.left = Math.min(Math.max(EDGE, layout.left), Math.max(EDGE, vw - 60))
  }
  if (layout.top !== null) {
    layout.top = Math.min(Math.max(EDGE, layout.top), Math.max(EDGE, vh - 60))
  }
  if (layout.height !== null) {
    const top = layout.top ?? DEFAULT_TOP
    layout.height = Math.min(
      Math.max(MIN_HEIGHT, layout.height),
      Math.max(MIN_HEIGHT, vh - top - 16),
    )
  }
}

function applyLayoutStyle(el: HTMLElement, minimized = false): void {
  if (layout.left !== null && layout.top !== null) {
    el.style.left = layout.left + 'px'
    el.style.top = layout.top + 'px'
    el.style.right = 'auto'
  } else {
    el.style.left = 'auto'
    el.style.top = DEFAULT_TOP + 'px'
    el.style.right = '16px'
  }
  if (layout.height !== null && !minimized) {
    el.style.height = layout.height + 'px'
    el.style.maxHeight = 'none'
  } else {
    el.style.height = ''
    el.style.maxHeight = ''
  }
}

function layoutStyle(minimized = false): CSSProperties {
  const style: CSSProperties =
    layout.left !== null && layout.top !== null
      ? { left: layout.left + 'px', top: layout.top + 'px' }
      : { top: DEFAULT_TOP + 'px', right: '16px' }
  if (layout.height !== null && !minimized) {
    style.height = layout.height + 'px'
    style.maxHeight = 'none'
  }
  return style
}

// ---- panel ----

type PanelProps = PropsRuntime<'root'>

export function Panel(props: PanelProps): ReactElement | null {
  const store = useStore()
  const sessionsSvc = getSessionsService()

  // Detect whether the current session is itself a subagent — `currentAddress`
  // is the SubagentAddress the runtime set when we navigated into the child
  // session via `sessionsSvc.openSubagent(...)`. `parentSessionId` is the
  // session to jump back to.
  // (Mirrors dsh-subagent-monitor's pattern; the runtime selector exposes
  // `currentAddress.parentSessionId` but the type union doesn't list it, so
  // we cast through unknown.)
  const subagentParent = props.useSessions(
    (select: unknown) =>
      (select as { currentAddress?: { parentSessionId?: string } } | undefined)
        ?.currentAddress?.parentSessionId,
  ) as string | undefined

  const panelRef = useRef<HTMLDivElement | null>(null)
  const minimizedRef = useRef(store.minimized)
  minimizedRef.current = store.minimized

  useEffect(() => {
    clampLayout()
    const onResize = (): void => {
      clampLayout()
      if (panelRef.current !== null) applyLayoutStyle(panelRef.current, minimizedRef.current)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
    }
  }, [])

  useEffect(() => {
    if (panelRef.current !== null) applyLayoutStyle(panelRef.current, store.minimized)
  }, [store.minimized])

  if (!store.open) return null

  loadPosition()
  bindHeight(store.sessionId)

  const ordered = [...store.rows].sort((a, b) => {
    const ka = a.startedAt ?? a.sortKey ?? Number.NEGATIVE_INFINITY
    const kb = b.startedAt ?? b.sortKey ?? Number.NEGATIVE_INFINITY
    return kb - ka
  })
  const running = ordered.filter((row) => row.status === 'running').length
  const visible = ordered.filter((row) => !store.hidden.includes(row.id))
  const done = visible.filter((row) => row.status === 'completed').length
  const failed = visible.filter(
    (row) =>
      row.status === 'error' ||
      row.status === 'aborted' ||
      row.status === 'max-tokens' ||
      row.status === 'refusal',
  ).length
  const sessionId = store.sessionId
  const style = layoutStyle(store.minimized)

  const onMoveGripDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const el = panelRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const offX = event.clientX - rect.left
    const offY = event.clientY - rect.top
    const move = (ev: PointerEvent): void => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      layout.left = Math.min(Math.max(EDGE, ev.clientX - offX), Math.max(EDGE, vw - rect.width - EDGE))
      layout.top = Math.min(Math.max(EDGE, ev.clientY - offY), Math.max(EDGE, vh - 60))
      applyLayoutStyle(el, store.minimized)
    }
    const end = (): void => {
      savePosition()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const resetPosition = (): void => {
    layout.left = null
    layout.top = null
    savePosition()
    if (panelRef.current !== null) applyLayoutStyle(panelRef.current, store.minimized)
  }

  const onResizeGripDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return
    event.preventDefault()
    const el = panelRef.current
    if (el === null) return
    const rect = el.getBoundingClientRect()
    const startH = rect.height
    const startTop = rect.top
    const startY = event.clientY
    const move = (ev: PointerEvent): void => {
      const maxH = Math.max(MIN_HEIGHT, window.innerHeight - startTop - 16)
      layout.height = Math.min(
        Math.max(MIN_HEIGHT, startH + (ev.clientY - startY)),
        maxH,
      )
      applyLayoutStyle(el)
    }
    const end = (): void => {
      saveHeight()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', end)
      window.removeEventListener('pointercancel', end)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', end)
    window.addEventListener('pointercancel', end)
  }

  const resetHeight = (): void => {
    layout.height = null
    saveHeight()
    if (panelRef.current !== null) applyLayoutStyle(panelRef.current, store.minimized)
  }

  const openChild = (row: MonitorRow): void => {
    if (sessionsSvc === undefined || store.sessionId === undefined || row.mode === undefined) return
    sessionsSvc.openSubagent({
      parentSessionId: store.sessionId,
      childSessionId: row.id,
      mode: row.mode,
    })
  }

  const header = (
    <div className="dsp-panel-header">
      <div
        className="dsp-grip-v"
        title="拖动调整位置 · 双击复位"
        aria-hidden="true"
        onPointerDown={onMoveGripDown}
        onDoubleClick={resetPosition}
      >
        <svg className="dsp-grip-v-icon" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 0.8 7.3 3.6H4.7Z" />
          <path d="M6 11.2 4.7 8.4H7.3Z" />
          <path d="M0.8 6 3.6 4.7V7.3Z" />
          <path d="M11.2 6 8.4 4.7V7.3Z" />
        </svg>
      </div>
      <span className="dsp-panel-title">子代理面板</span>
      {running > 0 ? <span className="dsp-panel-running">{running}</span> : null}
      {subagentParent !== undefined && sessionsSvc !== undefined ? (
        <button
          className="dsp-btn dsp-back"
          type="button"
          title="返回主会话"
          onClick={() => sessionsSvc?.open(subagentParent)}
        >
          ← 主会话
        </button>
      ) : null}
      <span className="dsp-panel-spacer" />
      <button
        className="dsp-btn"
        type="button"
        title={store.minimized ? '展开面板' : '收起面板'}
        onClick={() => dispatch({ minimized: !store.minimized })}
      >
        {store.minimized ? '展开 ▾' : '收起 ▴'}
      </button>
      <button
        className="dsp-btn"
        type="button"
        title="关闭"
        onClick={() => dispatch({ open: false })}
      >
        ✕
      </button>
    </div>
  )

  if (store.minimized) {
    return (
      <div className="dsp-panel" style={style} ref={panelRef}>
        {header}
      </div>
    )
  }

  const rowsEl =
    visible.length === 0 ? (
      <div className="dsp-empty">
        {sessionId === undefined ? '尚未选择会话' : '本会话暂无子代理活动'}
      </div>
    ) : (
      <div className="dsp-rows">
        {visible.map((row) => {
          const meta = STATUS[row.status] ?? UNKNOWN
          const elapsed =
            row.status === 'running'
              ? fmtDuration(row.startedAt, store.now)
              : fmtDuration(row.startedAt, row.endedAt)
          const depth = typeof row.depth === 'number' ? row.depth : 1
          const indent = Math.max(0, depth - 1) * 14
          const modeText =
            row.mode === 'continuable' ? '连续对话' : row.mode === 'one-shot' ? '一次性' : ''
          // 模型信息整体（方案 A）：provider · model (+ reasoningEffort)
          // 都放进同一个 chip —— provider 和 model 属于同一信息单位，不该
          // 分家（provider 在 meta 行、model 在 chip 会割裂阅读）。
          // model 仍来自 host 侧 sessionModel（request/header 事件折叠），
          // chip 是独立元素，长 model id 不会被 meta 行 ellipsis 截断。
          const providerPart =
            row.provider !== undefined && row.provider !== '' ? row.provider : ''
          const modelPart =
            row.model !== undefined && row.model !== '' ? row.model : ''
          const effortPart =
            row.reasoningEffort !== undefined && row.reasoningEffort !== ''
              ? row.reasoningEffort
              : ''
          const modelChip =
            modelPart !== ''
              ? [providerPart, modelPart, effortPart].filter((s) => s !== '').join(' · ')
              : ''
          const metaLine = [modeText, shortId(row.id)]
            .filter((value) => typeof value === 'string' && value !== '')
            .join(' · ')
          return (
            <div key={row.id} className="dsp-row" style={{ marginLeft: indent }}>
              <div className="dsp-row-main">
                <StatusDot status={row.status} />
                <span className="dsp-row-label" title={rowLabel(row)}>
                  {rowLabel(row)}
                </span>
                {modelChip !== '' ? <span className="dsp-model-chip">{modelChip}</span> : null}
                {row.mode !== undefined && sessionsSvc !== undefined ? (
                  <button
                    className="dsp-btn dsp-row-open"
                    type="button"
                    onClick={() => openChild(row)}
                  >
                    打开对话
                  </button>
                ) : null}
              </div>
              <div className="dsp-row-foot">
                <span className="dsp-row-meta">{metaLine !== '' ? metaLine : '\u00A0'}</span>
                <span className="dsp-row-time">
                  {row.status === 'running'
                    ? elapsed + ' · ' + meta.label
                    : meta.label + ' · ' + elapsed}
                </span>
              </div>
            </div>
          )
        })}
      </div>
    )

  const footer = (
    <div className="dsp-panel-footer">
      <div className="dsp-panel-footer-stats">
        <span className="dsp-stat-chip dsp-stat-running">
          <span className="dsp-stat-num">{running}</span>
          <span className="dsp-stat-label">运行</span>
        </span>
        <span className="dsp-stat-chip dsp-stat-completed">
          <span className="dsp-stat-num">{done}</span>
          <span className="dsp-stat-label">完成</span>
        </span>
        <span className="dsp-stat-chip dsp-stat-failed">
          <span className="dsp-stat-num">{failed}</span>
          <span className="dsp-stat-label">异常</span>
        </span>
      </div>
      <div className="dsp-panel-footer-actions">
        {store.hidden.length > 0 ? (
          <button
            className="dsp-btn"
            type="button"
            onClick={() => dispatch({ hidden: [] })}
          >
            {'显示已隐藏 ' + store.hidden.length}
          </button>
        ) : null}
        <button
          className="dsp-btn"
          type="button"
          onClick={() => {
            const hidden = [...store.hidden]
            for (const row of store.rows) {
              if (row.status !== 'running' && !hidden.includes(row.id)) hidden.push(row.id)
            }
            dispatch({ hidden })
          }}
        >
          清空已完成
        </button>
      </div>
    </div>
  )

  return (
    <div className="dsp-panel" style={style} ref={panelRef}>
      {header}
      {rowsEl}
      {footer}
      <div
        className="dsp-grip-h"
        title="拖动调整高度 · 双击复位"
        aria-hidden="true"
        onPointerDown={onResizeGripDown}
        onDoubleClick={resetHeight}
      >
        <span className="dsp-grip-h-bar" />
      </div>
    </div>
  )
}
