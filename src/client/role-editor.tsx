/**
 * Role editor — settings.section slot.
 *
 * Shows three groups:
 *   - defaults (defaultProvider / defaultModel / defaultReasoningEffort /
 *     defaultRole)
 *   - md-sourced roles (project, global) — read-only cards showing displayName,
 *     description, provider/model binding, persona path.
 *   - settings.roles — editable cards (add / remove / edit / save through the
 *     dsh-settings seam).
 *
 * Settings write goes through RolesService.mutate (dsh-settings seam). The host
 * apply() listens to settings/change and re-broadcasts; this UI simply re-reads
 * the namespace on every mount and after each successful mutate.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import { getRolesService } from './store'

// ---- wire types (mirror host) ----

interface RoleTemplate {
  displayName: string
  description: string
  persona?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  toolFilter?: { allow?: string[]; deny?: string[] }
}

interface SubagentProSection {
  defaultProvider?: string
  defaultModel?: string
  defaultReasoningEffort?: string
  defaultRole?: string
  fallbackOnInvalid?: boolean
  roles?: Record<string, RoleTemplate>
}

// ---- helpers ----

const NS = 'subagent-pro'

function readSection(): SubagentProSection {
  const svc = getRolesService()
  if (svc === undefined) return {}
  try {
    const descriptors = svc.describe({ redactSecrets: true })
    for (const d of descriptors) {
      if (d.ns === NS) return (d.value as SubagentProSection) ?? {}
    }
  } catch {
    /* swallow */
  }
  return {}
}

// ---- main section ----

type Props = PropsRuntime<'root'>

