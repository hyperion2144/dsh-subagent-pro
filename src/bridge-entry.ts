/**
 * dsh-subagent-pro — settings bridge plugin entry (host side).
 *
 * This is a SEPARATE loader entry from the main `dsh-subagent-pro` plugin
 * because the host web server service is only reachable through cordis
 * `inject` — the main entry declares `inject: [webServer, ...]` but in
 * headless profiles webServer is absent, so the main entry must keep working
 * there unchanged. Same pattern as dsh-plugin-subagent-director's bridge.
 *
 * Exposes a prefix route at `/api/dsh-subagent-pro/{settings,roles,llm}`:
 *   - GET    `/api/dsh-subagent-pro/settings/view`     current subagent-pro view
 *   - PATCH  `/api/dsh-subagent-pro/settings/mutate`   apply path ops
 *   - GET    `/api/dsh-subagent-pro/roles`              file-backed roles from
 *                                                        every registered workspace
 *                                                        + global agent dir
 *   - GET    `/api/dsh-subagent-pro/llm/{providers,models,reasoning-efforts}`
 *                                                        host `llm` enumeration
 *
 * The wire shape is intentionally minimal (just `{ ok, view, revision }` or
 * `{ ok: false, error: { code, message } }`) and is consumed directly by
 * `src/client/role-editor.tsx` via fetch — no apiproxy mirroring needed.
 *
 * CORS: the prefix route is host-relative so the browser can call it directly
 * with `credentials: 'same-origin'`; no separate CORS layer required.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

import { loadAgentMdRolesAcrossWorkspaces } from './agents-md.js'

import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'

export const name = 'dsh-subagent-pro-bridge'
export const inject = ['webServer', 'settings', 'llm', 'workspaceRegistry']

const NS = 'subagent-pro'
const PREFIX = '/api/dsh-subagent-pro/settings'
const LLM_PREFIX = '/api/dsh-subagent-pro/llm'
const ROLES_PREFIX = '/api/dsh-subagent-pro/roles'

interface ViewSuccess {
  ok: true
  view: Record<string, unknown>
  revision: number
}

interface ProvidersSuccess {
  ok: true
  providers: Array<{ id: string; name: string }>
}

interface ModelsSuccess {
  ok: true
  models: Array<{ id: string; name: string }>
}

interface ReasoningSuccess {
  ok: true
  efforts: Array<{ id: string; name: string }>
  defaultEffort: string | undefined
}

interface ErrorEnvelope {
  ok: false
  error: { code: string; message: string }
}

type Result = ViewSuccess | ErrorEnvelope

interface SettingsLike {
  describe(opts: { redactSecrets: boolean }): Array<{
    ns: string
    value: Record<string, unknown>
    revision: number
  }>
  // SettingsProvider.mutate signature in dsh-settings 0.1.x
  mutate(
    ns: { readonly __brand: 'subagent-pro' } & string,
    ops: ReadonlyArray<{ path: readonly string[]; op: 'set' | 'unset'; value?: unknown }>,
    expectedRevision?: number,
  ): Promise<unknown>
}

interface LlmLike {
  listProviders(): Array<{ id: string; name?: string; [k: string]: unknown }>
  listModels(provider: string): Promise<Array<{ id: string; name?: string; [k: string]: unknown }>>
  resolveModelInfo(provider: string, model: string): Promise<{
    reasoning?: { efforts: Array<{ id: string; name?: string }>; defaultEffort?: string }
    [k: string]: unknown
  }>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')))
    req.on('error', reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: Result): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function sendJsonLlm<T>(res: ServerResponse, status: number, body: T): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

export function apply(ctx: Context): void {
  const webServer = (ctx as unknown as {
    webServer?: {
      register(spec: {
        kind: 'prefix'
        path: string
        handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
      }): () => void
    }
  }).webServer
  if (webServer === undefined) return

  const settings = (ctx as unknown as { get(name: string): SettingsLike | undefined }).get('settings')
  if (settings === undefined) return

  const llm = (ctx as unknown as { get(name: string): LlmLike | undefined }).get('llm')
  // Settings bridge is registered even if llm is missing — the editor falls
  // back to free text when llm-info can't be fetched.

  // Brand the namespace literal once so the settings.mutate call type-checks
  // (dsh-settings types the namespace argument as a branded string).
  const branded = NS as unknown as { readonly __brand: 'subagent-pro' } & string

  const view = (): Result => {
    const descriptors = settings.describe({ redactSecrets: true })
    const d = descriptors.find((x) => x.ns === NS)
    if (d === undefined) {
      return {
        ok: false,
        error: {
          code: 'namespace-missing',
          message: 'subagent-pro namespace is not registered',
        },
      }
    }
    return { ok: true, view: d.value, revision: d.revision }
  }

  // Direct, no effect wrapper — the host ref dsh-plugin-subagent-director uses
  // the same pattern. Register returns a disposer; we don't need to track it
  // because the host fiber's unload cascades the route teardown.
  webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const endpoint = url.pathname.slice(PREFIX.length).replace(/^\/+/, '')

      // GET .../view
      if (req.method === 'GET' && endpoint === 'view') {
        sendJson(res, 200, view())
        return
      }

      // GET (no sub-path) — treat as view too
      if (req.method === 'GET' && endpoint === '') {
        sendJson(res, 200, view())
        return
      }

      // PATCH .../mutate  body: { ops, expectedRevision }
      if (req.method === 'PATCH' && endpoint === 'mutate') {
        let parsed: unknown
        try {
          parsed = JSON.parse(await readBody(req))
        } catch (e) {
          sendJson(res, 400, {
            ok: false,
            error: {
              code: 'bad-json',
              message: e instanceof Error ? e.message : String(e),
            },
          })
          return
        }
        const body = parsed as {
          ops?: ReadonlyArray<{ path: string; op: 'set' | 'unset'; value?: unknown }>
          expectedRevision?: number
        }
        if (!Array.isArray(body.ops)) {
          sendJson(res, 400, {
            ok: false,
            error: { code: 'bad-shape', message: 'ops must be an array' },
          })
          return
        }
        try {
          await settings.mutate(branded, body.ops, body.expectedRevision)
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e)
          const code = /conflict/i.test(message)
            ? 'conflict'
            : /rejected|invalid|validate/i.test(message)
              ? 'rejected'
              : 'mutate-failed'
          sendJson(res, code === 'conflict' ? 409 : 400, {
            ok: false,
            error: { code, message },
          })
          return
        }
        sendJson(res, 200, view())
        return
      }

      sendJson(res, 405, {
        ok: false,
        error: { code: 'method-not-allowed', message: `${req.method} ${endpoint}` },
      })
    },
  })

  // LLM info bridge: enumerates providers, models, and per-model capabilities
  // (reasoningEffort). Used by the role editor's cascading selects.
  webServer.register({
    kind: 'prefix',
    path: LLM_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const endpoint = url.pathname.slice(LLM_PREFIX.length).replace(/^\/+/, '')

      if (req.method !== 'GET') {
        sendJson(res, 405, {
          ok: false,
          error: { code: 'method-not-allowed', message: req.method ?? 'GET' },
        })
        return
      }

      if (llm === undefined) {
        sendJsonLlm<ProvidersSuccess>(res, 200, { ok: true, providers: [] })
        return
      }

      // GET .../providers
      if (endpoint === 'providers') {
        try {
          const providers = llm.listProviders().map((p) => ({ id: p.id, name: p.name ?? p.id }))
          sendJsonLlm<ProvidersSuccess>(res, 200, { ok: true, providers })
        } catch (e) {
          sendJsonLlm<ErrorEnvelope>(res, 500, {
            ok: false,
            error: { code: 'llm-error', message: e instanceof Error ? e.message : String(e) },
          })
        }
        return
      }

      // GET .../models?provider=<id>
      if (endpoint === 'models') {
        const provider = url.searchParams.get('provider') ?? ''
        if (provider === '') {
          sendJsonLlm<ErrorEnvelope>(res, 400, {
            ok: false,
            error: { code: 'missing-provider', message: 'provider query param required' },
          })
          return
        }
        try {
          const models = await llm.listModels(provider)
          sendJsonLlm<ModelsSuccess>(res, 200, {
            ok: true,
            models: models.map((m) => ({
              id: m.id,
              name: m.name ?? m.id,
            })),
          })
        } catch (e) {
          sendJsonLlm<ErrorEnvelope>(res, 500, {
            ok: false,
            error: { code: 'llm-error', message: e instanceof Error ? e.message : String(e) },
          })
        }
        return
      }

      // GET .../reasoning-efforts?provider=<id>&model=<id>
      if (endpoint === 'reasoning-efforts') {
        const provider = url.searchParams.get('provider') ?? ''
        const model = url.searchParams.get('model') ?? ''
        if (provider === '' || model === '') {
          sendJsonLlm<ErrorEnvelope>(res, 400, {
            ok: false,
            error: {
              code: 'missing-param',
              message: 'provider and model query params required',
            },
          })
          return
        }
        try {
          const resolved = await llm.resolveModelInfo(provider, model)
          const efforts = resolved.reasoning?.efforts ?? []
          sendJsonLlm<ReasoningSuccess>(res, 200, {
            ok: true,
            efforts: efforts.map((e) => ({ id: e.id, name: e.name ?? e.id })),
            defaultEffort: resolved.reasoning?.defaultEffort,
          })
        } catch (e) {
          sendJsonLlm<ErrorEnvelope>(res, 500, {
            ok: false,
            error: { code: 'llm-error', message: e instanceof Error ? e.message : String(e) },
          })
        }
        return
      }

      sendJson(res, 404, {
        ok: false,
        error: { code: 'unknown-endpoint', message: endpoint },
      })
    },
  })

  // Roles bridge: every registered workspace's .dsh/agents/*.md + global dir,
  // merged with project-wins precedence. Read-only — agent-md files are owned
  // by the user, not edited through this endpoint. Powers the read-only
  // "角色（文件）" section in the role-editor UI.
  webServer.register({
    kind: 'prefix',
    path: ROLES_PREFIX,
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, {
          ok: false,
          error: { code: 'method-not-allowed', message: req.method ?? 'GET' },
        })
        return
      }
      const globalDir = join(homedir(), '.dsh', 'agents')
      const projectDirName = '.dsh/agents'
      try {
        const result = loadAgentMdRolesAcrossWorkspaces(ctx, globalDir, projectDirName)
        sendJsonLlm(res, 200, {
          ok: true,
          roles: result.roles,
          warnings: result.warnings,
        })
      } catch (e) {
        sendJsonLlm(res, 500, {
          ok: false,
          error: { code: 'roles-error', message: e instanceof Error ? e.message : String(e) },
        })
      }
    },
  })
}
