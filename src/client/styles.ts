/**
 * Inlined CSS for dsh-subagent-pro client.
 *
 * Lives in its own module so client/index.ts stays focused on slot wiring;
 * the styles get appended to <head> at apply() time.
 */
export const STYLES: string = [
  // --- HUD-style toggle ---
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
  // model/reasoning-effort chip — dedicated element so long model ids stay
  // readable (the meta line truncates with ellipsis).
  ".dsp-model-chip { flex: none; font-size: 10px; line-height: 16px; padding: 0 6px; border-radius: 4px; background: var(--dsw-alias-state-info-tertiary, rgba(59,130,246,0.12)); color: var(--dsw-alias-state-info-primary, #1e6fdb); white-space: nowrap; }",
  ".dsp-row-open { flex: none; }",
  ".dsp-row-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 3px; padding-left: 18px; }",
  ".dsp-row-meta { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #a3aec2); font-size: 11px; line-height: 16px; }",
  ".dsp-row-time { color: var(--dsw-alias-label-tertiary, #94a3b8); font-variant-numeric: tabular-nums; flex: none; font-size: 11px; line-height: 16px; }",
  ".dsp-dot { width: 10px; height: 10px; flex: none; }",
  // --- Panel footer (HUD-style) ---
  ".dsp-panel-footer { display: flex; flex-direction: row; align-items: center; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--dsw-alias-border-l1, rgba(15, 23, 42, 0.06)); user-select: none; }",
  ".dsp-panel-footer-stats { display: flex; align-items: center; gap: 8px; flex: 1 1 auto; min-width: 0; flex-wrap: wrap; }",
  ".dsp-panel-footer-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; margin-left: auto; }",
  ".dsp-stat-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 999px; font-size: 11px; line-height: 16px; background: var(--dsw-alias-bg-layer-2, rgba(15, 23, 42, 0.04)); color: var(--dsw-alias-label-secondary, #4a5160); }",
  ".dsp-stat-num { font-weight: 600; font-variant-numeric: tabular-nums; min-width: 12px; text-align: center; }",
  ".dsp-stat-label { opacity: 0.85; }",
  ".dsp-stat-running .dsp-stat-num { color: var(--dsw-alias-state-info-primary, #1e6fdb); }",
  ".dsp-stat-completed .dsp-stat-num { color: var(--dsw-alias-state-success-primary, #16a34a); }",
  ".dsp-stat-failed .dsp-stat-num { color: var(--dsw-alias-state-danger-primary, #dc2626); }",
  // --- Settings section (role editor) ---
  ".dsp-section { display: flex; flex-direction: column; gap: 12px; padding: 12px; }",
  ".dsp-section-header { display: flex; align-items: baseline; gap: 8px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-primary, inherit); }",
  ".dsp-section-meta { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #94a3b8); }",
  // cards
  ".dsp-card { display: flex; flex-direction: column; gap: 8px; padding: 12px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,0.08)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,0.5)); }",
  ".dsp-card-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }",
  ".dsp-card-title { font-size: 12px; font-weight: 600; }",
  ".dsp-card-source { font-size: 10px; padding: 1px 6px; border-radius: 4px; background: var(--dsw-alias-state-info-tertiary, rgba(59,130,246,0.12)); color: var(--dsw-alias-state-info-primary, #1e6fdb); }",
  ".dsp-card-source.settings { background: var(--dsw-alias-state-warn-tertiary, rgba(255,180,0,0.15)); color: var(--dsw-alias-state-warn-primary, #b8821a); }",
  ".dsp-card-actions { margin-left: auto; display: flex; gap: 4px; }",
  ".dsp-card-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary, #94a3b8); }",
  // field rows (label + input, properly aligned)
  ".dsp-field-row { display: grid; grid-template-columns: 96px 1fr auto; align-items: center; gap: 8px; }",
  ".dsp-field-row > label { font-size: 11px; color: var(--dsw-alias-label-secondary, #4a5160); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }",
  ".dsp-field-row > input, .dsp-field-row > select, .dsp-field-row > textarea { font: inherit; font-size: 12px; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,0.10)); border-radius: 6px; background: var(--dsw-alias-bg-base, #ffffff); color: var(--dsw-alias-label-primary, inherit); outline: none; min-width: 0; }",
  ".dsp-field-row > input:focus, .dsp-field-row > select:focus, .dsp-field-row > textarea:focus { border-color: var(--dsw-alias-state-info-primary, #1e6fdb); box-shadow: 0 0 0 2px rgba(30,111,219,0.18); }",
  ".dsp-field-row > input:disabled, .dsp-field-row > select:disabled, .dsp-field-row > textarea:disabled { background: var(--dsw-alias-bg-layer-2, #f3f5f8); color: var(--dsw-alias-label-tertiary, #94a3b8); cursor: not-allowed; }",
  ".dsp-field-row > textarea { resize: vertical; min-height: 36px; line-height: 1.4; }",
  // buttons
  ".dsp-btn { font: inherit; font-size: 11px; padding: 3px 10px; border: 1px solid var(--dsw-alias-border-l1, rgba(15,23,42,0.12)); border-radius: 6px; background: var(--dsw-alias-bg-base, #ffffff); color: var(--dsw-alias-label-primary, inherit); cursor: pointer; }",
  ".dsp-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04)); }",
  ".dsp-btn:disabled { color: var(--dsw-alias-label-tertiary, #94a3b8); cursor: not-allowed; }",
  ".dsp-btn-primary { background: var(--dsw-alias-state-info-primary, #1e6fdb); color: #fff; border-color: var(--dsw-alias-state-info-primary, #1e6fdb); }",
  ".dsp-btn-primary:hover { background: #1859b3; border-color: #1859b3; }",
  // header back button (only visible when current session is itself a subagent)
  ".dsp-back { font-weight: 600; padding: 3px 10px; }",
  ".dsp-back:hover { background: var(--dsw-alias-state-warn-tertiary, rgba(255,180,0,0.18)); border-color: var(--dsw-alias-state-warn-primary, #e8a13a); color: var(--dsw-alias-state-warn-primary, #b8821a); }",
].join("\n") + "\n"