export function RoleEditorSection(_props: Props): ReactElement {
  const svc = getRolesService()
  const [section, setSection] = useState<SubagentProSection>(() => readSection())
  const [savedFlag, setSavedFlag] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // Re-read on mount and on a window-level settings-changed event (host fires
    // settings/change; we re-read on visibility for safety).
    const refresh = (): void => setSection(readSection())
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [])

  const flashSaved = (key: string): void => {
    setSavedFlag((prev) => ({ ...prev, [key]: true }))
    window.setTimeout(() => {
      setSavedFlag((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }, 1500)
  }

  const updateField = async (path: string, value: unknown): Promise<void> => {
    if (svc === undefined) return
    setBusy(true)
    try {
      await svc.mutate(NS, [{ path, op: 'set', value }])
      flashSaved(path)
      setSection(readSection())
    } finally {
      setBusy(false)
    }
  }

  const addRole = async (): Promise<void> => {
    if (svc === undefined) return
    const id = 'role-' + Date.now().toString(36)
    const newRole: RoleTemplate = {
      displayName: '新角色',
      description: '请填写角色的职责描述',
    }
    setBusy(true)
    try {
      await svc.mutate(NS, [{ path: 'roles.' + id, op: 'set', value: newRole }])
      flashSaved('roles.' + id)
      setSection(readSection())
    } finally {
      setBusy(false)
    }
  }

  const removeRole = async (id: string): Promise<void> => {
    if (svc === undefined) return
    setBusy(true)
    try {
      await svc.mutate(NS, [{ path: 'roles.' + id, op: 'unset' }])
      flashSaved('roles.' + id)
      setSection(readSection())
    } finally {
      setBusy(false)
    }
  }

  const updateRoleField = async (
    id: string,
    field: keyof RoleTemplate,
    value: unknown,
  ): Promise<void> => {
    if (svc === undefined) return
    setBusy(true)
    try {
      await svc.mutate(NS, [
        { path: 'roles.' + id + '.' + field, op: 'set', value },
      ])
      flashSaved('roles.' + id + '.' + field)
      setSection(readSection())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dsp-section">
      <div className="dsp-section-header">
        Subagent Pro
        <span className="dsp-section-meta">
          {svc === undefined
            ? '（设置服务不可用，仅展示）'
            : busy
              ? '（保存中…）'
              : '（设置命名空间 subagent-pro）'}
        </span>
      </div>

      <DefaultCard section={section} onChange={updateField} saved={savedFlag} disabled={svc === undefined} />

      <RolesCard
        section={section}
        onAdd={addRole}
        onRemove={removeRole}
        onUpdate={updateRoleField}
        disabled={svc === undefined}
      />
    </div>
  )
}

// ---- defaults card ----

interface DefaultCardProps {
  section: SubagentProSection
  onChange(path: string, value: unknown): Promise<void>
  saved: Record<string, boolean>
  disabled: boolean
}

function DefaultCard({ section, onChange, saved, disabled }: DefaultCardProps): ReactElement {
  const fields: ReadonlyArray<{
    key: keyof SubagentProSection
    label: string
    placeholder: string
    type: 'text' | 'role-select'
  }> = [
    { key: 'defaultProvider', label: '默认 provider', placeholder: '例：deepseek-official', type: 'text' },
    { key: 'defaultModel', label: '默认 model', placeholder: '例：deepseek-chat', type: 'text' },
    { key: 'defaultReasoningEffort', label: '默认 reasoningEffort', placeholder: 'low / medium / high', type: 'text' },
    { key: 'defaultRole', label: '默认 role', placeholder: '（不设置）', type: 'role-select' },
  ]
  return (
    <div className="dsp-card">
      <div className="dsp-card-head">
        <span className="dsp-card-title">默认委派</span>
        <span className="dsp-card-source settings">settings</span>
      </div>
      {fields.map((f) => {
        const path = f.key
        const value = (section[f.key] as string | undefined) ?? ''
        const isSaved = saved[path] === true
        return (
          <div key={path} className="dsp-field-row">
            <label>{f.label}</label>
            {f.type === 'role-select' ? (
              <select
                value={value}
                disabled={disabled}
                onChange={(e) => {
                  void onChange(path, e.target.value === '' ? null : e.target.value)
                }}
              >
                <option value="">（不设置）</option>
                {Object.entries(section.roles ?? {}).map(([id, role]) => (
                  <option key={id} value={id}>
                    {id} — {role.displayName}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={value}
                placeholder={f.placeholder}
                disabled={disabled}
                onChange={(e) => {
                  void onChange(path, e.target.value === '' ? null : e.target.value)
                }}
              />
            )}
            {isSaved ? <span className="dsp-card-meta">已保存</span> : null}
          </div>
        )
      })}
    </div>
  )
}

// ---- roles card ----

interface RolesCardProps {
  section: SubagentProSection
  onAdd(): Promise<void>
  onRemove(id: string): Promise<void>
  onUpdate(id: string, field: keyof RoleTemplate, value: unknown): Promise<void>
  disabled: boolean
}

function RolesCard({ section, onAdd, onRemove, onUpdate, disabled }: RolesCardProps): ReactElement {
  const roleEntries = useMemo(() => {
    return Object.entries(section.roles ?? {}).filter(
      (entry): entry is [string, RoleTemplate] => entry[1] !== undefined,
    )
  }, [section.roles])

  return (
    <div className="dsp-card">
      <div className="dsp-card-head">
        <span className="dsp-card-title">角色（settings）</span>
        <span className="dsp-card-meta">
          agent md 角色请直接编辑 ~/.dsh/agents/*.md 或 .dsh/agents/*.md
        </span>
        <div className="dsp-card-actions">
          <button
            className="dsp-btn"
            type="button"
            disabled={disabled}
            onClick={() => {
              void onAdd()
            }}
          >
            + 新增角色
          </button>
        </div>
      </div>

      {roleEntries.length === 0 ? (
        <div className="dsp-card-meta">尚未配置任何 settings 角色；agent md 角色（项目/全局）会在主代理指引里出现。</div>
      ) : null}

      {roleEntries.map(([id, role]) => (
        <RoleCard
          key={id}
          id={id}
          role={role}
          onRemove={onRemove}
          onUpdate={onUpdate}
          disabled={disabled}
        />
      ))}
    </div>
  )
}

interface RoleCardProps {
  id: string
  role: RoleTemplate
  onRemove(id: string): Promise<void>
  onUpdate(id: string, field: keyof RoleTemplate, value: unknown): Promise<void>
  disabled: boolean
}

function RoleCard({ id, role, onRemove, onUpdate, disabled }: RoleCardProps): ReactElement {
  return (
    <div className="dsp-card" style={{ background: 'transparent' }}>
      <div className="dsp-card-head">
        <span className="dsp-card-title">{role.displayName || id}</span>
        <span className="dsp-card-source settings">{id}</span>
        <div className="dsp-card-actions">
          <button
            className="dsp-btn"
            type="button"
            disabled={disabled}
            onClick={() => {
              void onRemove(id)
            }}
          >
            删除
          </button>
        </div>
      </div>
      <div className="dsp-field-row">
        <label>displayName</label>
        <input
          type="text"
          value={role.displayName}
          disabled={disabled}
          onChange={(e) => {
            void onUpdate(id, 'displayName', e.target.value)
          }}
        />
      </div>
      <div className="dsp-field-row">
        <label>description</label>
        <textarea
          rows={2}
          value={role.description}
          disabled={disabled}
          onChange={(e) => {
            void onUpdate(id, 'description', e.target.value)
          }}
        />
      </div>
      <div className="dsp-field-row">
        <label>persona</label>
        <textarea
          rows={3}
          value={role.persona ?? ''}
          disabled={disabled}
          onChange={(e) => {
            void onUpdate(id, 'persona', e.target.value === '' ? null : e.target.value)
          }}
        />
      </div>
      <div className="dsp-field-row">
        <label>provider</label>
        <input
          type="text"
          value={role.provider ?? ''}
          placeholder="（继承）"
          disabled={disabled}
          onChange={(e) => {
            void onUpdate(id, 'provider', e.target.value === '' ? null : e.target.value)
          }}
        />
      </div>
      <div className="dsp-field-row">
        <label>model</label>
        <input
          type="text"
          value={role.model ?? ''}
          placeholder="（继承）"
          disabled={disabled}
          onChange={(e) => {
            void onUpdate(id, 'model', e.target.value === '' ? null : e.target.value)
          }}
        />
      </div>
      <div className="dsp-field-row">
        <label>tools (allow)</label>
        <input
          type="text"
          value={(role.toolFilter?.allow ?? []).join(' ')}
          placeholder="空格分隔，如：Read Grep Glob"
          disabled={disabled}
          onChange={(e) => {
            const allow = e.target.value
              .split(/\s+/)
              .map((s) => s.trim())
              .filter((s) => s !== '')
            void onUpdate(
              id,
              'toolFilter',
              allow.length === 0 ? null : { allow },
            )
          }}
        />
      </div>
    </div>
  )
}
