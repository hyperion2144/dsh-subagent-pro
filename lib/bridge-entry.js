//#region src/bridge-entry.ts
const name = "dsh-subagent-pro-bridge";
const inject = [
	"webServer",
	"settings",
	"llm"
];
const NS = "subagent-pro";
const PREFIX = "/api/dsh-subagent-pro/settings";
const LLM_PREFIX = "/api/dsh-subagent-pro/llm";
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
}
//#endregion
export { apply, inject, name };
