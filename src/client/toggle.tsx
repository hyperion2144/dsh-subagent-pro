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

import { autoOpenIfDesktop, dispatch, ensurePolling, useStore } from './store'

type ToggleProps = PropsRuntime<'root'>

/** Linear SVG icon: a subagent "tree of forks" — root node with two children. */
function SubagentIcon(): ReactElement {
  return (
    <svg
      className="dsp-toggle-icon"
      width={14}
      height={14}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx={4} cy={3.5} r={1.4} />
      <circle cx={4} cy={12.5} r={1.4} />
      <circle cx={12} cy={8} r={1.4} />
      <path d="M4 4.9 V11.1" />
      <path d="M4 8 H10.6" />
      <path d="M5 5.5 C 7 5.5 9 7 10.6 7.3" />
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
    autoOpenIfDesktop()
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
