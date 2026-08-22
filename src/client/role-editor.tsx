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
 * apply() listens to `settings/updated` and re-reads the source via the live
 * `installSettingsSection` getter; this UI simply re-reads the namespace on
 * every mount and after each successful mutate.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

import {
  getSettingsService,
  type FileRoleInfo,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmReasoningEffortInfo,
} from './store'

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

async function readSectionAsync(): Promise<{ section: SubagentProSection; revision: number }> {
  const svc = getSettingsService()
  if (svc === undefined) return { section: {}, revision: 0 }
  try {
    const { view, revision } = await svc.read()
    return { section: (view as SubagentProSection) ?? {}, revision }
  } catch {
    return { section: {}, revision: 0 }
  }
}

// ---- main section ----

type Props = PropsRuntime<'root'>

export function RoleEditorSection(_props: Props): ReactElement {
  const svc = getSettingsService()
  const [section, setSection] = useState<SubagentProSection>({})
  const [revision, setRevision] = useState(0)
  const [available, setAvailable] = useState(svc !== undefined)
  const [savedFlag, setSavedFlag] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState(false)

  const refresh = useMemo(
    () => async (): Promise<void> => {
      if (svc === undefined) return
      const { section: next, revision: rev } = await readSectionAsync()
      setSection(next)
      setRevision(rev)
      setAvailable(true)
    },
    [svc],
  )

  useEffect(() => {
    void refresh()
    const onFocus = (): void => {
      void refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
  }, [refresh])

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

  const doMutate = async (
    ops: ReadonlyArray<{ path: readonly string[]; op: 'set' | 'unset'; value?: unknown }>,
    flashKey: string,
  ): Promise<void> => {
    if (svc === undefined) return
    setBusy(true)
    try {
      const result = await svc.mutate(ops, revision)
      setSection((result.view as SubagentProSection) ?? {})
      setRevision(result.revision)
      flashSaved(flashKey)
    } catch (e) {
      // Conflict → re-read and show a brief error flag
      const msg = e instanceof Error ? e.message : String(e)
      // eslint-disable-next-line no-console
      console.error('[dsh-subagent-pro] settings mutate failed:', msg)
      // Re-read to recover from any drift
      try {
        const { section: next, revision: rev } = await readSectionAsync()
        setSection(next)
        setRevision(rev)
      } catch {
        /* ignore */
      }
    } finally {
      setBusy(false)
    }
  }

  const updateField = (path: ReadonlyArray<string>, value: unknown): Promise<void> =>
    doMutate([{ path, op: 'set', value }], path.join('.'))

  const addRole = async (): Promise<void> => {
    const id = 'role-' + Date.now().toString(36)
    const newRole: RoleTemplate = {
      displayName: '新角色',
      description: '请填写角色的职责描述',
    }
    await doMutate([{ path: ['roles', id], op: 'set', value: newRole }], 'roles.' + id)
  }

  const removeRole = (id: string): Promise<void> =>
    doMutate([{ path: ['roles', id], op: 'unset' }], 'roles.' + id)

  const updateRoleField = (
    id: string,
    field: keyof RoleTemplate,
    value: unknown,
  ): Promise<void> =>
    doMutate(
      [{ path: ['roles', id, field], op: 'set', value }],
      'roles.' + id + '.' + field,
    )

  return (
    <div className="dsp-section">
      <div className="dsp-section-header">
        Subagent Pro
        <span className="dsp-section-meta">
          {!available
            ? '（设置 bridge 未加载，仅展示）'
            : busy
              ? '（保存中…）'
              : '（设置命名空间 subagent-pro）'}
        </span>
      </div>

      <DefaultCard section={section} onChange={updateField} saved={savedFlag} disabled={!available} />

      <MdRolesCard />

      <RolesCard
        section={section}
        onAdd={addRole}
        onRemove={removeRole}
        onUpdate={updateRoleField}
        disabled={!available}
      />
    </div>
  )
}

// ---- defaults card ----

interface DefaultCardProps {
  section: SubagentProSection
  onChange(path: ReadonlyArray<string>, value: unknown): Promise<void>
  saved: Record<string, boolean>
  disabled: boolean
}

function DefaultCard({ section, onChange, saved, disabled }: DefaultCardProps): ReactElement {
  const svc = getSettingsService()
  const [providers, setProviders] = useState<LlmProviderInfo[]>([])
  const [models, setModels] = useState<LlmModelInfo[]>([])
  const [llmLoadFailed, setLlmLoadFailed] = useState(false)
  const [fileRoles, setFileRoles] = useState<FileRoleInfo[]>([])
  const [fileRolesLoadFailed, setFileRolesLoadFailed] = useState(false)
  const currentProvider = section.defaultProvider ?? ''
  const currentModel = section.defaultModel ?? ''

  // Fetch providers list once on mount.
  useEffect(() => {
    if (svc === undefined) return
    let cancelled = false
    void svc.listProviders().then(
      (p) => {
        if (!cancelled) {
          setProviders(p)
          setLlmLoadFailed(false)
        }
      },
      () => {
        if (!cancelled) {
          setProviders([])
          setLlmLoadFailed(true)
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [svc])

  // File-backed roles (every registered workspace + global .dsh/agents/*.md) so
  // the `defaultRole` dropdown can list them alongside settings.roles. Same
  // fetch surface as `MdRolesCard` — fetched independently because DefaultCard
  // may render before MdRolesCard mounts (and vice versa).
  useEffect(() => {
    if (svc === undefined) return
    let cancelled = false
    void svc.listFileRoles().then(
      (r) => {
        if (!cancelled) {
          setFileRoles(r)
          setFileRolesLoadFailed(false)
        }
      },
      () => {
        if (!cancelled) {
          setFileRoles([])
          setFileRolesLoadFailed(true)
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [svc])

  // Fetch models when provider changes.
  useEffect(() => {
    if (svc === undefined) return
    if (currentProvider === '') {
      setModels([])
      return
    }
    let cancelled = false
    void svc.listModels(currentProvider).then(
      (m) => {
        if (!cancelled) setModels(m)
      },
      () => {
        if (!cancelled) setModels([])
      },
    )
    return () => {
      cancelled = true
    }
  }, [svc, currentProvider])

  const roleEntries = Object.entries(section.roles ?? {})

  return (
    <div className="dsp-card">
      <div className="dsp-card-head">
        <span className="dsp-card-title">默认委派</span>
        <span className="dsp-card-source settings">settings</span>
      </div>

      {/* provider */}
      <div className="dsp-field-row">
        <label>默认 provider</label>
        {providers.length > 0 ? (
          <select
            value={currentProvider}
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.value
              // Switching provider → clear model and reasoning so the saved
              // value still matches the new provider's model list.
              void (async (): Promise<void> => {
                await onChange(['defaultProvider'], next === '' ? null : next)
                if (next !== currentProvider) {
                  await onChange(['defaultModel'], null)
                  await onChange(['defaultReasoningEffort'], null)
                }
              })()
            }}
          >
            <option value="">（不设置）</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={currentProvider}
            placeholder={llmLoadFailed ? 'LLM 信息获取失败，手动输入' : '例：deepseek-official'}
            disabled={disabled}
            onChange={(e) => {
              void onChange(['defaultProvider'], e.target.value === '' ? null : e.target.value)
            }}
          />
        )}
        <span className="dsp-card-meta">
          {saved['defaultProvider'] === true ? '已保存' : ''}
        </span>
      </div>

      {/* model (depends on provider) */}
      <div className="dsp-field-row">
        <label>默认 model</label>
        {currentProvider !== '' && models.length > 0 ? (
          <select
            value={section.defaultModel ?? ''}
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.value
              void (async (): Promise<void> => {
                await onChange(['defaultModel'], next === '' ? null : next)
                // Switching model may invalidate reasoningEffort
                await onChange(['defaultReasoningEffort'], null)
              })()
            }}
          >
            <option value="">（不设置）</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.id})
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={section.defaultModel ?? ''}
            placeholder={
              currentProvider === ''
                ? '（先选 provider）'
                : llmLoadFailed
                  ? 'LLM 信息获取失败，手动输入'
                  : '例：deepseek-chat'
            }
            disabled={disabled}
            onChange={(e) => {
              void onChange(['defaultModel'], e.target.value === '' ? null : e.target.value)
            }}
          />
        )}
        <span className="dsp-card-meta">{saved['defaultModel'] === true ? '已保存' : ''}</span>
      </div>

      {/* reasoningEffort (depends on model capabilities) */}
      <ReasoningField
        path={['defaultReasoningEffort']}
        providerId={currentProvider}
        modelId={currentModel}
        value={section.defaultReasoningEffort}
        disabled={disabled}
        onChange={onChange}
        saved={saved['defaultReasoningEffort'] === true}
      />

      {/* role — merge settings.roles + agent-md roles (project / global) in
          a single dropdown so the user can pick any role the runtime can
          resolve. md ids collide with settings.roles only by convention —
          project-wins precedence already happens server-side in
          resolveRoute / the default seam, so the dropdown just needs to
          offer every legal choice. */}
      <div className="dsp-field-row">
        <label>默认 role</label>
        <select
          value={section.defaultRole ?? ''}
          disabled={disabled}
          onChange={(e) => {
            void onChange(['defaultRole'], e.target.value === '' ? null : e.target.value)
          }}
        >
          <option value="">（不设置）</option>
          {fileRoles.filter((r) => r.source === 'project-md').length > 0 ? (
            <optgroup label="项目 agent md">
              {fileRoles
                .filter((r) => r.source === 'project-md')
                .map((r) => (
                  <option key={'md-project-' + r.id} value={r.id}>
                    {r.id} — {r.displayName}
                  </option>
                ))}
            </optgroup>
          ) : null}
          {fileRoles.filter((r) => r.source === 'global-md').length > 0 ? (
            <optgroup label="全局 agent md">
              {fileRoles
                .filter((r) => r.source === 'global-md')
                .map((r) => (
                  <option key={'md-global-' + r.id} value={r.id}>
                    {r.id} — {r.displayName}
                  </option>
                ))}
            </optgroup>
          ) : null}
          {roleEntries.length > 0 ? (
            <optgroup label="设置">
              {roleEntries.map(([id, role]) => (
                <option key={'set-' + id} value={id}>
                  {id} — {role.displayName}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        <span className="dsp-card-meta">
          {saved['defaultRole'] === true
            ? '已保存'
            : fileRolesLoadFailed
              ? '（file roles 加载失败）'
              : ''}
        </span>
      </div>
    </div>
  )
}

/** Reasoning-effort field: dropdown only if the selected model advertises the capability. */
function ReasoningField(props: {
  path: ReadonlyArray<string>
  providerId: string
  modelId: string
  value: string | undefined
  disabled: boolean
  onChange(path: ReadonlyArray<string>, value: unknown): Promise<void>
  saved: boolean
}): ReactElement {
  const { providerId, modelId, value, disabled, onChange, path, saved } = props
  const svc = getSettingsService()
  const [efforts, setEfforts] = useState<LlmReasoningEffortInfo[]>([])
  const [loaded, setLoaded] = useState(false)
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    if (svc === undefined) return
    if (providerId === '' || modelId === '') {
      setEfforts([])
      setLoaded(true)
      return
    }
    let cancelled = false
    setLoaded(false)
    void svc.listReasoningEfforts(providerId, modelId).then(
      (e) => {
        if (!cancelled) {
          setEfforts(e)
          setLoaded(true)
          setLoadFailed(false)
        }
      },
      () => {
        if (!cancelled) {
          setEfforts([])
          setLoaded(true)
          setLoadFailed(true)
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [svc, providerId, modelId])

  const showDropdown = loaded && efforts.length > 0
  const showFallbackInput = loaded && efforts.length === 0

  return (
    <div className="dsp-field-row">
      <label>默认 reasoningEffort</label>
      {showDropdown ? (
        <select
          value={value ?? ''}
          disabled={disabled}
          onChange={(e) => {
            void onChange(path, e.target.value === '' ? null : e.target.value)
          }}
        >
          <option value="">（不设置）</option>
          {efforts.map((eff) => (
            <option key={eff.id} value={eff.id}>
              {eff.name}
            </option>
          ))}
        </select>
      ) : showFallbackInput ? (
        <input
          type="text"
          value={value ?? ''}
          placeholder={
            loadFailed
              ? 'reasoningEffort 解析失败，手动输入'
              : '（当前模型未声明 reasoningEffort）'
          }
          disabled={disabled}
          onChange={(e) => {
            void onChange(path, e.target.value === '' ? null : e.target.value)
          }}
        />
      ) : (
        <input
          type="text"
          value={value ?? ''}
          placeholder={
            providerId === '' || modelId === ''
              ? '（先选 model）'
              : '加载中…'
          }
          disabled
        />
      )}
      <span className="dsp-card-meta">{saved ? '已保存' : ''}</span>
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

// ---- file-backed roles (read-only) ----

/**
 * Read-only section listing every role discovered on disk — global
 * `~/.dsh/agents/*.md` plus every registered workspace's `.dsh/agents/*.md`.
 * Source labels disambiguate project vs global; `isOverride` adds an
 * `also: 全局/项目` chip when both layers define the same id (project wins).
 * Locked icons mark these as file-owned (edit the .md to change).
 */
function MdRolesCard(): ReactElement | null {
  const svc = getSettingsService()
  const [roles, setRoles] = useState<FileRoleInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState<string | undefined>()

  const refresh = async (): Promise<void> => {
    if (svc === undefined) return
    setLoading(true)
    setLoadError(undefined)
    try {
      const list = await svc.listFileRoles()
      setRoles(list)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
      setRoles([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [svc]) // eslint-disable-line react-hooks/exhaustive-deps

  if (svc === undefined) return null

  const projectRoles = roles.filter((r) => r.source === 'project-md')
  const globalRoles = roles.filter((r) => r.source === 'global-md')

  const renderRole = (r: FileRoleInfo): ReactElement => (
    <div key={r.id} className="dsp-role-card dsp-role-card-md">
      <div className="dsp-role-card-head">
        <span className="dsp-role-card-title">{r.displayName}</span>
        <span className={'dsp-role-source-chip dsp-role-source-' + r.source}>
          {r.source === 'project-md' ? '项目' : '全局'}
        </span>
        {r.isOverride ? (
          <span className="dsp-role-also-chip">
            also: {r.source === 'project-md' ? '全局' : '项目'}
          </span>
        ) : null}
        <svg
          className="dsp-role-locked"
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-label="只读"
        >
          <title>只读 — 修改请直接编辑 .md 文件</title>
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
      </div>
      <div className="dsp-role-card-path">{r.filePath}</div>
      {r.description !== '' ? (
        <div className="dsp-role-card-desc">{r.description}</div>
      ) : null}
      {r.persona !== undefined && r.persona !== '' ? (
        <details className="dsp-role-card-persona-wrap">
          <summary className="dsp-role-card-persona-summary">persona</summary>
          <pre className="dsp-role-card-persona">{r.persona}</pre>
        </details>
      ) : null}
      {r.provider !== undefined || r.model !== undefined ? (
        <div className="dsp-role-card-meta">
          {r.provider !== undefined ? <span>provider: {r.provider}</span> : null}
          {r.model !== undefined ? <span>model: {r.model}</span> : null}
          {r.reasoningEffort !== undefined ? <span>effort: {r.reasoningEffort}</span> : null}
        </div>
      ) : null}
    </div>
  )

  return (
    <div className="dsp-card dsp-card-md">
      <div className="dsp-card-head">
        <span className="dsp-card-title">角色（文件）</span>
        <span className="dsp-card-meta">
          来自 .dsh/agents/*.md · 只读（修改请直接编辑 .md 文件）
        </span>
      </div>

      {loadError !== undefined ? (
        <div className="dsp-card-meta dsp-role-error">
          加载失败：{loadError}
          <button className="dsp-btn" type="button" onClick={() => { void refresh() }}>
            重试
          </button>
        </div>
      ) : null}

      {loading && roles.length === 0 ? (
        <div className="dsp-card-meta">加载中…</div>
      ) : null}

      {!loading && !loadError && roles.length === 0 ? (
        <div className="dsp-card-meta">
          尚未在任何 .dsh/agents/*.md 中找到角色。在项目 <code>{'<workspace>'}/.dsh/agents/code-reviewer.md</code> 或全局 <code>~/.dsh/agents/code-reviewer.md</code> 写一份即出现。
        </div>
      ) : null}

      {projectRoles.length > 0 ? (
        <>
          <div className="dsp-role-section-label">
            <span className="dsp-role-section-dot dsp-role-section-dot-project" />
            项目级
          </div>
          {projectRoles.map(renderRole)}
        </>
      ) : null}

      {globalRoles.length > 0 ? (
        <>
          <div className="dsp-role-section-label">
            <span className="dsp-role-section-dot dsp-role-section-dot-global" />
            全局级
          </div>
          {globalRoles.map(renderRole)}
        </>
      ) : null}
    </div>
  )
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

function RoleCard(props: RoleCardProps): ReactElement {
  const { id, role, onRemove, onUpdate, disabled } = props
  const svc = getSettingsService()
  const [providers, setProviders] = useState<LlmProviderInfo[]>([])
  const [models, setModels] = useState<LlmModelInfo[]>([])
  const roleProvider = role.provider ?? ''

  useEffect(() => {
    if (svc === undefined) return
    let cancelled = false
    void svc.listProviders().then(
      (p) => {
        if (!cancelled) setProviders(p)
      },
      () => {
        if (!cancelled) setProviders([])
      },
    )
    return () => {
      cancelled = true
    }
  }, [svc])

  useEffect(() => {
    if (svc === undefined) return
    if (roleProvider === '') {
      setModels([])
      return
    }
    let cancelled = false
    void svc.listModels(roleProvider).then(
      (m) => {
        if (!cancelled) setModels(m)
      },
      () => {
        if (!cancelled) setModels([])
      },
    )
    return () => {
      cancelled = true
    }
  }, [svc, roleProvider])

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
      {/* provider */}
      <div className="dsp-field-row">
        <label>provider</label>
        {providers.length > 0 ? (
          <select
            value={roleProvider}
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.value
              void (async (): Promise<void> => {
                await onUpdate(id, 'provider', next === '' ? null : next)
                if (next !== roleProvider) {
                  await onUpdate(id, 'model', null)
                  await onUpdate(id, 'reasoningEffort', null)
                }
              })()
            }}
          >
            <option value="">（继承）</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.id})
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={roleProvider}
            placeholder="（继承）"
            disabled={disabled}
            onChange={(e) => {
              void onUpdate(id, 'provider', e.target.value === '' ? null : e.target.value)
            }}
          />
        )}
      </div>
      {/* model */}
      <div className="dsp-field-row">
        <label>model</label>
        {roleProvider !== '' && models.length > 0 ? (
          <select
            value={role.model ?? ''}
            disabled={disabled}
            onChange={(e) => {
              const next = e.target.value
              void (async (): Promise<void> => {
                await onUpdate(id, 'model', next === '' ? null : next)
                await onUpdate(id, 'reasoningEffort', null)
              })()
            }}
          >
            <option value="">（继承）</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} ({m.id})
              </option>
            ))}
          </select>
        ) : (
          <input
            type="text"
            value={role.model ?? ''}
            placeholder={roleProvider === '' ? '（先选 provider）' : '（继承）'}
            disabled={disabled}
            onChange={(e) => {
              void onUpdate(id, 'model', e.target.value === '' ? null : e.target.value)
            }}
          />
        )}
      </div>
      {/* reasoningEffort */}
      <ReasoningField
        path={['roles', id, 'reasoningEffort']}
        providerId={roleProvider}
        modelId={role.model ?? ''}
        value={role.reasoningEffort}
        disabled={disabled}
        onChange={(p, v) => onUpdate(id, p[p.length - 1] as keyof RoleTemplate, v)}
        saved={false}
      />
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
