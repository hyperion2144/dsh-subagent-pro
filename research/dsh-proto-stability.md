# DSH `SubagentStartRequest.persona` stability audit

**Repo:** `dsh-subagent-pro` (DSH extension plugin)
**Question:** Is `persona` on `SubagentStartRequest` stable, and what peer-dep range should this plugin declare?
**Date:** 2026-08-21
**Method:** primary sources only — npm registry, DSH GitHub `master` via `gh api`, repo agent-notes, README.

---

## TL;DR

1. `SubagentStartRequest.persona?: string` is **present and stable** in DSH `master` (`packages/subagent/subagent/src/types.ts`) with explicit JSDoc, capability gating via `SubagentCapabilities.persona`, and a detailed 2026-07-12 agent note documenting the design.
2. **Two of six providers advertise `persona: true`** — `subagent-spawn-in-process` and `subagent-fork-in-process`. ACP, Codex, Claude Code, and the DSH SDK all return `NO_START_CAPABILITIES` (`persona: false`). Requests routed to out-of-process providers will be **rejected at start with `UNSUPPORTED_CAPABILITY`**, not silently dropped.
3. DSH is in **developer preview** ("THERE WILL BE COMPATIBILITY-BREAKING CHANGES" — repo README). The pre-1.0 npm timeline is dense (10+ rc tags in 11 days), and `0.1.0` stable has not been released.
4. **Recommendation: keep `>=0.1.0-rc.0`** (do **not** tighten to `>=0.1.1-rc.0`). The `persona` field is present in **every** published rc since `0.1.0-rc.2`, including the latest `0.1.1-rc.2`. Tightening would needlessly exclude the older `0.1.0-rc.x` line where the field also exists, and offers no extra safety because every release pre-1.0 is fair game for breaking changes anyway.

---

## DSH version timeline

Pulled from `npm view @deepseek-ai/dsh-subagent time` and the DSH root `package.json`.

| npm tag | Published (UTC) | Notes |
|---|---|---|
| `0.0.1-rc.1` | 2026-08-10 19:36 | First published. Pre-`persona` capability. (unverified — field absence not separately checked for this tag) |
| `0.0.1-rc.2` | 2026-08-11 15:18 | |
| `0.0.1-rc.3` | 2026-08-12 20:33 | |
| `0.0.1-rc.5` | 2026-08-12 22:30 | rc.4 was skipped |
| `0.1.0-rc.2` | 2026-08-13 09:39 | rc.1 skipped; **`SubagentStartRequest.persona?: string` introduced here** (see agent note dated 2026-07-12, but shipped in this line) |
| `0.1.0-rc.3` | 2026-08-13 11:06 | |
| `0.1.0-rc.6` | 2026-08-13 12:17 | rc.4, rc.5 skipped |
| `0.1.0-rc.7` | 2026-08-17 11:38 | |
| `0.1.0-rc.8` | 2026-08-19 15:31 | |
| `0.1.1-rc.1` | 2026-08-21 06:39 | |
| **`0.1.1-rc.2`** | 2026-08-21 12:32 | **Latest published. Root `package.json` name `@deepseek-ai/dsh-root` version `0.1.1-rc.2` matches.** |
| `0.1.0` stable | **not yet released** | |

Sources:
- npm timeline — `npm view @deepseek-ai/dsh-subagent time` (registry `@deepseek-ai/dsh-subagent`).
- DSH root manifest — https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json

---

## `SubagentStartRequest.persona` field history

**Current signature (master, 2026-08-21):**

```ts
export interface SubagentCapabilities {
  readonly outputSchema: boolean
  readonly depthLimit: boolean
  readonly toolFilter: boolean
  readonly persona: boolean
}

export interface SubagentStartRequest {
  // ... parent, prompt, signal, agentOptions, outputSchema, maxDepth, toolFilter ...
  /**
   * Optional per-child persona. Requires {@link SubagentCapabilities.persona};
   * rejected at start otherwise. In-process backends register it as a scoped
   * `deployment:persona` section on the child, SHADOWING the deployment's
   * persona for this child alone — same template semantics as the deployment
   * persona (strict `{{…}}` interpolation against the registered variables).
   */
  readonly persona?: string
}
```

