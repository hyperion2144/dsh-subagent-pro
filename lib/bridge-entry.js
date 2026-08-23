import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
//#region src/agents-md.ts
/**
* Agent md loader — Claude Code style .md subagent definitions.
*
* Reads role definitions from two sources:
*   1. Global: `${globalAgentDir}/*.md` (default `~/.dsh/agents/`)
*   2. Project: `${workspace.path}/${projectDirName}/*.md` for every registered
*      workspace (`ctx.workspaceRegistry.list()`) — host injects the registry
*      in web profiles, so the panel sees one entry per opened project.
*
* Roles are merged into a single deduped list keyed by id (filename). When the
* same id appears in both layers the **project** version wins (displayName,
* description, persona, provider, model, reasoningEffort, toolFilter) — and
* every layer that contributed is recorded on `altPaths[]` so the panel can
* render an `also: 全局/项目` chip without losing the global copy.
*/
const MD_EXT = ".md";
const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function isKebabCase(s) {
	return KEBAB_CASE.test(s);
}
/** Strip .md suffix from a basename. Pure string op. */
function stripMdExt(name) {
	return name.endsWith(".md") ? name.slice(0, -3) : name;
}
/** Extract the last path segment by scanning backward for / or \. Avoids regex. */
function lastSegment(pathStr) {
	let last = 0;
	for (let i = pathStr.length - 1; i >= 0; i--) {
		const ch = pathStr.charCodeAt(i);
		if (ch === 47 || ch === 92) {
			last = i + 1;
			break;
		}
	}
	return pathStr.slice(last);
}
function parseFrontmatter(raw) {
	const warnings = [];
	if (!raw.startsWith("---")) return {
		fm: {},
		body: raw,
		warnings
	};
	const rest = raw.slice(3);
	const newlineIdx = rest.indexOf("\n");
	if (newlineIdx === -1) return {
		fm: {},
		body: raw,
		warnings: ["unterminated frontmatter (no closing ---)"]
	};
	const afterFirstLine = rest.slice(newlineIdx + 1);
	const closeIdx = afterFirstLine.indexOf("\n---");
	if (closeIdx === -1) return {
		fm: {},
		body: raw,
		warnings: ["unterminated frontmatter (no closing ---)"]
	};
	const fmRaw = afterFirstLine.slice(0, closeIdx);
	const body = afterFirstLine.slice(closeIdx + 4).replace(/^\n+/, "");
	const fm = {};
	for (const line of fmRaw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const key = line.slice(0, colon).trim();
		const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, "");
		if (key === "" || value === "") continue;
		fm[key] = value;
	}
	return {
		fm,
		body,
		warnings
	};
}
function parseModel(spec) {
	if (spec === void 0 || spec.trim() === "") return {};
	const parts = spec.split("/").map((p) => p.trim()).filter((p) => p !== "");
	if (parts.length === 2) return {
		provider: parts[0],
		model: parts[1]
	};
	return { model: parts[0] };
}
function parseTools(spec) {
	if (spec === void 0 || spec.trim() === "") return void 0;
	const out = [];
	for (const tok of spec.split(/\s+/)) {
		if (tok === "") continue;
		out.push(tok);
	}
	return out.length > 0 ? out : void 0;
}
function readOne(filePath, source) {
	const fileBase = stripMdExt(lastSegment(filePath));
	const id = fileBase;
	let raw;
	try {
		raw = readFileSync(filePath, "utf8");
	} catch (err) {
		return {
			id: "",
			filePath,
			source,
			role: {
				displayName: "",
				description: "",
				source,
				filePath
			},
			warnings: ["subagent-pro: failed to read agent md " + filePath + ": " + (err instanceof Error ? err.message : String(err))]
		};
	}
	if (!isKebabCase(id)) return {
		id,
		filePath,
		source,
		role: {
			displayName: "",
			description: "",
			source,
			filePath
		},
		warnings: ["subagent-pro: agent md file \"" + filePath + "\" has a non-kebab-case base name; skipping (id=\"" + id + "\")"]
	};
	const { fm, body, warnings: fmWarnings } = parseFrontmatter(raw);
	const displayName = typeof fm.name === "string" && fm.name.trim() !== "" ? fm.name.trim() : fileBase;
	const description = typeof fm.description === "string" && fm.description.trim() !== "" ? fm.description.trim() : fileBase;
	const providerModel = parseModel(typeof fm.model === "string" ? fm.model : void 0);
	const tools = parseTools(typeof fm.tools === "string" ? fm.tools : void 0);
	const role = {
		displayName,
		description,
		...body.trim() !== "" ? { persona: body.trim() } : {},
		...providerModel.provider !== void 0 ? { provider: providerModel.provider } : {},
		...providerModel.model !== void 0 ? { model: providerModel.model } : {},
		...tools !== void 0 ? { toolFilter: { allow: tools } } : {},
		source,
		filePath
	};
	const warnings = [...fmWarnings];
	if (description === fileBase) warnings.push("subagent-pro: agent md \"" + filePath + "\" has no description; main agent guidance will fall back to the filename");
	return {
		id,
		filePath,
		source,
		role,
		warnings
	};
}
function scanDir(dir, source) {
	if (dir === void 0) return {
		roles: [],
		warnings: []
	};
	if (!existsSync(dir)) return {
		roles: [],
		warnings: []
	};
	let stat;
	try {
		stat = statSync(dir);
	} catch {
		return {
			roles: [],
			warnings: []
		};
	}
	if (!stat.isDirectory()) return {
		roles: [],
		warnings: []
	};
	const roles = [];
	const warnings = [];
	const entries = readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		if (!entry.name.endsWith(MD_EXT)) continue;
		const parsed = readOne(join(dir, entry.name), source);
		if (parsed.role.displayName === "" || parsed.role.description === "") {
			warnings.push(...parsed.warnings);
			continue;
		}
		roles.push(parsed.role);
		warnings.push(...parsed.warnings);
	}
	return {
		roles,
		warnings
	};
}
/**
* Merge roles from every contributing layer. Project always wins; the global
* copy is preserved on `altPaths` so the UI can show `also: 全局` without
* losing it. The `isOverride` flag tells the panel when project overrode
* a same-named global (so the panel can label the role "项目" and add the
* alt chip).
*/
function mergeRoles(globalRoles, projectRoles) {
	const idFromPath = (filePath) => {
		if (filePath === void 0 || filePath === "") return "";
		return stripMdExt(lastSegment(filePath));
	};
	const byId = /* @__PURE__ */ new Map();
	for (const g of globalRoles) {
		const id = idFromPath(g.filePath);
		if (id === "") continue;
		byId.set(id, g);
	}
	for (const p of projectRoles) {
		const id = idFromPath(p.filePath);
		if (id === "") continue;
		const existing = byId.get(id);
		const projectRole = {
			...p,
			...existing !== void 0 ? { altPaths: [existing.filePath ?? ""].filter((s) => s !== "") } : {},
			source: "project-md",
			...existing !== void 0 ? { isOverride: true } : {}
		};
		byId.set(id, projectRole);
	}
	return [...byId.values()];
}
/**
* Load agent md roles for every registered workspace in addition to the
* single project cwd path. Used by the host's `/api/dsh-subagent-pro/roles`
* bridge endpoint so the panel can render file-backed roles for **every**
* project the user has open, not just the current session's cwd.
*
* Tolerates an absent workspaceRegistry (headless / smoke without host spine):
* falls back to the current cwd only.
*/
function loadAgentMdRolesAcrossWorkspaces(ctx, globalDir, projectDirName) {
	const getFn = ctx.get;
	const registry = getFn !== void 0 ? getFn("workspaceRegistry") : ctx.workspaceRegistry;
	const workspacePaths = [];
	if (registry?.list !== void 0) try {
		for (const ws of registry.list()) if (typeof ws?.path === "string" && ws.path !== "") workspacePaths.push(ws.path);
	} catch {}
	if (workspacePaths.length === 0) {
		const shell = ctx.get?.("shell");
		if (typeof shell?.cwd === "string" && shell.cwd !== "") workspacePaths.push(shell.cwd);
	}
	const globalScan = scanDir(globalDir, "global-md");
	const projectRoles = [];
	const warnings = [...globalScan.warnings];
	for (const wsPath of workspacePaths) {
		const scan = scanDir(join(wsPath, projectDirName), "project-md");
		for (const r of scan.roles) projectRoles.push({
			...r,
			filePath: r.filePath ?? ""
		});
		warnings.push(...scan.warnings);
	}
	return {
		roles: mergeRoles(globalScan.roles, projectRoles),
		warnings
	};
}
//#endregion
//#region src/bridge-entry.ts
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
const name = "dsh-subagent-pro-bridge";
const inject = [
	"webServer",
	"settings",
	"llm",
	"workspaceRegistry"
];
const NS = "subagent-pro";
const PREFIX = "/api/dsh-subagent-pro/settings";
const LLM_PREFIX = "/api/dsh-subagent-pro/llm";
const ROLES_PREFIX = "/api/dsh-subagent-pro/roles";
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
		req.on("error", reject);
	});
}
function sendJson(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(body));
}
function sendJsonLlm(res, status, body) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(body));
}
function apply(ctx) {
	const webServer = ctx.webServer;
	if (webServer === void 0) return;
	const settings = ctx.get("settings");
	if (settings === void 0) return;
	const llm = ctx.get("llm");
	const branded = NS;
	const view = () => {
		const d = settings.describe({ redactSecrets: true }).find((x) => x.ns === NS);
		if (d === void 0) return {
			ok: false,
			error: {
				code: "namespace-missing",
				message: "subagent-pro namespace is not registered"
			}
		};
		return {
			ok: true,
			view: d.value,
			revision: d.revision
		};
	};
	webServer.register({
		kind: "prefix",
		path: PREFIX,
		handler: async (req, res) => {
			const endpoint = new URL(req.url ?? "/", "http://localhost").pathname.slice(30).replace(/^\/+/, "");
			if (req.method === "GET" && endpoint === "view") {
				sendJson(res, 200, view());
				return;
			}
			if (req.method === "GET" && endpoint === "") {
				sendJson(res, 200, view());
				return;
			}
			if (req.method === "PATCH" && endpoint === "mutate") {
				let parsed;
				try {
					parsed = JSON.parse(await readBody(req));
				} catch (e) {
					sendJson(res, 400, {
						ok: false,
						error: {
							code: "bad-json",
							message: e instanceof Error ? e.message : String(e)
						}
					});
					return;
				}
				const body = parsed;
				if (!Array.isArray(body.ops)) {
					sendJson(res, 400, {
						ok: false,
						error: {
							code: "bad-shape",
							message: "ops must be an array"
						}
					});
					return;
				}
				try {
					await settings.mutate(branded, body.ops, body.expectedRevision);
				} catch (e) {
					const message = e instanceof Error ? e.message : String(e);
					const code = /conflict/i.test(message) ? "conflict" : /rejected|invalid|validate/i.test(message) ? "rejected" : "mutate-failed";
					sendJson(res, code === "conflict" ? 409 : 400, {
						ok: false,
						error: {
							code,
							message
						}
					});
					return;
				}
				sendJson(res, 200, view());
				return;
			}
			sendJson(res, 405, {
				ok: false,
				error: {
					code: "method-not-allowed",
					message: `${req.method} ${endpoint}`
				}
			});
		}
	});
	webServer.register({
		kind: "prefix",
		path: LLM_PREFIX,
		handler: async (req, res) => {
			const url = new URL(req.url ?? "/", "http://localhost");
			const endpoint = url.pathname.slice(25).replace(/^\/+/, "");
			if (req.method !== "GET") {
				sendJson(res, 405, {
					ok: false,
					error: {
						code: "method-not-allowed",
						message: req.method ?? "GET"
					}
				});
				return;
			}
			if (llm === void 0) {
				sendJsonLlm(res, 200, {
					ok: true,
					providers: []
				});
				return;
			}
			if (endpoint === "providers") {
				try {
					sendJsonLlm(res, 200, {
						ok: true,
						providers: llm.listProviders().map((p) => ({
							id: p.id,
							name: p.name ?? p.id
						}))
					});
				} catch (e) {
					sendJsonLlm(res, 500, {
						ok: false,
						error: {
							code: "llm-error",
							message: e instanceof Error ? e.message : String(e)
						}
					});
				}
				return;
			}
			if (endpoint === "models") {
				const provider = url.searchParams.get("provider") ?? "";
				if (provider === "") {
					sendJsonLlm(res, 400, {
						ok: false,
						error: {
							code: "missing-provider",
							message: "provider query param required"
						}
					});
					return;
				}
				try {
					sendJsonLlm(res, 200, {
						ok: true,
						models: (await llm.listModels(provider)).map((m) => ({
							id: m.id,
							name: m.name ?? m.id
						}))
					});
				} catch (e) {
					sendJsonLlm(res, 500, {
						ok: false,
						error: {
							code: "llm-error",
							message: e instanceof Error ? e.message : String(e)
						}
					});
				}
				return;
			}
			if (endpoint === "reasoning-efforts") {
				const provider = url.searchParams.get("provider") ?? "";
				const model = url.searchParams.get("model") ?? "";
				if (provider === "" || model === "") {
					sendJsonLlm(res, 400, {
						ok: false,
						error: {
							code: "missing-param",
							message: "provider and model query params required"
						}
					});
					return;
				}
				try {
					const resolved = await llm.resolveModelInfo(provider, model);
					sendJsonLlm(res, 200, {
						ok: true,
						efforts: (resolved.reasoning?.efforts ?? []).map((e) => ({
							id: e.id,
							name: e.name ?? e.id
						})),
						defaultEffort: resolved.reasoning?.defaultEffort
					});
				} catch (e) {
					sendJsonLlm(res, 500, {
						ok: false,
						error: {
							code: "llm-error",
							message: e instanceof Error ? e.message : String(e)
						}
					});
				}
				return;
			}
			sendJson(res, 404, {
				ok: false,
				error: {
					code: "unknown-endpoint",
					message: endpoint
				}
			});
		}
	});
	webServer.register({
		kind: "prefix",
		path: ROLES_PREFIX,
		handler: async (req, res) => {
			if (req.method !== "GET") {
				sendJson(res, 405, {
					ok: false,
					error: {
						code: "method-not-allowed",
						message: req.method ?? "GET"
					}
				});
				return;
			}
			const globalDir = join(homedir(), ".dsh", "agents");
			const projectDirName = ".dsh/agents";
			try {
				const result = loadAgentMdRolesAcrossWorkspaces(ctx, globalDir, projectDirName);
				sendJsonLlm(res, 200, {
					ok: true,
					roles: result.roles,
					warnings: result.warnings
				});
			} catch (e) {
				sendJsonLlm(res, 500, {
					ok: false,
					error: {
						code: "roles-error",
						message: e instanceof Error ? e.message : String(e)
					}
				});
			}
		}
	});
}
//#endregion
export { apply, inject, name };
