/**
 * HUD-style toggle button — replaces the monitor's sidebar text button.
 *
 * - Slot: `conversation.input.left` (next to the composer; HUD-style placement).
 * - 28x28 icon button with linear SVG icon (subagent tree/branch motif).
 * - `.is-open` activates warn-yellow background when the panel is open.
 * - Badge in the top-right corner shows running subagent count (HUD-compat).
 * - Title attribute describes current state for accessibility / tooltip.
 */
import { useEffect, type ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import { dispatch, ensurePolling, useStore } from './store'

type ToggleProps = PropsRuntime<'root'>

/** Lucide `bot` icon — AI 聊天机器人. Path data from lucide.dev (24×24 viewBox). */
function SubagentIcon(): ReactElement {
  return (
    <svg
      className="dsp-toggle-icon"
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 8V4H8" />
      <rect width="16" height="12" x="4" y="8" rx="2" />
      <path d="M2 14h2" />
      <path d="M20 14h2" />
      <path d="M15 13v2" />
      <path d="M9 13v2" />
    </svg>
  )
}

export function Toggle(props: ToggleProps): ReactElement {
  const store = useStore()
  const current = props.useSessions((select: { current: unknown }) => select.current) as
    | string
    | undefined

  // Bind to current session — kicks off polling when set.
  useEffect(() => {
    if (current === undefined) return
    if (current !== store.sessionId) {
      dispatch({ sessionId: current })
    }
    ensurePolling(current)
  }, [current])

  const running = store.rows.filter((row) => row.status === 'running').length
  const title =
    '子代理面板' +
    (store.open ? '（已打开）' : '') +
    (running > 0 ? ' · 运行中 ' + running : '')

  return (
    <button
      type="button"
      className={'dsp-toggle' + (store.open ? ' is-open' : '')}
      onClick={() => dispatch({ open: !store.open })}
      title={title}
      aria-label={title}
      aria-pressed={store.open}
    >
      <SubagentIcon />
      {running > 0 ? <span className="dsp-badge">{running}</span> : null}
    </button>
  )
}