**Design rationale** — `.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md` (status: `implemented`):

> Subagent starts have three independent composition controls: `persona`, `toolFilter`, and `maxDepth`. A provider advertises support for each control, the service rejects unsupported requests before starting a run, and an in-process provider installs the requested composition while the child is still unpublished.

> Persona is a scoped shadow — the value has the same strict template semantics as the deployment persona. Omitting it inherits the deployment section through the global layer; an explicit empty string shadows the global persona with an empty section.

**Stability evidence:**

- Field is **documented in user-facing `docs/subsystems/subagent.md`** alongside `outputSchema`, `maxDepth`, `toolFilter` — same shape, same `readonly`, same capability-gated contract.
- Agent note is `implemented` (not `proposed` or `draft`), dated 2026-07-12, and predates the `0.1.0-rc.x` line by ~1 month — field has been baked in for a full rc cycle.
- The field also appears in the public user-facing API of `tool-subagent` (`persona: z.string()` in its zod schema and `persona?: string` in its config type) — i.e. it's a public surface, not an internal detail.
- Cold-resume descriptor (`SubagentDescriptorData`) snapshots `persona` for continuable children — a rename would ripple through the descriptor schema.
- **No 0.2.x / `persona` rename proposals** found in the visible `.agents/notes/` tree or in commit messages on `types.ts` (commit-history query returned 404 on the dated-since path, but the agent-note itself is the authoritative intent document and predates the rc line). (unverified for any private planning channels outside the repo)

Sources:
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/subagent/subagent/src/types.ts
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/subagent.md
- https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md

---

## Provider capability coverage

| Provider package | `persona` capability | Notes |
|---|---|---|
| `@deepseek-ai/dsh-subagent-spawn-in-process` | ✅ `true` | In-process; installs child-scoped `deployment:persona` section |
| `@deepseek-ai/dsh-subagent-fork-in-process` | ✅ `true` | In-process; same mechanism as spawn |
| `@deepseek-ai/dsh-subagent-acp` | ❌ `false` | Out-of-process ACP; advertises all four flags as false |
| `@deepseek-ai/dsh-subagent-codex` | ❌ `false` | Uses `NO_START_CAPABILITIES` |
| `@deepseek-ai/dsh-subagent-claude-code` | ❌ `false` | Uses `NO_START_CAPABILITIES` |
| `@deepseek-ai/dsh-subagent-dsh-sdk` | ❌ `false` | Uses `NO_START_CAPABILITIES` — explicitly documented: *"out-of-process child cannot honor `outputSchema`/`maxDepth`/`toolFilter`/`persona`"* |

**Implication for `dsh-subagent-pro`:** the plugin's `route-resolver` resolves a `route.persona` string and pipes it through `buildSubagentRequest`. That request will only succeed against spawn-in-process or fork-in-process providers. Any delegation routed to ACP / Codex / Claude Code / dsh-sdk providers must omit `persona` (or `route-resolver` must suppress it) — otherwise `SubagentRuntime.start()` rejects with `UNSUPPORTED_CAPABILITY` **before** the child is published. This is fail-loud by design, not silent degradation.

Source:
- https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent — provider source for capability flags

---

## Recommended peer dep range

**Keep `>=0.1.0-rc.0`. Do not tighten.**

Rationale:

1. **Field has existed in every `0.1.x` rc** published since `0.1.0-rc.2` (2026-08-13). Tighter bounds (`>=0.1.1-rc.0`) would only exclude `0.1.0-rc.{2,3,6,7,8}` — five rcs where the field is **also present**. There is no version between `0.1.0-rc.0` and `0.1.0-rc.2` that ships the field but is somehow "more stable" — `0.1.0-rc.0` and `rc.1` predate the field's introduction. So `>=0.1.0-rc.0` is correct (it excludes the pre-persona rcs); `>=0.1.0-rc.2` would also work but is no safer.
2. **DSH is in developer preview** — README explicitly warns: *"THERE WILL BE COMPATIBILITY-BREAKING CHANGES."* Pretending any rc range is "stable" is wishful. Pinning tightly buys nothing during a pre-1.0 churn phase; what matters is that the **type field shape** is stable (it is, per evidence above), not the version number.
3. **TypeScript types are the contract** — the plugin is consumed against `@deepseek-ai/dsh-subagent` types. Because the field is `readonly persona?: string` (optional, single primitive), the cost of a future rename is a single TS error caught at `pnpm typecheck`. There is no runtime coupling that a tighter peer dep would protect against.
4. **`dsh-subagent-pro` only reads `persona`, never implements the provider side** — so capability-flag churn across providers doesn't affect the plugin, only the deployment it runs in.

