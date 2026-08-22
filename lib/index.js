import { foldRequestHeader } from "@deepseek-ai/dsh-session";
import { assertSubagentMaxDepth, settleRun } from "@deepseek-ai/dsh-subagent";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import z from "@deepseek-ai/schemastery";
import { installSettingsSection } from "@deepseek-ai/dsh-settings";
//#region src/monitor.ts
const MAX_PER_ROOT = 200;
function mountMonitor(ctxIn, _resolved) {
	const ctx = ctxIn;
	const logger = ctxIn.logger;
	const runs = /* @__PURE__ */ new Map();
	const str = (value) => typeof value === "string" ? value : String(value);
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
	const sessionModel = async (sessionId) => {
		const extract = (config) => {
			if (config === void 0 || typeof config.model !== "string" || config.model === "") return;
			return {
				...typeof config.provider === "string" && config.provider !== "" ? { provider: config.provider } : {},
				model: config.model,
				...typeof config.reasoningEffort === "string" && config.reasoningEffort !== "" ? { reasoningEffort: config.reasoningEffort } : {}
			};
		};
		let liveResult;
		try {
			const header = ctx.sessions.get(sessionId)?.requestHeader();
			liveResult = header?.config?.model;
			const fromLive = extract(header?.config);
			if (fromLive !== void 0) return fromLive;
		} catch (err) {
			logger?.debug?.("[dsh-subagent-pro] sessionModel live path failed: " + String(err));
		}
		let coldResult;
		let coldError;
		try {
			const inspected = await inspectColdSession(sessionId);
			const header = foldRequestHeader(inspected.events);
			coldResult = header?.config?.model;
			const fromCold = extract(header?.config);
			if (fromCold !== void 0) return fromCold;
		} catch (err) {
			coldError = err instanceof Error ? err.message : String(err);
		}
		logger?.debug?.("[dsh-subagent-pro] sessionModel \"" + sessionId.slice(0, 8) + "\" live=" + JSON.stringify(liveResult ?? null) + " cold=" + JSON.stringify(coldResult ?? null) + " coldError=" + JSON.stringify(coldError ?? null));
	};
	/**
	* Cold-inspect one session's durable log through the api-remotes recipe,
	* tolerating an absent persistence backend. The direct import stays in a
	* closure so the host bundle's import graph remains open to runtime
	* interop (the loader resolves @deepseek-ai/dsh-api-remotes from the host
	* tree, which ships it).
	*/
	const inspectColdSession = async (sessionId) => {
		return (await import("@deepseek-ai/dsh-api-remotes")).inspectApiRemoteSession(ctxIn, sessionId);
	};
	const rootOf = (childId) => {
		let cur = ctx.sessions.get(childId);
		let hops = 0;
		while (cur !== void 0 && hops < 32) {
			const pid = cur.header.parentSession;
			if (pid === void 0) return str(cur.id);
			cur = ctx.sessions.get(pid);
			hops += 1;
		}
	};
	const prune = () => {
		const counts = /* @__PURE__ */ new Map();
		for (const row of runs.values()) counts.set(row.rootId, (counts.get(row.rootId) ?? 0) + 1);
		for (const [rootId, count] of counts) {
			if (count <= MAX_PER_ROOT) continue;
			let excess = count - MAX_PER_ROOT;
			const rows = [...runs.values()].filter((row) => row.rootId === rootId && row.status !== "running").sort((a, b) => a.startedAt - b.startedAt);
			for (const row of rows) {
				if (excess <= 0) break;
				runs.delete(row.runId);
				excess -= 1;
			}
		}
	};
	const onStart = (info) => {
		const childId = str(info.id);
		const root = rootOf(childId);
		if (root === void 0) return;
		runs.set(str(info.runId), {
			runId: str(info.runId),
			id: childId,
			provider: info.provider,
			local: info.local,
			rootId: root,
			startedAt: Date.now(),
			status: "running"
		});
		prune();
	};
	const onRunRoute = (info) => {
		const childId = str(info.childId);
		for (const row of runs.values()) {
			if (row.id !== childId) continue;
			if (info.provider !== void 0) row.provider = info.provider;
			if (info.model !== void 0) row.model = info.model;
			if (info.reasoningEffort !== void 0) row.reasoningEffort = info.reasoningEffort;
			return;
		}
	};
	const onEnd = (info) => {
		const row = runs.get(str(info.runId));
		if (row === void 0) return;
		row.status = info.stopReason;
		row.endedAt = Date.now();
	};
	ctx.on("subagent/start", onStart, { global: true });
	ctx.on("subagent/end", onEnd, { global: true });
	ctx.on("dsh-subagent-pro/run-route", onRunRoute, { global: true });
	const enrich = async (sessionId) => {
		let desc = [];
		try {
			desc = await ctx.subagents.listDescendants(sessionId);
		} catch {
			desc = [];
		}
		const eventRows = [];
		for (const row of runs.values()) if (row.rootId === sessionId) eventRows.push({ ...row });
		eventRows.sort((a, b) => a.startedAt - b.startedAt);
		const modelByChild = /* @__PURE__ */ new Map();
		const catalogIds = [];
		for (const entry of desc) {
			if (entry === void 0) continue;
			if (entry.kind !== "child") continue;
			const id = str(entry.id);
			if (!catalogIds.includes(id)) catalogIds.push(id);
		}
		for (const id of catalogIds) {
			if (modelByChild.has(id)) continue;
			const modelInfo = await sessionModel(id);
			if (modelInfo !== void 0) modelByChild.set(id, modelInfo);
		}
		const merged = [];
		const seen = /* @__PURE__ */ new Set();
		for (let index = 0; index < desc.length; index++) {
			const entry = desc[index];
			if (entry === void 0) continue;
			const id = str(entry.id);
			seen.add(id);
			const base = {
				id,
				...entry.kind === "child" && entry.label !== void 0 ? { label: entry.label } : {},
				...entry.kind === "child" ? { mode: entry.mode } : {},
				depth: entry.depth,
				parentId: str(entry.parentId)
			};
			const ev = eventRows.find((row) => row.id === id);
			const liveModel = modelByChild.get(id);
			const modelAttach = liveModel !== void 0 ? {
				...liveModel.provider !== void 0 ? { provider: liveModel.provider } : {},
				...liveModel.model !== void 0 ? { model: liveModel.model } : {},
				...liveModel.reasoningEffort !== void 0 ? { reasoningEffort: liveModel.reasoningEffort } : {}
			} : {};
			if (ev !== void 0) merged.push({
				...base,
				...ev,
				...modelAttach
			});
			else merged.push({
				...base,
				...modelAttach,
				local: true,
				sortKey: -(desc.length - index),
				status: entry.kind === "child" && entry.activity === "running" ? "running" : "unknown"
			});
		}
		for (const ev of eventRows) if (!seen.has(ev.id)) merged.push({
			...ev,
			depth: 0
		});
		merged.sort((a, b) => {
			const ka = a.startedAt ?? a.sortKey ?? Number.NEGATIVE_INFINITY;
			return (b.startedAt ?? b.sortKey ?? Number.NEGATIVE_INFINITY) - ka;
		});
		return merged;
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/api/dsh-subagent-pro/snapshot",
		handler: async (req, res) => {
			const sessionId = new URL(req.url ?? "/", "http://localhost").searchParams.get("sessionId");
			const payload = sessionId === null ? {
				now: Date.now(),
				rows: []
			} : {
				sessionId,
				now: Date.now(),
				rows: await enrich(sessionId)
			};
			res.writeHead(200, {
				"content-type": "application/json",
				"cache-control": "no-store"
			});
			res.end(JSON.stringify(payload));
		}
	}), "dsh-subagent-pro: snapshot route");
}
//#endregion
//#region src/default-route.ts
function isEmpty$2(value) {
	return value === void 0 || value === "";
}
function resolveSeamAgentOptions(input) {
	const { agentOptions, settings, isRoutable } = input;
	if (agentOptions !== void 0 && (agentOptions.provider !== void 0 || agentOptions.model !== void 0)) return;
	const provider = settings.defaultProvider;
	const model = settings.defaultModel;
	if (isEmpty$2(provider) || isEmpty$2(model)) return void 0;
	if (isRoutable !== void 0 && !isRoutable(provider)) return void 0;
	return {
		provider,
		model
	};
}
/**
* Dispatch the `dsh-subagent-pro/run-route` custom event (same plumbing as the
* delegation tool) so the monitor panel can show which model a subagent used.
* The runtime's `subagent/start` event only carries the transport provider
* name, never the resolved LLM model.
*/
function emitRunRoute(ctx, payload) {
	const events = ctx.events;
	if (events === void 0) return;
	const callbacks = events.dispatch("emit", ["dsh-subagent-pro/run-route", payload]);
	for (const cb of callbacks) cb(payload);
}
/** Extract the child session id from the run handle any start path returns. */
function runChildId(run) {
	if (typeof run !== "object" || run === null) return void 0;
	const id = run.id ?? run.childId;
	return id === void 0 ? void 0 : String(id);
}
function applyDefaultRouteSeam(ctx, getSettings) {
	const subagents = ctx.subagents;
	const originalStart = subagents.start;
	const originalStartContinuable = subagents.startContinuable;
	const llm = ctx.get("llm");
	const isRoutable = llm === void 0 ? void 0 : (provider) => llm.listProviders().some((entry) => entry.id === provider);
	const resolve = (request) => resolveSeamAgentOptions({
		agentOptions: request.agentOptions,
		settings: getSettings(),
		isRoutable
	});
	subagents.start = (name, request) => {
		const agentOptions = resolve(request);
		if (agentOptions !== void 0) {
			ctx.logger.info("[dsh-subagent-pro] default route seam: applying " + agentOptions.provider + "/" + agentOptions.model + " to " + name + " subagent");
			const run = originalStart.call(subagents, name, {
				...request,
				agentOptions
			});
			Promise.resolve(run).then((resolved) => {
				const childId = runChildId(resolved);
				if (childId !== void 0) emitRunRoute(ctx, {
					childId,
					provider: agentOptions.provider,
					model: agentOptions.model
				});
			});
			return run;
		}
		return originalStart.call(subagents, name, request);
	};
	subagents.startContinuable = (spec) => {
		const agentOptions = resolve(spec.request);
		if (agentOptions !== void 0) {
			ctx.logger.info("[dsh-subagent-pro] default route seam: applying " + agentOptions.provider + "/" + agentOptions.model + " to continuable subagent");
			const run = originalStartContinuable.call(subagents, {
				...spec,
				request: {
					...spec.request,
					agentOptions
				}
			});
			Promise.resolve(run).then((resolved) => {
				const childId = runChildId(resolved);
				if (childId !== void 0) emitRunRoute(ctx, {
					childId,
					provider: agentOptions.provider,
					model: agentOptions.model
				});
			});
			return run;
		}
		return originalStartContinuable.call(subagents, spec);
	};
	return () => {
		subagents.start = originalStart;
		subagents.startContinuable = originalStartContinuable;
	};
}
//#endregion
//#region src/route-resolver.ts
function isEmpty$1(value) {
	return value === void 0 || value === "";
}
function resolveRoute(input, lookup) {
	const { args = {}, settings } = input;
	const warnings = [];
	const callProvider = isEmpty$1(args.provider) ? void 0 : args.provider;
	const callModel = isEmpty$1(args.model) ? void 0 : args.model;
	const callEffort = isEmpty$1(args.reasoningEffort) ? void 0 : args.reasoningEffort;
	const roleIdRaw = (isEmpty$1(args.role) ? void 0 : args.role) ?? settings.defaultRole;
	let role;
	let resolvedRoleId;
	if (roleIdRaw !== void 0) {
		const byId = lookup.byId(roleIdRaw);
		if (byId !== void 0) {
			role = byId;
			resolvedRoleId = roleIdRaw;
		} else {
			const byDisplay = lookup.byDisplayName(roleIdRaw);
			if (byDisplay !== void 0) {
				role = byDisplay.role;
				resolvedRoleId = byDisplay.id;
				warnings.push("subagent-pro: role \"" + roleIdRaw + "\" is not an id; resolved by displayName to id \"" + resolvedRoleId + "\" — prefer passing the id directly");
			} else warnings.push("subagent-pro: role \"" + roleIdRaw + "\" does not exist; its binding (persona/provider/model) is skipped");
		}
	}
	const roleProvider = role === void 0 || isEmpty$1(role.provider) ? void 0 : role.provider;
	const roleModel = role === void 0 || isEmpty$1(role.model) ? void 0 : role.model;
	const roleEffort = role === void 0 || isEmpty$1(role.reasoningEffort) ? void 0 : role.reasoningEffort;
	const defaultProvider = isEmpty$1(settings.defaultProvider) ? void 0 : settings.defaultProvider;
	const defaultModel = isEmpty$1(settings.defaultModel) ? void 0 : settings.defaultModel;
	const defaultEffort = isEmpty$1(settings.defaultReasoningEffort) ? void 0 : settings.defaultReasoningEffort;
	const provider = callProvider ?? roleProvider ?? defaultProvider;
	const model = callModel ?? roleModel ?? defaultModel;
	const reasoningEffort = callEffort ?? roleEffort ?? defaultEffort;
	const agentOptions = provider !== void 0 || model !== void 0 ? {
		...provider !== void 0 ? { provider } : {},
		...model !== void 0 ? { model } : {}
	} : void 0;
	let layer = "inherit";
	if (provider !== void 0 || model !== void 0) {
		if (callProvider !== void 0 || callModel !== void 0) layer = "call";
		else if (roleProvider !== void 0 || roleModel !== void 0) layer = "role";
		else layer = "default";
	}
	return {
		layer,
		...agentOptions !== void 0 ? { agentOptions } : {},
		...reasoningEffort !== void 0 ? { reasoningEffort } : {},
		...resolvedRoleId !== void 0 ? { roleId: resolvedRoleId } : {},
		...role !== void 0 && !isEmpty$1(role.persona) ? { persona: role.persona } : {},
		...role !== void 0 && role.toolFilter !== void 0 ? { toolFilter: role.toolFilter } : {},
		warnings
	};
}
//#endregion
//#region src/delegation-tool.ts
function isEmpty(value) {
	return value === void 0 || value === null || value === "";
}
function stopReasonError(result) {
	switch (result.stopReason) {
		case "completed": return;
		case "aborted": return "subagent run was cancelled";
		case "error": return "subagent run failed";
		case "max-tokens": return "subagent run hit its token limit before finishing";
		case "refusal": return "subagent declined the task";
		default: return "subagent run ended abnormally (" + String(result.stopReason) + ")";
	}
}
function withPartialText(error, output) {
	const text = output.filter((block) => block.type === "text").map((block) => block.text).join("");
	return text.length === 0 ? error : error + "\nPartial output before the run ended:\n" + text;
}
async function settleForegroundRun(run) {
	try {
		const result = await run.result;
		const error = stopReasonError(result);
		if (error !== void 0) throw new Error(withPartialText(error, result.output));
		run.dispose();
		return {
			kind: "foreground",
			runId: String(run.id),
			output: result.output
		};
	} catch (err) {
		run.dispose();
		throw err;
	}
}
async function settleBackgroundRun(start, signal) {
	try {
		return await settleRun(await start);
	} catch (error) {
		return signal.aborted ? { status: "killed" } : {
			status: "failed",
			detail: String(error)
		};
	}
}
function isProviderRoutable(ctx, provider) {
	const llm = ctx.get("llm");
	if (llm === void 0) return true;
	return llm.listProviders().some((entry) => entry.id === provider);
}
function invalidProviderError(provider, available) {
	const list = available.length > 0 ? available.join(", ") : "(none)";
	return /* @__PURE__ */ new Error("dsh-subagent-pro: LLM provider route " + provider + " is not routable (no adapter serves it). Available providers: " + list);
}
function buildSubagentRequest(parts) {
	return {
		label: parts.description,
		prompt: parts.prompt,
		parent: parts.parent,
		...parts.agentOptions !== void 0 ? { agentOptions: parts.agentOptions } : {},
		...parts.persona !== void 0 ? { persona: parts.persona } : {},
		...parts.toolFilter !== void 0 ? { toolFilter: parts.toolFilter } : {},
		...parts.maxDepth !== void 0 ? { maxDepth: parts.maxDepth } : {}
	};
}
/** Strip .md suffix from a file basename (path string ops only). */
function roleFileId(filePath) {
	let last = 0;
	for (let i = filePath.length - 1; i >= 0; i--) {
		const ch = filePath.charCodeAt(i);
		if (ch === 47 || ch === 92) {
			last = i + 1;
			break;
		}
	}
	const base = filePath.slice(last);
	return base.endsWith(".md") ? base.slice(0, -3) : base;
}
function createDelegationTool(opts) {
	const { ctx, config, provider, getSettings, getRoles } = opts;
	const backgroundEnabled = config.enableRunInBackground !== false;
	const continuable = (config.backgroundMode ?? "one-shot") === "continuable";
	const toolName = config.toolName ?? "subagent_role";
	const providerName = config.subagentProvider ?? "spawn";
	const lookup = {
		byId: (id) => {
			for (const r of getRoles()) if ((r.source === "project-md" || r.source === "global-md") && r.filePath !== void 0) {
				if (roleFileId(r.filePath) === id) return r;
			}
			return (getSettings().roles ?? {})[id];
		},
		byDisplayName: (name) => {
			for (const r of getRoles()) {
				if (r.displayName !== name) continue;
				if ((r.source === "project-md" || r.source === "global-md") && r.filePath !== void 0) {
					const rid = roleFileId(r.filePath);
					if (rid !== "") return {
						id: rid,
						role: r
					};
				} else {
					const settings = getSettings().roles ?? {};
					for (const [k, v] of Object.entries(settings)) if (v?.displayName === name) return {
						id: k,
						role: r
					};
				}
			}
			const settings = getSettings().roles ?? {};
			for (const [id, role] of Object.entries(settings)) if (role?.displayName === name) return {
				id,
				role
			};
		}
	};
	return defineTool({
		name: toolName,
		description: "Delegate a self-contained task to a role-bound subagent with an optional LLM route (provider/model) override. Resolves the model through configure > role > default > inherit; role persona and tool filtering are applied when supported. " + (backgroundEnabled ? continuable ? " This tool runs in the background by default, immediately returns a durable subagent id, and keeps the child conversation available for later turns. When that run settles, the runtime sends the parent a notice containing its outcome and any final assistant message; send_message starts a later turn in the same child conversation. Set run_in_background: false only when your next action depends on receiving the result." : " This call waits for the result by default. Set run_in_background: true to return a job id; collect with job_output and stop with job_kill." : " This call waits for the subagent and returns its result."),
		parameters: {
			description: {
				type: "string",
				required: true,
				description: "A short (3-5 word) description of the delegated task, for display."
			},
			prompt: {
				type: "string",
				required: true,
				description: "The complete, self-contained task for the subagent. It does not share this conversation's context, so include everything it needs."
			},
			role: {
				type: "string",
				description: "Role template id (optional). Falls back to the configured default role when unset."
			},
			provider: {
				type: "string",
				description: "LLM provider route override (optional). Explicit provider/model win over a role binding. Must match a route with a registered adapter."
			},
			model: {
				type: "string",
				description: "Model id override (optional). Explicit provider/model win over a role binding."
			},
			reasoningEffort: {
				type: "string",
				description: "Reasoning-effort override (optional). Adapter serving the route decides support."
			},
			...backgroundEnabled ? { run_in_background: {
				type: "boolean",
				description: continuable ? "Whether to run in the background and return a durable subagent id immediately. Defaults to true. Set false to wait for the result when your next action depends on it." : "Whether to run as a background job and return its id. Defaults to false; collect with job_output or stop with job_kill."
			} } : {}
		},
		output: {
			schema: { oneOf: [
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "background"
						},
						jobId: {
							type: "string",
							required: true
						}
					}
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "continuable"
						},
						subagentId: {
							type: "string",
							required: true
						}
					}
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "foreground"
						},
						runId: {
							type: "string",
							required: true
						},
						output: {
							type: "array",
							required: true,
							items: { type: "json" }
						}
					}
				}
			] },
			render: (_args, value) => [{
				type: "text",
				text: value.kind === "background" ? "started background " + toolName + " task " + value.jobId : value.kind === "continuable" ? "started subagent " + value.subagentId : value.output.filter((b) => typeof b === "object" && b !== null && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("")
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			const parent = exec.agent;
			if (!parent) throw new Error("dsh-subagent-pro: tool requires a calling agent (exec.agent was undefined)");
			const settings = getSettings();
			const route = resolveRoute({
				args,
				settings,
				parent: parent.options
			}, lookup);
			const warnings = [...route.warnings];
			ctx.logger.info("[dsh-subagent-pro] DIAG: parentOptions=" + JSON.stringify(parent.options) + " settings=" + JSON.stringify(settings) + " args.provider=" + JSON.stringify(args.provider) + " args.model=" + JSON.stringify(args.model));
			ctx.logger.info("[dsh-subagent-pro] delegate layer=" + route.layer + " mode=" + (continuable ? "continuable" : "one-shot") + " transport=" + providerName + " route=" + JSON.stringify(route.agentOptions ?? null) + " reasoningEffort=" + JSON.stringify(route.reasoningEffort) + " persona=" + (route.persona ? "yes" : "no") + " warnings=" + JSON.stringify(warnings));
			const explicitProvider = isEmpty(args.provider) ? void 0 : args.provider;
			if (explicitProvider !== void 0 && !isProviderRoutable(ctx, explicitProvider)) {
				const llm = ctx.get("llm");
				throw invalidProviderError(explicitProvider, llm === void 0 ? [] : llm.listProviders().map((e) => e.id));
			}
			let agentOptions = route.agentOptions;
			const routeProvider = agentOptions?.provider;
			if (routeProvider !== void 0 && explicitProvider === void 0 && !isProviderRoutable(ctx, routeProvider)) {
				if (settings.fallbackOnInvalid !== false) {
					agentOptions = void 0;
					warnings.push("dsh-subagent-pro: role/default provider " + routeProvider + " is not routable; fell back to the parent model (fallbackOnInvalid: true)");
					ctx.logger.warn("[dsh-subagent-pro] fell back to parent model for un-routable provider " + routeProvider);
				} else {
					const llm = ctx.get("llm");
					throw invalidProviderError(routeProvider, llm === void 0 ? [] : llm.listProviders().map((e) => e.id));
				}
			}
			const maxDepth = typeof config.maxDepth === "number" ? config.maxDepth : void 0;
			if (route.persona !== void 0 && !provider.capabilities.persona) throw new Error("dsh-subagent-pro: role binds a persona but transport provider \"" + providerName + "\" does not support the persona capability — switch the subagent provider or drop the role persona");
			if (route.toolFilter !== void 0 && !provider.capabilities.toolFilter) throw new Error("dsh-subagent-pro: role binds a tool filter but transport provider \"" + providerName + "\" does not support the toolFilter capability — switch the subagent provider or drop the role filter");
			if (typeof maxDepth === "number" && !provider.capabilities.depthLimit) throw new Error("dsh-subagent-pro: transport provider \"" + providerName + "\" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: \"provider-managed\" to leave the recursion budget to the provider");
			if (route.reasoningEffort !== void 0) ctx.logger.info("[dsh-subagent-pro] reasoningEffort=" + route.reasoningEffort + " is advisory and logged only (not injectable via AgentOptions)");
			const request = buildSubagentRequest({
				description: args.description,
				prompt: [{
					type: "text",
					text: args.prompt
				}],
				parent,
				agentOptions,
				persona: route.persona,
				toolFilter: route.toolFilter,
				maxDepth
			});
			const runInBackground = backgroundEnabled ? args.run_in_background ?? continuable : false;
			const ctxEvents = ctx.events;
			const emitRoute = (payload) => {
				if (ctxEvents === void 0) return;
				const callbacks = ctxEvents.dispatch("emit", ["dsh-subagent-pro/run-route", payload]);
				for (const cb of callbacks) cb(payload);
			};
			const routeSnapshot = {
				childId: "",
				provider: route.agentOptions?.provider,
				model: route.agentOptions?.model,
				reasoningEffort: route.reasoningEffort
			};
			if (runInBackground && continuable) {
				if (provider.prepareContinuable === void 0) throw new Error("dsh-subagent-pro: transport provider \"" + providerName + "\" does not support backgroundMode: continuable — switch the subagent provider or use backgroundMode: \"one-shot\"");
				const start = await ctx.subagents.startContinuable({
					provider: providerName,
					label: args.description,
					request,
					signal: exec.signal
				});
				emitRoute({
					...routeSnapshot,
					childId: String(start.childId)
				});
				return {
					kind: "continuable",
					subagentId: start.childId
				};
			}
			if (runInBackground) {
				const jobs = ctx.get("jobs");
				if (jobs === void 0) throw new Error("dsh-subagent-pro: background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs");
				return {
					kind: "background",
					jobId: jobs.start({
						kind: "subagent",
						label: args.description,
						owner: parent,
						run: () => {
							const controller = new AbortController();
							return {
								cancel: (reason) => controller.abort(reason ?? "background subagent task killed"),
								done: (async () => {
									const sub = await ctx.subagents.start(providerName, {
										...request,
										signal: controller.signal
									});
									emitRoute({
										...routeSnapshot,
										childId: String(sub.id)
									});
									return settleBackgroundRun(Promise.resolve(sub), controller.signal);
								})()
							};
						}
					})
				};
			}
			const foregroundSub = await ctx.subagents.start(providerName, {
				...request,
				signal: exec.signal
			});
			emitRoute({
				...routeSnapshot,
				childId: String(foregroundSub.id)
			});
			return settleForegroundRun(foregroundSub);
		}
	});
}
//#endregion
//#region src/agents-md.ts
/**
* Agent md loader — Claude Code style .md subagent definitions.
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
/** Strip .md suffix from a file basename (uses lastSegment + stripMdExt). */
function fileIdFromPath(filePath) {
	return stripMdExt(lastSegment(filePath));
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
function loadAgentMdRoles(globalDir, projectDirName) {
	const resolveProjectDir = (cwd) => {
		if (cwd === void 0 || cwd === "") return void 0;
		return join(cwd, projectDirName);
	};
	const load = (cwd) => {
		const globalScan = scanDir(globalDir, "global-md");
		const projectScan = scanDir(resolveProjectDir(cwd), "project-md");
		const byId = /* @__PURE__ */ new Map();
		for (const r of globalScan.roles) byId.set(r.filePath ?? "", r);
		for (const r of projectScan.roles) byId.set(r.filePath ?? "", r);
		return {
			roles: [...byId.values()],
			warnings: [...globalScan.warnings, ...projectScan.warnings]
		};
	};
	return {
		globalDir,
		projectDirName,
		resolveProjectDir,
		load
	};
}
function refreshAgentMdRoles(handle, _globalDir, _projectDirName, cwd) {
	const globalScan = scanDir(handle.globalDir, "global-md");
	const projectScan = scanDir(handle.resolveProjectDir(cwd), "project-md");
	const byId = /* @__PURE__ */ new Map();
	for (const r of globalScan.roles) byId.set(r.filePath ?? "", r);
	for (const r of projectScan.roles) byId.set(r.filePath ?? "", r);
	return {
		roles: [...byId.values()],
		warnings: [...globalScan.warnings, ...projectScan.warnings]
	};
}
/** Stable, unique section name (configuration changes only affect new assemblies). */
const GUIDANCE_SECTION_NAME = "dsh-subagent-pro:roles";
/** Compute the role id used by the resolver (file basename for md roles; settings key for settings). */
function roleIdFor(role) {
	if (role.source === "settings") return "";
	return role.filePath !== void 0 ? fileIdFromPath(role.filePath) : "";
}
function renderRolesGuidance(resolved, toolName) {
	const roles = resolved.getRoles();
	if (roles.length === 0) return "";
	const lines = ["Subagent Pro roles — delegate one of these role-bound subagents when the task matches its description. Each role may bind a model; when it does, the subagent runs on that model route.", "Reference roles by their id (the kebab-case file name or settings.roles key); the model can also reference roles by their displayName and the resolver will map it."];
	for (const role of roles) {
		const id = roleIdFor(role);
		const bound = role.provider !== void 0 && role.provider !== "" ? role.model !== void 0 && role.model !== "" ? " (model: " + role.provider + "/" + role.model + ")" : " (provider: " + role.provider + ")" : "";
		const src = role.source === "project-md" ? " · project-md" : role.source === "global-md" ? " · global-md" : " · settings";
		const idText = id !== "" ? " [" + id + "]" : "";
		lines.push("- " + role.displayName + idText + bound + src + ": " + role.description);
		if (id !== "") lines.push("    Delegate with: " + toolName + "({ role: \"" + id + "\", prompt: \"...\" })");
		else lines.push("    (this role is defined in settings; use its settings key as the role argument)");
	}
	return lines.join("\n");
}
function applyGuidance(ctx, resolvedFactory, toolName) {
	const systemPrompt = ctx.get("systemPrompt");
	if (systemPrompt === void 0) {
		ctx.logger?.debug?.("[dsh-subagent-pro] systemPrompt not mounted; skipping role guidance section");
		return;
	}
	return systemPrompt.section({
		name: GUIDANCE_SECTION_NAME,
		order: 117,
		text: () => renderRolesGuidance(resolvedFactory(), toolName)
	});
}
//#endregion
//#region src/llm-info-tool.ts
function emptyProviders() {
	return {
		kind: "providers",
		providers: []
	};
}
function emptyModels(provider) {
	return {
		kind: "models",
		provider,
		models: []
	};
}
function emptyReasoning(provider, model) {
	return {
		kind: "reasoning",
		provider,
		model,
		efforts: []
	};
}
/**
* Map a raw provider descriptor to the public ProviderEntry shape. Falls back
* to the id when the service omits a display name (forward-compat for adapters
* that only ship an id).
*/
function toProviderEntry(raw) {
	return {
		id: raw.id,
		name: raw.name ?? raw.id
	};
}
function toModelEntry(raw) {
	return {
		id: raw.id,
		name: raw.name ?? raw.id
	};
}
function toEffortEntry(raw) {
	return {
		id: raw.id,
		name: raw.name ?? raw.id
	};
}
/**
* Validate the action/params contract. Centralized so tests can exercise it
* without spinning up a real `llm` service.
*/
function validateLlmInfoArgs(args) {
	switch (args.action) {
		case "list_providers": return;
		case "list_models":
			if (typeof args.provider !== "string" || args.provider === "") return "dsh-subagent-pro: action \"list_models\" requires a non-empty \"provider\" argument";
			return;
		case "list_reasoning_efforts":
			if (typeof args.provider !== "string" || args.provider === "") return "dsh-subagent-pro: action \"list_reasoning_efforts\" requires a non-empty \"provider\" argument";
			if (typeof args.model !== "string" || args.model === "") return "dsh-subagent-pro: action \"list_reasoning_efforts\" requires a non-empty \"model\" argument";
			return;
		default: return "dsh-subagent-pro: unknown action \"" + String(args.action) + "\" — expected one of: list_providers, list_models, list_reasoning_efforts";
	}
}
/** Resolve the llm service from a context, returning undefined when absent. */
function getLlmInfoService(ctx) {
	const raw = ctx.get("llm");
	if (raw === void 0 || raw === null) return void 0;
	const candidate = raw;
	if (typeof candidate.listProviders !== "function" || typeof candidate.listModels !== "function" || typeof candidate.resolveModelInfo !== "function") return;
	return candidate;
}
function createLlmInfoTool(opts) {
	const { ctx } = opts;
	const toolName = opts.toolName ?? "subagent_providers";
	return defineTool({
		name: toolName,
		description: "Discover routable LLM providers, models, and reasoning-effort levels available to the host `llm` service. Use `action: \"list_providers\"` to enumerate providers; `action: \"list_models\"` (requires `provider`) to enumerate models under a provider; `action: \"list_reasoning_efforts\"` (requires `provider` + `model`) to enumerate supported reasoning-effort levels and the model default. Tolerates a missing `llm` service: returns an empty result rather than throwing.",
		parameters: {
			action: {
				type: "string",
				required: true,
				enum: [
					"list_providers",
					"list_models",
					"list_reasoning_efforts"
				],
				description: "Which info slice to fetch. \"list_providers\" enumerates providers; \"list_models\" requires a provider; \"list_reasoning_efforts\" requires both provider and model."
			},
			provider: {
				type: "string",
				description: "Provider id (required for list_models and list_reasoning_efforts)."
			},
			model: {
				type: "string",
				description: "Model id (required for list_reasoning_efforts)."
			}
		},
		output: {
			schema: { oneOf: [
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "providers"
						},
						providers: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									id: {
										type: "string",
										required: true
									},
									name: {
										type: "string",
										required: true
									}
								}
							}
						}
					}
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "models"
						},
						provider: {
							type: "string",
							required: true
						},
						models: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									id: {
										type: "string",
										required: true
									},
									name: {
										type: "string",
										required: true
									}
								}
							}
						}
					}
				},
				{
					type: "object",
					additionalProperties: false,
					properties: {
						kind: {
							type: "string",
							required: true,
							const: "reasoning"
						},
						provider: {
							type: "string",
							required: true
						},
						model: {
							type: "string",
							required: true
						},
						efforts: {
							type: "array",
							required: true,
							items: {
								type: "object",
								additionalProperties: false,
								properties: {
									id: {
										type: "string",
										required: true
									},
									name: {
										type: "string",
										required: true
									}
								}
							}
						},
						defaultEffort: { type: "string" }
					}
				}
			] },
			render: (_args, value) => {
				let text;
				switch (value.kind) {
					case "providers":
						text = value.providers.length === 0 ? "no providers available" : value.providers.map((p) => p.id + (p.name === p.id ? "" : " (" + p.name + ")")).join(", ");
						break;
					case "models":
						text = value.models.length === 0 ? "no models under provider " + value.provider : value.models.map((m) => m.id + (m.name === m.id ? "" : " (" + m.name + ")")).join(", ");
						break;
					case "reasoning": {
						const effortList = value.efforts.length === 0 ? "no reasoning efforts" : value.efforts.map((e) => e.id + (e.name === e.id ? "" : " (" + e.name + ")")).join(", ");
						text = value.provider + "/" + value.model + ": efforts=[" + effortList + "] default=" + (value.defaultEffort ?? "(none)");
						break;
					}
				}
				return [{
					type: "text",
					text
				}];
			}
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			const validation = validateLlmInfoArgs(args);
			if (validation !== void 0) throw new Error(validation);
			const llm = getLlmInfoService(ctx);
			if (llm === void 0) {
				if (args.action === "list_providers") return emptyProviders();
				if (args.action === "list_models") return emptyModels(args.provider ?? "");
				return emptyReasoning(args.provider ?? "", args.model ?? "");
			}
			ctx.logger?.info?.("[dsh-subagent-pro] action=" + args.action + " provider=" + (args.provider ?? "") + " model=" + (args.model ?? ""));
			if (args.action === "list_providers") return {
				kind: "providers",
				providers: llm.listProviders().map(toProviderEntry)
			};
			if (args.action === "list_models") {
				const provider = args.provider;
				return {
					kind: "models",
					provider,
					models: (await llm.listModels(provider)).map(toModelEntry)
				};
			}
			const provider = args.provider;
			const model = args.model;
			const resolved = await llm.resolveModelInfo(provider, model);
			const efforts = (resolved.reasoning?.efforts ?? []).map(toEffortEntry);
			const reasoning = resolved.reasoning;
			return {
				kind: "reasoning",
				provider,
				model,
				efforts,
				...reasoning?.defaultEffort !== void 0 ? { defaultEffort: reasoning.defaultEffort } : {}
			};
		}
	});
}
//#endregion
//#region src/roles.ts
function mountRoles(ctx, config, resolved, _agentMd) {
	const backgroundMode = config.backgroundMode ?? "one-shot";
	const toolName = config.toolName ?? "subagent_role";
	const providerName = config.subagentProvider ?? "spawn";
	if (config.applyDefaultRoute !== false) {
		const seamCtx = ctx;
		ctx.effect(() => applyDefaultRouteSeam(seamCtx, () => {
			const s = resolved.get();
			return {
				...s.defaultProvider !== void 0 && s.defaultProvider !== "" ? { defaultProvider: s.defaultProvider } : {},
				...s.defaultModel !== void 0 && s.defaultModel !== "" ? { defaultModel: s.defaultModel } : {},
				fallbackOnInvalid: s.fallbackOnInvalid === false ? false : true
			};
		}), "dsh-subagent-pro: default-route-seam");
	}
	applyGuidance(ctx, () => resolved, toolName);
	const infoToolName = config.infoToolName ?? "subagent_providers";
	if (config.enableLlmInfoTool !== false) {
		ctx.logger.info("[dsh-subagent-pro] registering " + infoToolName + " on host llm service");
		const infoTool = createLlmInfoTool({
			ctx,
			toolName: infoToolName
		});
		ctx.tools.register(infoTool);
	}
	if (typeof config.maxDepth === "number") assertSubagentMaxDepth(config.maxDepth);
	let disposeTool;
	const mount = (provider) => {
		if (typeof config.maxDepth === "number" && !provider.capabilities.depthLimit) throw new Error("dsh-subagent-pro: provider \"" + provider.name + "\" cannot enforce maxDepth (no depthLimit capability) — set maxDepth: \"provider-managed\"");
		if (backgroundMode === "continuable" && provider.prepareContinuable === void 0) throw new Error("dsh-subagent-pro: provider \"" + provider.name + "\" does not support backgroundMode: continuable — switch the subagent provider or use backgroundMode: \"one-shot\"");
		ctx.logger.info("[dsh-subagent-pro] registering " + toolName + " on subagent transport \"" + providerName + "\" with backgroundMode \"" + backgroundMode + "\"");
		const tool = createDelegationTool({
			ctx,
			config,
			provider,
			getSettings: resolved.get,
			getRoles: resolved.getRoles
		});
		disposeTool = ctx.tools.register(tool);
	};
	const cordisCtx = ctx;
	cordisCtx.on("subagent/provider-added", (provider) => {
		if (provider.name === providerName && disposeTool === void 0) mount(provider);
	});
	cordisCtx.on("subagent/provider-removed", (name2) => {
		if (name2 !== providerName || disposeTool === void 0) return;
		disposeTool();
		disposeTool = void 0;
	});
	const present = ctx.subagents.getProvider(providerName);
	if (present !== void 0) mount(present);
	else ctx.logger.info("[dsh-subagent-pro] subagent provider \"" + providerName + "\" not registered yet; the \"" + toolName + "\" tool will register when it appears");
}
//#endregion
//#region src/settings.ts
/**
* Subagent Pro settings — namespace, schema, validation, and live snapshot.
*
* Inherited verbatim from dsh-plugin-subagent-director (settings.ts + route-resolver.ts):
*   - kebab-case role ids, non-empty displayName/description,
*   - defaultRole references an existing role,
*   - 4-layer fallback: call > role > default > inherit.
*
* The merger (resolved.getRoles()) layers in:
*   project agent md > global agent md > settings.roles (UI/调试沙盒)
*
* Live updates: installSettingsSection hands us a `setSource` getter at
* register time. The getter resolves to the current registered value on every
* call (settings.yaml hot reload + UI writes both flow through it). We store
* the getter and call it on every read so live edits are visible without an
* additional event subscription — same pattern as dsh-agent-default-model
* (dsh-agent-default-model/lib/index.js:45-50). Do NOT add a `settings/change`
* listener here: that event name does not exist (the real name is
* `settings/updated`, see dsh-settings/lib/types/types.d.ts:31).
*/
/** Settings namespace id (kebab-case; matches cordis.patch.yml entry id). */
const SUBAGENT_PRO_SETTINGS_NAMESPACE = "subagent-pro";
/**
* Permissive schemastery schema for the subagent-pro namespace. Schemastery
* makes all object fields optional by default; `.loose()` opts out of strict
* key checks so future plugin versions writing new fields don't get rejected
* by older plugin builds.
*/
const SubagentProSettingsSchema = z.object({}).loose();
function createSettingsSnapshot(initial) {
	let source;
	let snapshot = initial;
	return {
		hooks: {
			setSource(getter) {
				source = getter;
				snapshot = getter();
			},
			onChange() {
				if (source !== void 0) snapshot = source();
			}
		},
		get() {
			return snapshot;
		}
	};
}
function resolveSettings(ctx, config) {
	const globalAgentDir = config.globalAgentDir ?? homedir() + "/.dsh/agents";
	const projectAgentDirName = config.projectAgentDirName ?? ".dsh/agents";
	let mdLayer = [];
	let warnings = [];
	const computeMerged = (base) => {
		const out = [];
		for (const r of mdLayer) out.push(r);
		for (const [id, role] of Object.entries(base.roles ?? {})) {
			if (role === void 0) continue;
			out.push({
				...role,
				source: "settings",
				filePath: "settings:" + id
			});
		}
		return out;
	};
	const snapshot = createSettingsSnapshot({});
	installSubagentProSettings(ctx, {}, snapshot.hooks);
	return {
		get: () => snapshot.get(),
		getRoles: () => computeMerged(snapshot.get()),
		setMdRoles: (roles, w) => {
			mdLayer = roles;
			warnings = w;
		},
		getWarnings: () => warnings,
		globalAgentDir,
		projectAgentDirName
	};
}
/**
* Install the `subagent-pro` settings namespace into the host settings service.
*
* No-op if the deployment has no settings service mounted (e.g. headless profile
* without dsh-settings-file). After this call, ctx.settings.describe() lists
* `subagent-pro` and our bridge endpoint at /api/dsh-subagent-pro/settings can
* read/write it.
*
* Follows the dsh-plugin-subagent-director pattern: installSettingsSection
* captures the live SettingsScope.get() getter via `hooks.setSource(...)` and
* fires `hooks.onChange()` after each commit. Our SettingsSnapshot wires
* those hooks directly so consumer getters always see the latest value.
*/
function installSubagentProSettings(ctx, entry = {}, hooks) {
	if (ctx.get("settings") === void 0) return;
	try {
		installSettingsSection(ctx, SUBAGENT_PRO_SETTINGS_NAMESPACE, SubagentProSettingsSchema, entry, hooks);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!/already (declared|registered)/i.test(message)) throw err;
	}
}
//#endregion
//#region src/index.ts
const name = "dsh-subagent-pro";
const inject = [
	"webServer",
	"sessions",
	"subagents",
	"tools",
	"llm",
	"settings",
	"systemPrompt",
	"jobs",
	"shell"
];
function apply(ctx, config = {}) {
	const resolved = resolveSettings(ctx, config);
	const agentMd = loadAgentMdRoles(resolved.globalAgentDir, resolved.projectAgentDirName);
	const reloadMd = () => {
		const cwd = ctx.get("shell")?.cwd;
		const merged = refreshAgentMdRoles(agentMd, resolved.globalAgentDir, resolved.projectAgentDirName, cwd);
		resolved.setMdRoles(merged.roles, merged.warnings);
	};
	reloadMd();
	ctx.on("settings/updated", (ns) => {
		if (ns !== "subagent-pro") return;
		reloadMd();
	});
	mountMonitor(ctx, resolved);
	mountRoles(ctx, config, resolved, agentMd);
}
//#endregion
export { apply, inject, name };
