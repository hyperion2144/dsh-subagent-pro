window.__ModuleLoader__.load({
	id: "dsh-subagent-pro",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/store.ts
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
		const listeners = /* @__PURE__ */ new Set();
		let state = {
			sessionId: void 0,
			now: Date.now(),
			rows: [],
			open: false,
			minimized: false,
			hidden: [],
			lastError: void 0
		};
		let autoOpened = false;
		let polling = false;
		const commit = (patch) => {
			state = {
				...state,
				...patch
			};
			for (const listener of [...listeners]) listener();
		};
		const subscribe = (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		};
		const getSnapshot = () => state;
		const useStore = () => (0, react.useSyncExternalStore)(subscribe, getSnapshot);
		/** Imperative commit; components call this from effects and handlers. */
		const dispatch = (patch) => commit(patch);
		async function refreshSnapshot(sessionId) {
			try {
				const data = await (await fetch("/api/dsh-subagent-pro/snapshot?sessionId=" + encodeURIComponent(sessionId))).json();
				if (data.sessionId !== state.sessionId) return;
				commit({
					rows: data.rows ?? [],
					now: data.now ?? Date.now(),
					lastError: void 0
				});
			} catch (err) {
				commit({ lastError: err instanceof Error ? err.message : String(err) });
			}
		}
		/**
		* Start polling for the given sessionId. Idempotent: a single 1-second interval
		* runs per page, regardless of how many components call this.
		*/
		function ensurePolling(sessionId) {
			if (state.sessionId !== sessionId) commit({ sessionId });
			if (polling) return;
			polling = true;
			refreshSnapshot(sessionId);
			const timer = window.setInterval(() => {
				const sid = state.sessionId;
				if (sid !== void 0) refreshSnapshot(sid);
			}, 1e3);
			pollDisposer = () => {
				window.clearInterval(timer);
				polling = false;
			};
		}
		let pollDisposer;
		/** Open the panel automatically on first mount (desktop only). */
		function autoOpenIfDesktop() {
			if (autoOpened) return;
			autoOpened = true;
			if (!window.matchMedia("(max-width: 768px)").matches) commit({ open: true });
		}
		let sessionsSvc;
		let rolesSvc;
		function setSessionsService(service) {
			sessionsSvc = service;
		}
		function getSessionsService() {
			return sessionsSvc;
		}
		function setRolesService(service) {
			rolesSvc = service;
		}
		function getRolesService() {
			return rolesSvc;
		}
		//#endregion
		//#region src/client/panel.tsx
		/**
		* Subagent Pro — floating panel.
		*
		* Ported from @leetoners/dsh-ui-subagent-monitor's panel.tsx (status dots,
		* drag/resize, hide rows, clear completed, open child session). The trigger
		* button is now the HUD-style icon button in conversation.input.left; this
		* panel only mounts in `shell.overlay`.
		*/
		const CHASE_CELLS = [
			[0, 0],
			[4, 0],
			[8, 0],
			[8, 4],
			[8, 8],
			[4, 8],
			[0, 8],
			[0, 4]
		];
		const UNKNOWN = {
			cls: "dsp-dot-off",
			label: "已结束"
		};
		const STATUS = {
			running: {
				cls: "dsp-dot-running",
				label: "运行中"
			},
			completed: {
				cls: "dsp-dot-ok",
				label: "完成"
			},
			error: {
				cls: "dsp-dot-error",
				label: "失败"
			},
			aborted: {
				cls: "dsp-dot-warn",
				label: "已打断"
			},
			"max-tokens": {
				cls: "dsp-dot-warn",
				label: "令牌上限"
			},
			refusal: {
				cls: "dsp-dot-warn",
				label: "已拒绝"
			}
		};
		function StatusDot({ status }) {
			if (status === "running") return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("svg", {
				className: "dsp-dot dsp-dot-running",
				width: 10,
				height: 10,
				viewBox: "0 0 10 10",
				shapeRendering: "crispEdges",
				"aria-hidden": "true",
				children: CHASE_CELLS.map(([x, y], index) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					className: "dsp-dot-cell",
					x,
					y,
					width: "2",
					height: "2",
					style: { animationDelay: (index - CHASE_CELLS.length) * 125 + "ms" }
				}, x + "-" + y))
			});
			const meta = STATUS[status] ?? UNKNOWN;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: "dsp-dot " + meta.cls,
				"aria-hidden": "true"
			});
		}
		function fmtDuration(start, end) {
			if (start === void 0) return "—";
			const ms = (end ?? Date.now()) - start;
			if (ms < 0) return "00:00";
			const s = Math.floor(ms / 1e3);
			const h = Math.floor(s / 3600);
			const m = Math.floor(s % 3600 / 60);
			const sec = s % 60;
			const pad = (n) => String(n).padStart(2, "0");
			return h > 0 ? h + ":" + pad(m) + ":" + pad(sec) : pad(m) + ":" + pad(sec);
		}
		const shortId = (id) => id === void 0 || id.length <= 8 ? id ?? "—" : id.slice(0, 8);
		function rowLabel(row) {
			if (typeof row.label === "string" && row.label !== "") return row.label;
			if (typeof row.provider === "string" && row.provider !== "") return "[" + row.provider + "] 子代理";
			return "子代理 " + shortId(row.id);
		}
		const POSITION_KEY = "dsh-subagent-pro.panel-position.v1";
		const HEIGHT_KEY_PREFIX = "dsh-subagent-pro.panel-height.v2.";
		const DEFAULT_TOP = 80;
		const EDGE = 8;
		const MIN_HEIGHT = 160;
		const heights = /* @__PURE__ */ new Map();
		let heightKey = "";
		let layout = {
			left: null,
			top: null,
			height: null
		};
		let positionLoaded = false;
		function loadPosition() {
			if (positionLoaded) return;
			positionLoaded = true;
			try {
				const raw = window.localStorage.getItem(POSITION_KEY);
				if (raw !== null) {
					const parsed = JSON.parse(raw);
					if (typeof parsed.left === "number" && Number.isFinite(parsed.left)) layout.left = parsed.left;
					if (typeof parsed.top === "number" && Number.isFinite(parsed.top)) layout.top = parsed.top;
					if (layout.left === null || layout.top === null) {
						layout.left = null;
						layout.top = null;
					}
				}
			} catch {}
		}
		function bindHeight(sessionId) {
			const key = sessionId ?? "__global__";
			if (key === heightKey) return;
			heightKey = key;
			const cached = heights.get(key);
			if (cached !== void 0) {
				layout.height = cached;
				clampLayout();
				return;
			}
			let h = null;
			try {
				const raw = window.localStorage.getItem(HEIGHT_KEY_PREFIX + key);
				if (raw !== null) {
					const parsed = JSON.parse(raw);
					if (typeof parsed.height === "number" && Number.isFinite(parsed.height)) h = parsed.height;
				}
			} catch {}
			heights.set(key, h);
			layout.height = h;
			clampLayout();
		}
		function savePosition() {
			try {
				window.localStorage.setItem(POSITION_KEY, JSON.stringify({
					left: layout.left,
					top: layout.top
				}));
			} catch {}
		}
		function saveHeight() {
			try {
				window.localStorage.setItem(HEIGHT_KEY_PREFIX + heightKey, JSON.stringify({ height: layout.height }));
			} catch {}
		}
		function clampLayout() {
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			if (layout.left !== null) layout.left = Math.min(Math.max(EDGE, layout.left), Math.max(EDGE, vw - 60));
			if (layout.top !== null) layout.top = Math.min(Math.max(EDGE, layout.top), Math.max(EDGE, vh - 60));
			if (layout.height !== null) {
				const top = layout.top ?? DEFAULT_TOP;
				layout.height = Math.min(Math.max(MIN_HEIGHT, layout.height), Math.max(MIN_HEIGHT, vh - top - 16));
			}
		}
		function applyLayoutStyle(el, minimized = false) {
			if (layout.left !== null && layout.top !== null) {
				el.style.left = layout.left + "px";
				el.style.top = layout.top + "px";
				el.style.right = "auto";
			} else {
				el.style.left = "auto";
				el.style.top = "80px";
				el.style.right = "16px";
			}
			if (layout.height !== null && !minimized) {
				el.style.height = layout.height + "px";
				el.style.maxHeight = "none";
			} else {
				el.style.height = "";
				el.style.maxHeight = "";
			}
		}
		function layoutStyle(minimized = false) {
			const style = layout.left !== null && layout.top !== null ? {
				left: layout.left + "px",
				top: layout.top + "px"
			} : {
				top: "80px",
				right: "16px"
			};
			if (layout.height !== null && !minimized) {
				style.height = layout.height + "px";
				style.maxHeight = "none";
			}
			return style;
		}
		function Panel(_props) {
			const store = useStore();
			const sessionsSvc = getSessionsService();
			const panelRef = (0, react.useRef)(null);
			const minimizedRef = (0, react.useRef)(store.minimized);
			minimizedRef.current = store.minimized;
			(0, react.useEffect)(() => {
				clampLayout();
				const onResize = () => {
					clampLayout();
					if (panelRef.current !== null) applyLayoutStyle(panelRef.current, minimizedRef.current);
				};
				window.addEventListener("resize", onResize);
				return () => {
					window.removeEventListener("resize", onResize);
				};
			}, []);
			(0, react.useEffect)(() => {
				if (panelRef.current !== null) applyLayoutStyle(panelRef.current, store.minimized);
			}, [store.minimized]);
			if (!store.open) return null;
			loadPosition();
			bindHeight(store.sessionId);
			const ordered = [...store.rows].sort((a, b) => {
				const ka = a.startedAt ?? a.sortKey ?? Number.NEGATIVE_INFINITY;
				return (b.startedAt ?? b.sortKey ?? Number.NEGATIVE_INFINITY) - ka;
			});
			const running = ordered.filter((row) => row.status === "running").length;
			const visible = ordered.filter((row) => !store.hidden.includes(row.id));
			const done = visible.filter((row) => row.status === "completed").length;
			const failed = visible.filter((row) => row.status === "error" || row.status === "aborted" || row.status === "max-tokens" || row.status === "refusal").length;
			const sessionId = store.sessionId;
			const style = layoutStyle(store.minimized);
			const onMoveGripDown = (event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				const el = panelRef.current;
				if (el === null) return;
				const rect = el.getBoundingClientRect();
				const offX = event.clientX - rect.left;
				const offY = event.clientY - rect.top;
				const move = (ev) => {
					const vw = window.innerWidth;
					const vh = window.innerHeight;
					layout.left = Math.min(Math.max(EDGE, ev.clientX - offX), Math.max(EDGE, vw - rect.width - EDGE));
					layout.top = Math.min(Math.max(EDGE, ev.clientY - offY), Math.max(EDGE, vh - 60));
					applyLayoutStyle(el, store.minimized);
				};
				const end = () => {
					savePosition();
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", end);
					window.removeEventListener("pointercancel", end);
				};
				window.addEventListener("pointermove", move);
				window.addEventListener("pointerup", end);
				window.addEventListener("pointercancel", end);
			};
			const resetPosition = () => {
				layout.left = null;
				layout.top = null;
				savePosition();
				if (panelRef.current !== null) applyLayoutStyle(panelRef.current, store.minimized);
			};
			const onResizeGripDown = (event) => {
				if (event.button !== 0) return;
				event.preventDefault();
				const el = panelRef.current;
				if (el === null) return;
				const rect = el.getBoundingClientRect();
				const startH = rect.height;
				const startTop = rect.top;
				const startY = event.clientY;
				const move = (ev) => {
					const maxH = Math.max(MIN_HEIGHT, window.innerHeight - startTop - 16);
					layout.height = Math.min(Math.max(MIN_HEIGHT, startH + (ev.clientY - startY)), maxH);
					applyLayoutStyle(el);
				};
				const end = () => {
					saveHeight();
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", end);
					window.removeEventListener("pointercancel", end);
				};
				window.addEventListener("pointermove", move);
				window.addEventListener("pointerup", end);
				window.addEventListener("pointercancel", end);
			};
			const resetHeight = () => {
				layout.height = null;
				saveHeight();
				if (panelRef.current !== null) applyLayoutStyle(panelRef.current, store.minimized);
			};
			const openChild = (row) => {
				if (sessionsSvc === void 0 || store.sessionId === void 0 || row.mode === void 0) return;
				sessionsSvc.openSubagent({
					parentSessionId: store.sessionId,
					childSessionId: row.id,
					mode: row.mode
				});
			};
			const header = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsp-panel-header",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsp-grip-v",
						title: "拖动调整位置 · 双击复位",
						"aria-hidden": "true",
						onPointerDown: onMoveGripDown,
						onDoubleClick: resetPosition,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
							className: "dsp-grip-v-icon",
							width: "12",
							height: "12",
							viewBox: "0 0 12 12",
							"aria-hidden": "true",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6 0.8 7.3 3.6H4.7Z" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M6 11.2 4.7 8.4H7.3Z" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M0.8 6 3.6 4.7V7.3Z" }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M11.2 6 8.4 4.7V7.3Z" })
							]
						})
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsp-panel-title",
						children: "子代理面板"
					}),
					running > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsp-panel-running",
						children: running
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dsp-panel-spacer" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						className: "dsp-btn",
						type: "button",
						title: store.minimized ? "展开面板" : "收起面板",
						onClick: () => dispatch({ minimized: !store.minimized }),
						children: store.minimized ? "展开 ▾" : "收起 ▴"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						className: "dsp-btn",
						type: "button",
						title: "关闭",
						onClick: () => dispatch({ open: false }),
						children: "✕"
					})
				]
			});
			if (store.minimized) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsp-panel",
				style,
				ref: panelRef,
				children: header
			});
			const rowsEl = visible.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsp-empty",
				children: sessionId === void 0 ? "尚未选择会话" : "本会话暂无子代理活动"
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "dsp-rows",
				children: visible.map((row) => {
					const meta = STATUS[row.status] ?? UNKNOWN;
					const elapsed = row.status === "running" ? fmtDuration(row.startedAt, store.now) : fmtDuration(row.startedAt, row.endedAt);
					const depth = typeof row.depth === "number" ? row.depth : 1;
					const indent = Math.max(0, depth - 1) * 14;
					const modeText = row.mode === "continuable" ? "连续对话" : row.mode === "one-shot" ? "一次性" : "";
					const metaLine = [
						row.provider,
						modeText,
						shortId(row.id)
					].filter((value) => typeof value === "string" && value !== "").join(" · ");
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-row",
						style: { marginLeft: indent },
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsp-row-main",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(StatusDot, { status: row.status }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsp-row-label",
									title: rowLabel(row),
									children: rowLabel(row)
								}),
								row.mode !== void 0 && sessionsSvc !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "dsp-btn dsp-row-open",
									type: "button",
									onClick: () => openChild(row),
									children: "打开对话"
								}) : null
							]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "dsp-row-foot",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-row-meta",
								children: metaLine !== "" ? metaLine : "\xA0"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-row-time",
								children: row.status === "running" ? elapsed + " · " + meta.label : meta.label + " · " + elapsed
							})]
						})]
					}, row.id);
				})
			});
			const footer = /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsp-panel-footer",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsp-panel-stats",
						children: "运行 " + running + " · 完成 " + done + " · 异常 " + failed
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dsp-panel-spacer" }),
					store.hidden.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						className: "dsp-btn",
						type: "button",
						onClick: () => dispatch({ hidden: [] }),
						children: "显示已隐藏 " + store.hidden.length
					}) : null,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						className: "dsp-btn",
						type: "button",
						onClick: () => {
							const hidden = [...store.hidden];
							for (const row of store.rows) if (row.status !== "running" && !hidden.includes(row.id)) hidden.push(row.id);
							dispatch({ hidden });
						},
						children: "清空已完成"
					})
				]
			});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsp-panel",
				style,
				ref: panelRef,
				children: [
					header,
					rowsEl,
					footer,
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsp-grip-h",
						title: "拖动调整高度 · 双击复位",
						"aria-hidden": "true",
						onPointerDown: onResizeGripDown,
						onDoubleClick: resetHeight,
						children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dsp-grip-h-bar" })
					})
				]
			});
		}
		//#endregion
		//#region src/client/toggle.tsx
		/**
		* HUD-style toggle button — replaces the monitor's sidebar text button.
		*
		* - Slot: `conversation.input.left` (next to the composer; HUD-style placement).
		* - 28x28 icon button with linear SVG icon (subagent tree/branch motif).
		* - `.is-open` activates warn-yellow background when the panel is open.
		* - Badge in the top-right corner shows running subagent count (HUD-compat).
		* - Title attribute describes current state for accessibility / tooltip.
		*/
		/** Linear SVG icon: a subagent "tree of forks" — root node with two children. */
		function SubagentIcon() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				className: "dsp-toggle-icon",
				width: 14,
				height: 14,
				viewBox: "0 0 16 16",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 1.5,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: 4,
						cy: 3.5,
						r: 1.4
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: 4,
						cy: 12.5,
						r: 1.4
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
						cx: 12,
						cy: 8,
						r: 1.4
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4 4.9 V11.1" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M4 8 H10.6" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5 5.5 C 7 5.5 9 7 10.6 7.3" })
				]
			});
		}
		function Toggle(props) {
			const store = useStore();
			const current = props.useSessions((select) => select.current);
			(0, react.useEffect)(() => {
				if (current === void 0) return;
				if (current !== store.sessionId) dispatch({ sessionId: current });
				ensurePolling(current);
				autoOpenIfDesktop();
			}, [current]);
			const running = store.rows.filter((row) => row.status === "running").length;
			const title = "子代理面板" + (store.open ? "（已打开）" : "") + (running > 0 ? " · 运行中 " + running : "");
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
				type: "button",
				className: "dsp-toggle" + (store.open ? " is-open" : ""),
				onClick: () => dispatch({ open: !store.open }),
				title,
				"aria-label": title,
				"aria-pressed": store.open,
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(SubagentIcon, {}), running > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					className: "dsp-badge",
					children: running
				}) : null]
			});
		}
		//#endregion
		//#region src/client/role-editor.tsx
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
		const NS = "subagent-pro";
		function readSection() {
			const svc = getRolesService();
			if (svc === void 0) return {};
			try {
				const descriptors = svc.describe({ redactSecrets: true });
				for (const d of descriptors) if (d.ns === NS) return d.value ?? {};
			} catch {}
			return {};
		}
		function RoleEditorSection(_props) {
			const svc = getRolesService();
			const [section, setSection] = (0, react.useState)(() => readSection());
			const [savedFlag, setSavedFlag] = (0, react.useState)({});
			const [busy, setBusy] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				const refresh = () => setSection(readSection());
				window.addEventListener("focus", refresh);
				document.addEventListener("visibilitychange", refresh);
				return () => {
					window.removeEventListener("focus", refresh);
					document.removeEventListener("visibilitychange", refresh);
				};
			}, []);
			const flashSaved = (key) => {
				setSavedFlag((prev) => ({
					...prev,
					[key]: true
				}));
				window.setTimeout(() => {
					setSavedFlag((prev) => {
						const next = { ...prev };
						delete next[key];
						return next;
					});
				}, 1500);
			};
			const updateField = async (path, value) => {
				if (svc === void 0) return;
				setBusy(true);
				try {
					await svc.mutate(NS, [{
						path,
						op: "set",
						value
					}]);
					flashSaved(path);
					setSection(readSection());
				} finally {
					setBusy(false);
				}
			};
			const addRole = async () => {
				if (svc === void 0) return;
				const id = "role-" + Date.now().toString(36);
				const newRole = {
					displayName: "新角色",
					description: "请填写角色的职责描述"
				};
				setBusy(true);
				try {
					await svc.mutate(NS, [{
						path: "roles." + id,
						op: "set",
						value: newRole
					}]);
					flashSaved("roles." + id);
					setSection(readSection());
				} finally {
					setBusy(false);
				}
			};
			const removeRole = async (id) => {
				if (svc === void 0) return;
				setBusy(true);
				try {
					await svc.mutate(NS, [{
						path: "roles." + id,
						op: "unset"
					}]);
					flashSaved("roles." + id);
					setSection(readSection());
				} finally {
					setBusy(false);
				}
			};
			const updateRoleField = async (id, field, value) => {
				if (svc === void 0) return;
				setBusy(true);
				try {
					await svc.mutate(NS, [{
						path: "roles." + id + "." + field,
						op: "set",
						value
					}]);
					flashSaved("roles." + id + "." + field);
					setSection(readSection());
				} finally {
					setBusy(false);
				}
			};
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsp-section",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-section-header",
						children: ["Subagent Pro", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsp-section-meta",
							children: svc === void 0 ? "（设置服务不可用，仅展示）" : busy ? "（保存中…）" : "（设置命名空间 subagent-pro）"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DefaultCard, {
						section,
						onChange: updateField,
						saved: savedFlag,
						disabled: svc === void 0
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RolesCard, {
						section,
						onAdd: addRole,
						onRemove: removeRole,
						onUpdate: updateRoleField,
						disabled: svc === void 0
					})
				]
			});
		}
		function DefaultCard({ section, onChange, saved, disabled }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsp-card",
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsp-card-head",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsp-card-title",
						children: "默认委派"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsp-card-source settings",
						children: "settings"
					})]
				}), [
					{
						key: "defaultProvider",
						label: "默认 provider",
						placeholder: "例：deepseek-official",
						type: "text"
					},
					{
						key: "defaultModel",
						label: "默认 model",
						placeholder: "例：deepseek-chat",
						type: "text"
					},
					{
						key: "defaultReasoningEffort",
						label: "默认 reasoningEffort",
						placeholder: "low / medium / high",
						type: "text"
					},
					{
						key: "defaultRole",
						label: "默认 role",
						placeholder: "（不设置）",
						type: "role-select"
					}
				].map((f) => {
					const path = f.key;
					const value = section[f.key] ?? "";
					const isSaved = saved[path] === true;
					return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-field-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: f.label }),
							f.type === "role-select" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								value,
								disabled,
								onChange: (e) => {
									onChange(path, e.target.value === "" ? null : e.target.value);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "（不设置）"
								}), Object.entries(section.roles ?? {}).map(([id, role]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: id,
									children: [
										id,
										" — ",
										role.displayName
									]
								}, id))]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "text",
								value,
								placeholder: f.placeholder,
								disabled,
								onChange: (e) => {
									onChange(path, e.target.value === "" ? null : e.target.value);
								}
							}),
							isSaved ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-card-meta",
								children: "已保存"
							}) : null
						]
					}, path);
				})]
			});
		}
		function RolesCard({ section, onAdd, onRemove, onUpdate, disabled }) {
			const roleEntries = (0, react.useMemo)(() => {
				return Object.entries(section.roles ?? {}).filter((entry) => entry[1] !== void 0);
			}, [section.roles]);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsp-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-card-head",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-card-title",
								children: "角色（settings）"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-card-meta",
								children: "agent md 角色请直接编辑 ~/.dsh/agents/*.md 或 .dsh/agents/*.md"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsp-card-actions",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "dsp-btn",
									type: "button",
									disabled,
									onClick: () => {
										onAdd();
									},
									children: "+ 新增角色"
								})
							})
						]
					}),
					roleEntries.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsp-card-meta",
						children: "尚未配置任何 settings 角色；agent md 角色（项目/全局）会在主代理指引里出现。"
					}) : null,
					roleEntries.map(([id, role]) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RoleCard, {
						id,
						role,
						onRemove,
						onUpdate,
						disabled
					}, id))
				]
			});
		}
		function RoleCard({ id, role, onRemove, onUpdate, disabled }) {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsp-card",
				style: { background: "transparent" },
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-card-head",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-card-title",
								children: role.displayName || id
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-card-source settings",
								children: id
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
								className: "dsp-card-actions",
								children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									className: "dsp-btn",
									type: "button",
									disabled,
									onClick: () => {
										onRemove(id);
									},
									children: "删除"
								})
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-field-row",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "displayName" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "text",
							value: role.displayName,
							disabled,
							onChange: (e) => {
								onUpdate(id, "displayName", e.target.value);
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-field-row",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "description" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							rows: 2,
							value: role.description,
							disabled,
							onChange: (e) => {
								onUpdate(id, "description", e.target.value);
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-field-row",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "persona" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
							rows: 3,
							value: role.persona ?? "",
							disabled,
							onChange: (e) => {
								onUpdate(id, "persona", e.target.value === "" ? null : e.target.value);
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-field-row",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "provider" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "text",
							value: role.provider ?? "",
							placeholder: "（继承）",
							disabled,
							onChange: (e) => {
								onUpdate(id, "provider", e.target.value === "" ? null : e.target.value);
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-field-row",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "model" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "text",
							value: role.model ?? "",
							placeholder: "（继承）",
							disabled,
							onChange: (e) => {
								onUpdate(id, "model", e.target.value === "" ? null : e.target.value);
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-field-row",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "tools (allow)" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "text",
							value: (role.toolFilter?.allow ?? []).join(" "),
							placeholder: "空格分隔，如：Read Grep Glob",
							disabled,
							onChange: (e) => {
								const allow = e.target.value.split(/\s+/).map((s) => s.trim()).filter((s) => s !== "");
								onUpdate(id, "toolFilter", allow.length === 0 ? null : { allow });
							}
						})]
					})
				]
			});
		}
		//#endregion
		//#region src/client/styles.ts
		/**
		* Inlined CSS for dsh-subagent-pro client.
		*
		* Lives in its own module so client/index.ts stays focused on slot wiring;
		* the styles get appended to <head> at apply() time.
		*/
		const STYLES = "/* HUD-style toggle */\n.dsp-toggle { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; }\n.dsp-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)); }\n.dsp-toggle.is-open { background: var(--dsw-alias-state-warn-tertiary, rgba(255,180,0,0.15)); }\n.dsp-badge { position: absolute; top: -2px; right: -2px; min-width: 14px; height: 14px; border-radius: 7px; background: var(--dsw-alias-state-warn-primary, #e8a13a); color: #fff; font-size: 10px; line-height: 14px; text-align: center; padding: 0 3px; box-sizing: border-box; pointer-events: none; }\n.dsp-panel { pointer-events: auto; position: fixed; width: 340px; max-height: min(560px, calc(100vh - 160px)); display: flex; flex-direction: column; background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #ffffff)); border: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.08)); border-radius: 12px; box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(15, 23, 42, 0.12)); font-family: var(--dsw-font-family, inherit); font-size: 12px; overflow: hidden; z-index: 2147483000; }\n.dsp-panel-header { display: flex; align-items: center; gap: 8px; padding: 9px 12px; user-select: none; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.06)); }\n.dsp-panel-title { font-weight: 600; font-size: 13px; line-height: 18px; }\n.dsp-panel-spacer { flex: 1; }\n.dsp-rows { overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 6px; padding: 8px; }\n.dsp-empty { padding: 24px 12px; text-align: center; color: var(--dsw-alias-label-tertiary, #94a3b8); }\n.dsp-row { flex: none; background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.6)); border: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.07)); border-radius: 8px; padding: 7px 10px; }\n.dsp-row-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; }\n.dsp-dot { width: 10px; height: 10px; flex: none; }\n.dsp-dot-running { color: var(--dsw-static-deepseek-450, rgb(86, 134, 254)); }\n.dsp-dot-cell { fill: currentColor; opacity: 0.15; animation: dsp-dot-chase 1s infinite; }\n@keyframes dsp-dot-chase { 0%, 12.4% { opacity: 1; } 12.5%, 24.9% { opacity: 0.6; } 25%, 37.4% { opacity: 0.35; } 37.5%, 100% { opacity: 0.15; } }\n.dsp-dot-ok, .dsp-dot-error, .dsp-dot-warn, .dsp-dot-off { position: relative; display: inline-block; }\n.dsp-dot-ok::before, .dsp-dot-error::before, .dsp-dot-warn::before, .dsp-dot-off::before { content: \"\"; position: absolute; inset: 0; border-radius: 50%; background: currentColor; opacity: 0.1; }\n.dsp-dot-ok::after, .dsp-dot-error::after, .dsp-dot-warn::after, .dsp-dot-off::after { content: \"\"; position: absolute; inset: 20%; border-radius: 50%; background: currentColor; }\n.dsp-dot-ok { color: var(--dsw-alias-state-success-primary, rgb(34, 197, 94)); }\n.dsp-dot-error { color: var(--dsw-alias-state-error-primary, rgb(236, 19, 19)); }\n.dsp-dot-warn { color: var(--dsw-alias-state-warn-primary, rgb(245, 158, 11)); }\n.dsp-dot-off { color: var(--dsw-alias-label-tertiary, #cbd5e1); }\n.dsp-row-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 18px; }\n.dsp-row-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 3px; padding-left: 18px; }\n.dsp-row-time { color: var(--dsw-alias-label-tertiary, #94a3b8); font-variant-numeric: tabular-nums; flex: none; font-size: 11px; }\n.dsp-row-meta { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #a3aec2); font-size: 11px; }\n.dsp-panel-footer { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.06)); }\n.dsp-panel-stats { color: var(--dsw-alias-label-tertiary, #94a3b8); font-size: 11px; }\n.dsp-btn { border: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.12)); background: transparent; border-radius: 6px; padding: 1px 8px; font-size: 11px; line-height: 16px; cursor: pointer; font-family: inherit; }\n.dsp-btn:hover { border-color: var(--dsw-alias-border-l2, rgba(15, 23, 42, 0.3)); background: var(--dsw-alias-interactive-bg-hover, rgba(15, 23, 42, 0.04)); }\n.dsp-back { color: var(--dsw-alias-brand-primary, #2563eb); border-color: var(--dsw-alias-brand-primary, #2563eb); }\n.dsp-section { display: flex; flex-direction: column; gap: 12px; }\n.dsp-section-header { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }\n.dsp-section-meta { color: var(--dsw-alias-label-tertiary, #94a3b8); font-size: 11px; font-weight: 400; }\n.dsp-card { border: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.08)); border-radius: 8px; padding: 10px 12px; background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.6)); display: flex; flex-direction: column; gap: 8px; }\n.dsp-card-head { display: flex; align-items: center; gap: 8px; }\n.dsp-card-title { font-weight: 600; font-size: 13px; }\n.dsp-card-source { font-size: 10px; line-height: 14px; padding: 0 6px; border-radius: 6px; }\n.dsp-card-source.project { color: var(--dsw-alias-state-success-primary, rgb(34,197,94)); background: rgba(34,197,94,0.08); }\n.dsp-card-source.global { color: var(--dsw-alias-state-warn-label, #b8860b); background: var(--dsw-alias-state-warn-tertiary, rgba(255,180,0,0.15)); }\n.dsp-card-source.settings { color: var(--dsw-alias-label-secondary, #475569); background: var(--dsw-alias-interactive-bg-hover, rgba(15,23,42,0.06)); }\n.dsp-card-source.md { color: var(--dsw-alias-state-business-primary, #2563eb); background: rgba(37, 99, 235, 0.08); }\n.dsp-card-actions { margin-left: auto; display: flex; gap: 4px; }\n.dsp-card-meta { color: var(--dsw-alias-label-tertiary, #94a3b8); font-size: 11px; }\n.dsp-field-row { display: grid; grid-template-columns: 80px 1fr; gap: 8px; align-items: center; font-size: 12px; }\n.dsp-field-row label { color: var(--dsw-alias-label-secondary, #475569); }\n.dsp-field-row input, .dsp-field-row textarea { width: 100%; box-sizing: border-box; background: var(--dsw-alias-bg-base, #ffffff); border: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.12)); border-radius: 6px; font-size: 12px; padding: 4px 8px; font-family: inherit; resize: vertical; }\n.dsp-field-row input:disabled, .dsp-field-row textarea:disabled { background: var(--dsw-alias-interactive-bg-hover, rgba(15, 23, 42, 0.04)); color: var(--dsw-alias-label-tertiary, #94a3b8); cursor: not-allowed; }\n.dsp-card-foot { display: flex; align-items: center; gap: 8px; }\n.dsp-card-foot .dsp-card-meta { flex: 1; }\n@media (max-width: 768px) { .dsp-panel { width: min(340px, calc(100vw - 24px)); } }\n";
		//#endregion
		//#region src/client/index.ts
		const inject = ["slots", "sessions"];
		function apply(ctx) {
			setSessionsService(ctx.get("sessions"));
			setRolesService(ctx.get("roles"));
			try {
				ctx.effect(() => {
					const tag = document.createElement("style");
					tag.dataset.plugin = "dsh-subagent-pro";
					tag.textContent = STYLES;
					document.head.appendChild(tag);
					return () => {
						tag.remove();
					};
				}, "dsh-subagent-pro: styles");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				console.warn("[dsh-subagent-pro] styles inject skipped: " + message);
			}
			const SLOTS = {
				inputLeft: "conversation.input.left",
				shellOverlay: "shell.overlay",
				settingsSection: "settings.section"
			};
			const register = ctx.slots.register;
			ctx.slots.inject(SLOTS.inputLeft, () => register({
				name: SLOTS.inputLeft,
				id: "dsh-subagent-pro-toggle"
			}, Toggle));
			ctx.slots.inject(SLOTS.shellOverlay, () => register({
				name: SLOTS.shellOverlay,
				id: "dsh-subagent-pro-panel"
			}, Panel));
			ctx.slots.inject(SLOTS.settingsSection, () => register({
				name: SLOTS.settingsSection,
				id: "dsh-subagent-pro-settings",
				order: 50,
				label: "Subagent Pro"
			}, RoleEditorSection));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map