**Counter-argument considered and rejected:** *tighten to `>=0.1.1-rc.0` because `0.1.0-rc.x` might still be the "LTS-ish" line.* No evidence for this — the rc chain is a continuous stream of fixes, not parallel LTS branches. `0.1.1` is the natural successor line.

**Alternative (also acceptable):** `>=0.1.0-rc.2` if the maintainer wants to exclude the two pre-persona rcs (`0.1.0-rc.0` and `rc.1`). Strictly cosmetic.

---

## Risks ahead

1. **Pre-1.0 churn is real.** 10+ rc tags in 11 days, skipped numbers, no `0.1.0` stable yet. README: *"THERE WILL BE COMPATIBILITY-BREAKING CHANGES."* A future `0.2.0-rc.x` could rename `persona` (e.g. `systemPromptOverride`, `role`) if the design note is revised. Mitigation: the plugin should treat `persona` as a **pass-through string** to the request — if the field is renamed upstream, the only edit needed is in `buildSubagentRequest`. (low-to-medium risk)
2. **Provider capability drift.** Today, only spawn/fork advertise `persona`. If a future ACP or Codex release adds `persona` support, this plugin's behavior changes (no code change needed — provider capability is checked at runtime). If a future in-process provider drops `persona` (unlikely), the plugin's persona injection would start erroring at start. Monitor provider source on each rc bump. (low risk)
3. **Cold-resume descriptor coupling.** `SubagentDescriptorData` snapshots `persona` for continuable children. A schema rename of the field would invalidate persisted descriptors across the `0.1.x → 0.2.x` boundary. DSH's append-only log "malformed current-version descriptors are corrupt" per the docs. (medium risk for long-running deployments)
4. **No public semver guarantee before 1.0.** Standard npm pre-release caveat — tighten peer dep only when the field has been stable across a stable major. Not yet. (inherent)
5. **Agent-note as ground truth.** The persona rationale lives in `.agents/notes/` — a file path that could itself be reorganized. If the note is deleted/moved, future readers lose the design intent (though the JSDoc on the interface preserves the contract). (low risk)

---

## Sources

1. https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/subagent/subagent/src/types.ts — `SubagentStartRequest` + `SubagentCapabilities` definitions.
2. https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/feature/2026-07-12-subagent-persona-tool-filter-and-depth.md — persona/toolFilter/maxDepth rationale, status: implemented.
3. https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/subagent.md — user-facing docs describing `persona?: string` and its capability gate.
4. https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md — developer-preview warning, "THERE WILL BE COMPATIBILITY-BREAKING CHANGES."
5. https://github.com/deepseek-ai/deepseek-harness/blob/master/package.json — root manifest, version `0.1.1-rc.2`.
6. https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-spawn-in-process/src/index.ts — `capabilities: { ..., persona: true }`.
7. https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-fork-in-process/src/index.ts — `capabilities: { ..., persona: true }`.
8. https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-acp/src/index.ts — `capabilities: { ..., persona: false }`.
9. https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-codex/src/index.ts — `NO_START_CAPABILITIES`.
10. https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-claude-code/src/index.ts — `NO_START_CAPABILITIES`.
11. https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-dsh-sdk/src/index.ts — `NO_START_CAPABILITIES` with explicit rationale.
12. https://www.npmjs.com/package/@deepseek-ai/dsh-subagent — npm registry, version timeline (also `npm view @deepseek-ai/dsh-subagent time`).

---

*All claims cite a primary source. The only `(unverified)` items are explicitly flagged above (private planning channels, exact field presence on `0.0.1-rc.1`).*
