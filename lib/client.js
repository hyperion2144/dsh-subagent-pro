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
		let settingsSvc;
		function setSessionsService(service) {
			sessionsSvc = service;
		}
		function getSessionsService() {
			return sessionsSvc;
		}
		function setSettingsService(service) {
			settingsSvc = service;
		}
		function getSettingsService() {
			return settingsSvc;
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
		function Panel(props) {
			const store = useStore();
			const sessionsSvc = getSessionsService();
			const subagentParent = props.useSessions((select) => select?.currentAddress?.parentSessionId);
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
					subagentParent !== void 0 && sessionsSvc !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						className: "dsp-btn dsp-back",
						type: "button",
						title: "返回主会话",
						onClick: () => sessionsSvc?.open(subagentParent),
						children: "← 主会话"
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
					const providerPart = row.provider !== void 0 && row.provider !== "" ? row.provider : "";
					const modelPart = row.model !== void 0 && row.model !== "" ? row.model : "";
					const effortPart = row.reasoningEffort !== void 0 && row.reasoningEffort !== "" ? row.reasoningEffort : "";
					const modelChip = modelPart !== "" ? [
						providerPart,
						modelPart,
						effortPart
					].filter((s) => s !== "").join(" · ") : "";
					const metaLine = [modeText, shortId(row.id)].filter((value) => typeof value === "string" && value !== "").join(" · ");
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
								modelChip !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									className: "dsp-model-chip",
									children: modelChip
								}) : null,
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
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsp-panel-footer-stats",
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsp-stat-chip dsp-stat-running",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-stat-num",
								children: running
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-stat-label",
								children: "运行"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsp-stat-chip dsp-stat-completed",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-stat-num",
								children: done
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-stat-label",
								children: "完成"
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
							className: "dsp-stat-chip dsp-stat-failed",
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-stat-num",
								children: failed
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-stat-label",
								children: "异常"
							})]
						})
					]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "dsp-panel-footer-actions",
					children: [store.hidden.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						className: "dsp-btn",
						type: "button",
						onClick: () => dispatch({ hidden: [] }),
						children: "显示已隐藏 " + store.hidden.length
					}) : null, /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						className: "dsp-btn",
						type: "button",
						onClick: () => {
							const hidden = [...store.hidden];
							for (const row of store.rows) if (row.status !== "running" && !hidden.includes(row.id)) hidden.push(row.id);
							dispatch({ hidden });
						},
						children: "清空已完成"
					})]
				})]
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
		/** Lucide `bot` icon — AI 聊天机器人. Path data from lucide.dev (24×24 viewBox). */
		function SubagentIcon() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				className: "dsp-toggle-icon",
				width: 14,
				height: 14,
				viewBox: "0 0 24 24",
				fill: "none",
				stroke: "currentColor",
				strokeWidth: 2,
				strokeLinecap: "round",
				strokeLinejoin: "round",
				"aria-hidden": "true",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12 8V4H8" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
						width: "16",
						height: "12",
						x: "4",
						y: "8",
						rx: "2"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M2 14h2" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M20 14h2" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M15 13v2" }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M9 13v2" })
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
		* apply() listens to `settings/updated` and re-reads the source via the live
		* `installSettingsSection` getter; this UI simply re-reads the namespace on
		* every mount and after each successful mutate.
		*/
		async function readSectionAsync() {
			const svc = getSettingsService();
			if (svc === void 0) return {
				section: {},
				revision: 0
			};
			try {
				const { view, revision } = await svc.read();
				return {
					section: view ?? {},
					revision
				};
			} catch {
				return {
					section: {},
					revision: 0
				};
			}
		}
		function RoleEditorSection(_props) {
			const svc = getSettingsService();
			const [section, setSection] = (0, react.useState)({});
			const [revision, setRevision] = (0, react.useState)(0);
			const [available, setAvailable] = (0, react.useState)(svc !== void 0);
			const [savedFlag, setSavedFlag] = (0, react.useState)({});
			const [busy, setBusy] = (0, react.useState)(false);
			const refresh = (0, react.useMemo)(() => async () => {
				if (svc === void 0) return;
				const { section: next, revision: rev } = await readSectionAsync();
				setSection(next);
				setRevision(rev);
				setAvailable(true);
			}, [svc]);
			(0, react.useEffect)(() => {
				refresh();
				const onFocus = () => {
					refresh();
				};
				window.addEventListener("focus", onFocus);
				document.addEventListener("visibilitychange", onFocus);
				return () => {
					window.removeEventListener("focus", onFocus);
					document.removeEventListener("visibilitychange", onFocus);
				};
			}, [refresh]);
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
			const doMutate = async (ops, flashKey) => {
				if (svc === void 0) return;
				setBusy(true);
				try {
					const result = await svc.mutate(ops, revision);
					setSection(result.view ?? {});
					setRevision(result.revision);
					flashSaved(flashKey);
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					console.error("[dsh-subagent-pro] settings mutate failed:", msg);
					try {
						const { section: next, revision: rev } = await readSectionAsync();
						setSection(next);
						setRevision(rev);
					} catch {}
				} finally {
					setBusy(false);
				}
			};
			const updateField = (path, value) => doMutate([{
				path,
				op: "set",
				value
			}], path.join("."));
			const addRole = async () => {
				const id = "role-" + Date.now().toString(36);
				await doMutate([{
					path: ["roles", id],
					op: "set",
					value: {
						displayName: "新角色",
						description: "请填写角色的职责描述"
					}
				}], "roles." + id);
			};
			const removeRole = (id) => doMutate([{
				path: ["roles", id],
				op: "unset"
			}], "roles." + id);
			const updateRoleField = (id, field, value) => doMutate([{
				path: [
					"roles",
					id,
					field
				],
				op: "set",
				value
			}], "roles." + id + "." + field);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsp-section",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-section-header",
						children: ["Subagent Pro", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsp-section-meta",
							children: !available ? "（设置 bridge 未加载，仅展示）" : busy ? "（保存中…）" : "（设置命名空间 subagent-pro）"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(DefaultCard, {
						section,
						onChange: updateField,
						saved: savedFlag,
						disabled: !available
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(MdRolesCard, {}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(RolesCard, {
						section,
						onAdd: addRole,
						onRemove: removeRole,
						onUpdate: updateRoleField,
						disabled: !available
					})
				]
			});
		}
		function DefaultCard({ section, onChange, saved, disabled }) {
			const svc = getSettingsService();
			const [providers, setProviders] = (0, react.useState)([]);
			const [models, setModels] = (0, react.useState)([]);
			const [llmLoadFailed, setLlmLoadFailed] = (0, react.useState)(false);
			const currentProvider = section.defaultProvider ?? "";
			const currentModel = section.defaultModel ?? "";
			(0, react.useEffect)(() => {
				if (svc === void 0) return;
				let cancelled = false;
				svc.listProviders().then((p) => {
					if (!cancelled) {
						setProviders(p);
						setLlmLoadFailed(false);
					}
				}, () => {
					if (!cancelled) {
						setProviders([]);
						setLlmLoadFailed(true);
					}
				});
				return () => {
					cancelled = true;
				};
			}, [svc]);
			(0, react.useEffect)(() => {
				if (svc === void 0) return;
				if (currentProvider === "") {
					setModels([]);
					return;
				}
				let cancelled = false;
				svc.listModels(currentProvider).then((m) => {
					if (!cancelled) setModels(m);
				}, () => {
					if (!cancelled) setModels([]);
				});
				return () => {
					cancelled = true;
				};
			}, [svc, currentProvider]);
			const roleEntries = Object.entries(section.roles ?? {});
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsp-card",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-card-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsp-card-title",
							children: "默认委派"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsp-card-source settings",
							children: "settings"
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-field-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "默认 provider" }),
							providers.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								value: currentProvider,
								disabled,
								onChange: (e) => {
									const next = e.target.value;
									(async () => {
										await onChange(["defaultProvider"], next === "" ? null : next);
										if (next !== currentProvider) {
											await onChange(["defaultModel"], null);
											await onChange(["defaultReasoningEffort"], null);
										}
									})();
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "（不设置）"
								}), providers.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: p.id,
									children: [
										p.name,
										" (",
										p.id,
										")"
									]
								}, p.id))]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "text",
								value: currentProvider,
								placeholder: llmLoadFailed ? "LLM 信息获取失败，手动输入" : "例：deepseek-official",
								disabled,
								onChange: (e) => {
									onChange(["defaultProvider"], e.target.value === "" ? null : e.target.value);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-card-meta",
								children: saved["defaultProvider"] === true ? "已保存" : ""
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-field-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "默认 model" }),
							currentProvider !== "" && models.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								value: section.defaultModel ?? "",
								disabled,
								onChange: (e) => {
									const next = e.target.value;
									(async () => {
										await onChange(["defaultModel"], next === "" ? null : next);
										await onChange(["defaultReasoningEffort"], null);
									})();
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "（不设置）"
								}), models.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: m.id,
									children: [
										m.name,
										" (",
										m.id,
										")"
									]
								}, m.id))]
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "text",
								value: section.defaultModel ?? "",
								placeholder: currentProvider === "" ? "（先选 provider）" : llmLoadFailed ? "LLM 信息获取失败，手动输入" : "例：deepseek-chat",
								disabled,
								onChange: (e) => {
									onChange(["defaultModel"], e.target.value === "" ? null : e.target.value);
								}
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-card-meta",
								children: saved["defaultModel"] === true ? "已保存" : ""
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ReasoningField, {
						path: ["defaultReasoningEffort"],
						providerId: currentProvider,
						modelId: currentModel,
						value: section.defaultReasoningEffort,
						disabled,
						onChange,
						saved: saved["defaultReasoningEffort"] === true
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-field-row",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "默认 role" }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
								value: section.defaultRole ?? "",
								disabled,
								onChange: (e) => {
									onChange(["defaultRole"], e.target.value === "" ? null : e.target.value);
								},
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: "（不设置）"
								}), roleEntries.map(([id, role]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
									value: id,
									children: [
										id,
										" — ",
										role.displayName
									]
								}, id))]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-card-meta",
								children: saved["defaultRole"] === true ? "已保存" : ""
							})
						]
					})
				]
			});
		}
		/** Reasoning-effort field: dropdown only if the selected model advertises the capability. */
		function ReasoningField(props) {
			const { providerId, modelId, value, disabled, onChange, path, saved } = props;
			const svc = getSettingsService();
			const [efforts, setEfforts] = (0, react.useState)([]);
			const [loaded, setLoaded] = (0, react.useState)(false);
			const [loadFailed, setLoadFailed] = (0, react.useState)(false);
			(0, react.useEffect)(() => {
				if (svc === void 0) return;
				if (providerId === "" || modelId === "") {
					setEfforts([]);
					setLoaded(true);
					return;
				}
				let cancelled = false;
				setLoaded(false);
				svc.listReasoningEfforts(providerId, modelId).then((e) => {
					if (!cancelled) {
						setEfforts(e);
						setLoaded(true);
						setLoadFailed(false);
					}
				}, () => {
					if (!cancelled) {
						setEfforts([]);
						setLoaded(true);
						setLoadFailed(true);
					}
				});
				return () => {
					cancelled = true;
				};
			}, [
				svc,
				providerId,
				modelId
			]);
			const showDropdown = loaded && efforts.length > 0;
			const showFallbackInput = loaded && efforts.length === 0;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsp-field-row",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "默认 reasoningEffort" }),
					showDropdown ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
						value: value ?? "",
						disabled,
						onChange: (e) => {
							onChange(path, e.target.value === "" ? null : e.target.value);
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: "",
							children: "（不设置）"
						}), efforts.map((eff) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
							value: eff.id,
							children: eff.name
						}, eff.id))]
					}) : showFallbackInput ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "text",
						value: value ?? "",
						placeholder: loadFailed ? "reasoningEffort 解析失败，手动输入" : "（当前模型未声明 reasoningEffort）",
						disabled,
						onChange: (e) => {
							onChange(path, e.target.value === "" ? null : e.target.value);
						}
					}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
						type: "text",
						value: value ?? "",
						placeholder: providerId === "" || modelId === "" ? "（先选 model）" : "加载中…",
						disabled: true
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "dsp-card-meta",
						children: saved ? "已保存" : ""
					})
				]
			});
		}
		/**
		* Read-only section listing every role discovered on disk — global
		* `~/.dsh/agents/*.md` plus every registered workspace's `.dsh/agents/*.md`.
		* Source labels disambiguate project vs global; `isOverride` adds an
		* `also: 全局/项目` chip when both layers define the same id (project wins).
		* Locked icons mark these as file-owned (edit the .md to change).
		*/
		function MdRolesCard() {
			const svc = getSettingsService();
			const [roles, setRoles] = (0, react.useState)([]);
			const [loading, setLoading] = (0, react.useState)(false);
			const [loadError, setLoadError] = (0, react.useState)();
			const refresh = async () => {
				if (svc === void 0) return;
				setLoading(true);
				setLoadError(void 0);
				try {
					const list = await svc.listFileRoles();
					setRoles(list);
				} catch (e) {
					setLoadError(e instanceof Error ? e.message : String(e));
					setRoles([]);
				} finally {
					setLoading(false);
				}
			};
			(0, react.useEffect)(() => {
				refresh();
			}, [svc]);
			if (svc === void 0) return null;
			const projectRoles = roles.filter((r) => r.source === "project-md");
			const globalRoles = roles.filter((r) => r.source === "global-md");
			const renderRole = (r) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsp-role-card dsp-role-card-md",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-role-card-head",
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-role-card-title",
								children: r.displayName
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								className: "dsp-role-source-chip dsp-role-source-" + r.source,
								children: r.source === "project-md" ? "项目" : "全局"
							}),
							r.isOverride ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
								className: "dsp-role-also-chip",
								children: ["also: ", r.source === "project-md" ? "全局" : "项目"]
							}) : null,
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
								className: "dsp-role-locked",
								width: "11",
								height: "11",
								viewBox: "0 0 24 24",
								fill: "none",
								stroke: "currentColor",
								strokeWidth: 2,
								strokeLinecap: "round",
								strokeLinejoin: "round",
								"aria-label": "只读",
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("title", { children: "只读 — 修改请直接编辑 .md 文件" }),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
										x: "3",
										y: "11",
										width: "18",
										height: "11",
										rx: "2",
										ry: "2"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M7 11V7a5 5 0 0 1 10 0v4" })
								]
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsp-role-card-path",
						children: r.filePath
					}),
					r.description !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsp-role-card-desc",
						children: r.description
					}) : null,
					r.persona !== void 0 && r.persona !== "" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						className: "dsp-role-card-persona-wrap",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", {
							className: "dsp-role-card-persona-summary",
							children: "persona"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("pre", {
							className: "dsp-role-card-persona",
							children: r.persona
						})]
					}) : null,
					r.provider !== void 0 || r.model !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-role-card-meta",
						children: [
							r.provider !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["provider: ", r.provider] }) : null,
							r.model !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["model: ", r.model] }) : null,
							r.reasoningEffort !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["effort: ", r.reasoningEffort] }) : null
						]
					}) : null
				]
			}, r.id);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "dsp-card dsp-card-md",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-card-head",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsp-card-title",
							children: "角色（文件）"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							className: "dsp-card-meta",
							children: "来自 .dsh/agents/*.md · 只读（修改请直接编辑 .md 文件）"
						})]
					}),
					loadError !== void 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-card-meta dsp-role-error",
						children: [
							"加载失败：",
							loadError,
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								className: "dsp-btn",
								type: "button",
								onClick: () => {
									refresh();
								},
								children: "重试"
							})
						]
					}) : null,
					loading && roles.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						className: "dsp-card-meta",
						children: "加载中…"
					}) : null,
					!loading && !loadError && roles.length === 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-card-meta",
						children: [
							"尚未在任何 .dsh/agents/*.md 中找到角色。在项目 ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("code", { children: ["<workspace>", "/.dsh/agents/code-reviewer.md"] }),
							" 或全局 ",
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "~/.dsh/agents/code-reviewer.md" }),
							" 写一份即出现。"
						]
					}) : null,
					projectRoles.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-role-section-label",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dsp-role-section-dot dsp-role-section-dot-project" }), "项目级"]
					}), projectRoles.map(renderRole)] }) : null,
					globalRoles.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-role-section-label",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { className: "dsp-role-section-dot dsp-role-section-dot-global" }), "全局级"]
					}), globalRoles.map(renderRole)] }) : null
				]
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
		function RoleCard(props) {
			const { id, role, onRemove, onUpdate, disabled } = props;
			const svc = getSettingsService();
			const [providers, setProviders] = (0, react.useState)([]);
			const [models, setModels] = (0, react.useState)([]);
			const roleProvider = role.provider ?? "";
			(0, react.useEffect)(() => {
				if (svc === void 0) return;
				let cancelled = false;
				svc.listProviders().then((p) => {
					if (!cancelled) setProviders(p);
				}, () => {
					if (!cancelled) setProviders([]);
				});
				return () => {
					cancelled = true;
				};
			}, [svc]);
			(0, react.useEffect)(() => {
				if (svc === void 0) return;
				if (roleProvider === "") {
					setModels([]);
					return;
				}
				let cancelled = false;
				svc.listModels(roleProvider).then((m) => {
					if (!cancelled) setModels(m);
				}, () => {
					if (!cancelled) setModels([]);
				});
				return () => {
					cancelled = true;
				};
			}, [svc, roleProvider]);
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
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "provider" }), providers.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							value: roleProvider,
							disabled,
							onChange: (e) => {
								const next = e.target.value;
								(async () => {
									await onUpdate(id, "provider", next === "" ? null : next);
									if (next !== roleProvider) {
										await onUpdate(id, "model", null);
										await onUpdate(id, "reasoningEffort", null);
									}
								})();
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: "（继承）"
							}), providers.map((p) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: p.id,
								children: [
									p.name,
									" (",
									p.id,
									")"
								]
							}, p.id))]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "text",
							value: roleProvider,
							placeholder: "（继承）",
							disabled,
							onChange: (e) => {
								onUpdate(id, "provider", e.target.value === "" ? null : e.target.value);
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						className: "dsp-field-row",
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", { children: "model" }), roleProvider !== "" && models.length > 0 ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
							value: role.model ?? "",
							disabled,
							onChange: (e) => {
								const next = e.target.value;
								(async () => {
									await onUpdate(id, "model", next === "" ? null : next);
									await onUpdate(id, "reasoningEffort", null);
								})();
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: "（继承）"
							}), models.map((m) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
								value: m.id,
								children: [
									m.name,
									" (",
									m.id,
									")"
								]
							}, m.id))]
						}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							type: "text",
							value: role.model ?? "",
							placeholder: roleProvider === "" ? "（先选 provider）" : "（继承）",
							disabled,
							onChange: (e) => {
								onUpdate(id, "model", e.target.value === "" ? null : e.target.value);
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(ReasoningField, {
						path: [
							"roles",
							id,
							"reasoningEffort"
						],
						providerId: roleProvider,
						modelId: role.model ?? "",
						value: role.reasoningEffort,
						disabled,
						onChange: (p, v) => onUpdate(id, p[p.length - 1], v),
						saved: false
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
		const STYLES = [
			".dsp-toggle { position: relative; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; padding: 0; margin: 0; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary, inherit); cursor: pointer; }",
			".dsp-toggle:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.06)); }",
			".dsp-toggle.is-open { background: var(--dsw-alias-state-warn-tertiary, rgba(255,180,0,0.15)); color: var(--dsw-alias-state-warn-primary, #b8821a); }",
			".dsp-toggle.is-open:hover { background: var(--dsw-alias-state-warn-tertiary, rgba(255,180,0,0.22)); }",
			".dsp-badge { position: absolute; top: -2px; right: -2px; min-width: 14px; height: 14px; border-radius: 7px; background: var(--dsw-alias-state-warn-primary, #e8a13a); color: #fff; font-size: 10px; line-height: 14px; text-align: center; padding: 0 3px; box-sizing: border-box; pointer-events: none; font-weight: 600; }",
			".dsp-panel { pointer-events: auto; position: fixed; width: 340px; max-height: min(560px, calc(100vh - 160px)); display: flex; flex-direction: column; background: var(--dsw-specific-sidebar-fill, var(--dsw-alias-bg-base, #ffffff)); border: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.08)); border-radius: 12px; box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(15, 23, 42, 0.12)); font-family: var(--dsw-font-family, inherit); font-size: 12px; overflow: hidden; z-index: 2147483000; }",
			".dsp-panel-header { display: flex; align-items: center; gap: 8px; padding: 9px 12px; user-select: none; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.06)); }",
			".dsp-panel-title { font-weight: 600; font-size: 13px; line-height: 18px; }",
			".dsp-panel-spacer { flex: 1; }",
			".dsp-rows { overflow-y: auto; flex: 1; display: flex; flex-direction: column; gap: 6px; padding: 8px; }",
			".dsp-empty { padding: 24px 12px; text-align: center; color: var(--dsw-alias-label-tertiary, #94a3b8); }",
			".dsp-row { flex: none; background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.6)); border: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.07)); border-radius: 8px; padding: 7px 10px; }",
			".dsp-row-main { display: flex; align-items: center; justify-content: space-between; gap: 8px; }",
			".dsp-row-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 18px; color: var(--dsw-alias-label-primary, inherit); }",
			".dsp-model-chip { flex: none; font-size: 10px; line-height: 16px; padding: 0 6px; border-radius: 4px; background: var(--dsw-alias-state-info-tertiary, rgba(59,130,246,0.12)); color: var(--dsw-alias-state-info-primary, #1e6fdb); white-space: nowrap; }",
			".dsp-row-open { flex: none; }",
			".dsp-row-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 3px; padding-left: 18px; }",
			".dsp-row-meta { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #a3aec2); font-size: 11px; line-height: 16px; }",
			".dsp-row-time { color: var(--dsw-alias-label-tertiary, #94a3b8); font-variant-numeric: tabular-nums; flex: none; font-size: 11px; line-height: 16px; }",
			".dsp-dot { width: 10px; height: 10px; flex: none; }",
			".dsp-panel-footer { display: flex; flex-direction: row; align-items: center; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.06)); user-select: none; }",
			".dsp-panel-footer-stats { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; flex-wrap: wrap; }",
			".dsp-panel-footer-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; margin-left: auto; }",
			".dsp-stat-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 11px; line-height: 16px; background: var(--dsw-alias-bg-layer-2, rgba(15, 23, 42, 0.04)); color: var(--dsw-alias-label-secondary, #4a5160); }",
			".dsp-stat-num { font-weight: 600; font-variant-numeric: tabular-nums; min-width: 12px; text-align: center; }",
			".dsp-stat-label { opacity: 0.85; }",
			".dsp-stat-running .dsp-stat-num { color: var(--dsw-alias-state-info-primary, #1e6fdb); }",
			".dsp-stat-completed .dsp-stat-num { color: var(--dsw-alias-state-success-primary, #16a34a); }",
			".dsp-stat-failed .dsp-stat-num { color: var(--dsw-alias-state-danger-primary, #dc2626); }",
			".dsp-section { display: flex; flex-direction: column; gap: 12px; padding: 12px; }",
			".dsp-section-header { display: flex; align-items: baseline; gap: 8px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }",
			".dsp-section-meta { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #94a3b8); }",
			".dsp-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,0.08)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.5)); }",
			".dsp-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
			".dsp-card-title { font-size: 12px; font-weight: 600; }",
			".dsp-card-source { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: var(--dsw-alias-state-info-tertiary, rgba(59,130,246,0.12)); color: var(--dsw-alias-state-info-primary, #1e6fdb); }",
			".dsp-card-source.settings { background: var(--dsw-alias-state-warn-tertiary, rgba(255,180,0,0.15)); color: var(--dsw-alias-state-warn-primary, #b8821a); }",
			".dsp-card-actions { margin-left: auto; display: flex; gap: 4px; }",
			".dsp-card-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary, #94a3b8); }",
			".dsp-field-row { display: grid; grid-template-columns: 96px 1fr auto; align-items: center; gap: 8px; }",
			".dsp-field-row > label { font-size: 11px; color: var(--dsw-alias-label-secondary, #4a5160); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
			".dsp-field-row > input, .dsp-field-row > select, .dsp-field-row > textarea { font: inherit; font-size: 12px; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,0.10)); border-radius: 6px; background: var(--dsw-alias-bg-base, #ffffff); color: var(--dsw-alias-label-primary, inherit); outline: none; min-width: 0; }",
			".dsp-field-row > input:focus, .dsp-field-row > select:focus, .dsp-field-row > textarea:focus { border-color: var(--dsw-alias-state-info-primary, #1e6fdb); box-shadow: 0 0 0 2px rgba(30,111,219,0.18); }",
			".dsp-field-row > input:disabled, .dsp-field-row > select:disabled, .dsp-field-row > textarea:disabled { background: var(--dsw-alias-bg-layer-2, #f3f5f8); color: var(--dsw-alias-label-tertiary, #94a3b8); cursor: not-allowed; }",
			".dsp-field-row > textarea { resize: vertical; min-height: 36px; line-height: 1.4; }",
			".dsp-btn { font: inherit; font-size: 11px; padding: 3px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,0.12)); border-radius: 6px; background: var(--dsw-alias-bg-base, #ffffff); color: var(--dsw-alias-label-primary, inherit); cursor: pointer; }",
			".dsp-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); }",
			".dsp-btn:disabled { color: var(--dsw-alias-label-tertiary, #94a3b8); cursor: not-allowed; }",
			".dsp-btn-primary { background: var(--dsw-alias-state-info-primary, #1e6fdb); color: #fff; border-color: var(--dsw-alias-state-info-primary, #1e6fdb); }",
			".dsp-btn-primary:hover { background: #1859b3; border-color: #1859b3; }",
			".dsp-card-md { gap: 6px; }",
			".dsp-role-section-label { display: flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 600; color: var(--dsw-alias-label-secondary, #4a5160); text-transform: uppercase; letter-spacing: 0.5px; margin-top: 6px; }",
			".dsp-role-section-label:first-of-type { margin-top: 0; }",
			".dsp-role-section-dot { display: inline-block; width: 6px; height: 6px; border-radius: 50%; }",
			".dsp-role-section-dot-project { background: #5b9bd5; }",
			".dsp-role-section-dot-global { background: #a3aec2; }",
			".dsp-role-card { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 6px; }",
			".dsp-role-card-md { border: 1px solid rgba(15,23,42,0.06); }",
			".dsp-role-card-md:has(.dsp-role-source-project-md) { background: rgba(91,155,213,0.06); border-color: rgba(91,155,213,0.18); }",
			".dsp-role-card-md:has(.dsp-role-source-global-md) { background: rgba(163,174,194,0.04); border-color: rgba(163,174,194,0.14); }",
			".dsp-role-card-head { display: flex; align-items: center; gap: 6px; }",
			".dsp-role-card-title { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; }",
			".dsp-role-source-chip { font-size: 10px; padding: 1px 6px; border-radius: 4px; flex: none; }",
			".dsp-role-source-project-md { background: rgba(91,155,213,0.18); color: #5b9bd5; }",
			".dsp-role-source-global-md { background: rgba(163,174,194,0.14); color: #a3aec2; }",
			".dsp-role-also-chip { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: rgba(163,174,194,0.10); color: #a3aec2; opacity: 0.85; flex: none; }",
			".dsp-role-locked { color: #6a7280; flex: none; cursor: help; }",
			".dsp-role-card-path { font-size: 10px; color: var(--dsw-alias-label-tertiary, #94a3b8); font-family: ui-monospace, Menlo, Consolas, monospace; word-break: break-all; }",
			".dsp-role-card-desc { font-size: 11px; color: var(--dsw-alias-label-secondary, #4a5160); line-height: 1.4; margin-top: 2px; }",
			".dsp-role-card-meta { display: flex; flex-wrap: wrap; gap: 8px; font-size: 10px; color: var(--dsw-alias-label-tertiary, #94a3b8); }",
			".dsp-role-card-persona-wrap { margin-top: 4px; font-size: 11px; }",
			".dsp-role-card-persona-summary { cursor: pointer; color: var(--dsw-alias-label-tertiary, #94a3b8); }",
			".dsp-role-card-persona { white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; padding: 6px 8px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2, #f3f5f8); color: var(--dsw-alias-label-primary, inherit); font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 10px; line-height: 1.45; margin-top: 4px; }",
			".dsp-role-error { display: flex; align-items: center; gap: 8px; }",
			".dsp-back { font-weight: 600; padding: 3px 10px; }",
			".dsp-back:hover { background: var(--dsw-alias-state-warn-tertiary, rgba(255,180,0,0.18)); border-color: var(--dsw-alias-state-warn-primary, #e8a13a); color: var(--dsw-alias-state-warn-primary, #b8821a); }"
		].join("\n") + "\n";
		//#endregion
		//#region src/client/index.ts
		const inject = ["slots", "sessions"];
		/** Settings bridge endpoint registered by src/bridge-entry.ts. */
		const SETTINGS_VIEW = "/api/dsh-subagent-pro/settings/view";
		const SETTINGS_MUTATE = "/api/dsh-subagent-pro/settings/mutate";
		/** LLM-info bridge endpoints — provider/model/reasoning-effort enumeration. */
		const LLM_PROVIDERS = "/api/dsh-subagent-pro/llm/providers";
		/** File-role bridge endpoint — every registered workspace's .dsh/agents/*.md
		*  plus the global `~/.dsh/agents/*.md` directory, merged with project-wins
		*  precedence. Powers the read-only "角色（文件）" section in the role editor. */
		const FILE_ROLES = "/api/dsh-subagent-pro/roles";
		function makeFetchSettingsService() {
			return {
				async read() {
					const res = await fetch(SETTINGS_VIEW, { credentials: "same-origin" });
					if (!res.ok) {
						const text = await res.text().catch(() => "");
						throw new Error(`settings read HTTP ${res.status}: ${text}`);
					}
					const data = await res.json();
					if (!data.ok) throw new Error(`settings read failed: ${data.error.message}`);
					return {
						view: data.view,
						revision: data.revision
					};
				},
				async mutate(ops, expectedRevision) {
					const data = await (await fetch(SETTINGS_MUTATE, {
						method: "PATCH",
						credentials: "same-origin",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({
							ops,
							expectedRevision
						})
					})).json();
					if (!data.ok) throw new Error(`settings mutate failed: ${data.error.message}`);
					return {
						view: data.view,
						revision: data.revision
					};
				},
				async listProviders() {
					const res = await fetch(LLM_PROVIDERS, { credentials: "same-origin" });
					if (!res.ok) throw new Error(`llm providers HTTP ${res.status}`);
					const data = await res.json();
					if (!data.ok) throw new Error(`llm providers failed: ${data.error.message}`);
					return data.providers;
				},
				async listModels(provider) {
					const url = "/api/dsh-subagent-pro/llm/models?provider=" + encodeURIComponent(provider);
					const res = await fetch(url, { credentials: "same-origin" });
					if (!res.ok) throw new Error(`llm models HTTP ${res.status}`);
					const data = await res.json();
					if (!data.ok) throw new Error(`llm models failed: ${data.error.message}`);
					return data.models;
				},
				async listReasoningEfforts(provider, model) {
					const url = "/api/dsh-subagent-pro/llm/reasoning-efforts?provider=" + encodeURIComponent(provider) + "&model=" + encodeURIComponent(model);
					const res = await fetch(url, { credentials: "same-origin" });
					if (!res.ok) throw new Error(`llm reasoning-efforts HTTP ${res.status}`);
					const data = await res.json();
					if (!data.ok) throw new Error(`llm reasoning-efforts failed: ${data.error.message}`);
					return data.efforts;
				},
				async listFileRoles() {
					const res = await fetch(FILE_ROLES, { credentials: "same-origin" });
					if (!res.ok) throw new Error(`file-roles HTTP ${res.status}`);
					const data = await res.json();
					if (!data.ok) throw new Error(`file-roles failed: ${data.error.message}`);
					return data.roles;
				}
			};
		}
		function apply(ctx) {
			setSessionsService(ctx.get("sessions"));
			setSettingsService(makeFetchSettingsService());
			ctx.effect(() => {
				const tag = document.createElement("style");
				tag.dataset.plugin = "dsh-subagent-pro";
				tag.textContent = STYLES;
				document.head.appendChild(tag);
				return () => {
					tag.remove();
				};
			}, "dsh-subagent-pro: styles");
			const SLOTS = {
				inputLeft: "conversation.input.left",
				shellOverlay: "shell.overlay",
				settingsSection: "settings.section"
			};
			ctx.slots.inject(SLOTS.inputLeft, () => ctx.slots.register({
				name: SLOTS.inputLeft,
				id: "dsh-subagent-pro-toggle"
			}, Toggle));
			ctx.slots.inject(SLOTS.shellOverlay, () => ctx.slots.register({
				name: SLOTS.shellOverlay,
				id: "dsh-subagent-pro-panel"
			}, Panel));
			ctx.slots.inject(SLOTS.settingsSection, () => ctx.slots.register({
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