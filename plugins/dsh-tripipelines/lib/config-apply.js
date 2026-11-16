// dsh-tripipelines — v134: the ONE layer-aware config-change pipeline, shared by
// the /pipe-config slash command and the L1-callable pipeline_config_set tool.
//
// Before this file existed the sequence lived inline in plugin.js's pipe-config
// handler; pipeline_model_setup carried its own copy of the persistence step and
// wrote GLOBAL config.json only — so a workspace with a project layer
// (<devDir>/pipeline-project.json) had its model choice silently re-shadowed at
// the next store load (same bug class C7 fixed for /pipe-config in v132).
// Everything that changes configuration now funnels through here:
//   parse/validate (handleConfigCommand) → project-layer redirect → provider
//   pairing + sweet-spot tuning (autoPairAfterConfig) → pairing corrections
//   re-synced into the SAME layer as the edit.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

import { DEFAULT_CONFIG, handleConfigCommand, loadProjectConfig, savePersistedConfig } from './config.js'
import { autoPairAfterConfig } from './models.js'
import { resolveInside } from './util.js'

// Where <devDir>/pipeline-project.json lives for a workspace root (null when the
// root is unknown or the path escapes the workspace — resolveInside throws).
export function projectFileOf(root, devDir) {
  if (!root) return null
  try {
    const devAbs = resolveInside(root, devDir || DEFAULT_CONFIG.devDir, 'devDir')
    return { devAbs, file: join(devAbs, 'pipeline-project.json') }
  } catch {
    return null
  }
}

function writeProjectFile(loc, merged) {
  mkdirSync(loc.devAbs, { recursive: true })
  writeFileSync(loc.file, JSON.stringify(merged, null, 2), 'utf8')
}

// Layer-aware persistence for callers that compute their own patch object
// (pipeline_model_setup). Persists globally like savePersistedConfig did, and —
// when THIS workspace carries a project layer — re-syncs EVERY project key from
// the merged view into <devDir>/pipeline-project.json so pairing/tuning
// corrections land in the same layer as the explicit change (pre-v134 they went
// global-only and were silently re-shadowed by the project file next load).
// `root` names the workspace whose layer to mirror into (the caller resolves it:
// the registry entry matching its mutated cfg, or its store's workspaceRoot).
// Returns true when the project layer was written. Best-effort: never throws.
export function persistConfigPatch(cfg, root, patch) {
  const keys = Object.keys(patch ?? {})
  if (keys.length === 0) return false
  // v134 — `cfg` here may be the per-root MERGED view (registry.ensure spreads
  // {...globalCfg, ...projectLayer}); writing it whole would leak every merged
  // default into the global file. Persist only the caller's explicit keys there;
  // the project-file re-sync below still carries the full live view.
  const globalPatch = {}
  for (const k of keys) globalPatch[k] = patch[k]
  try {
    // Global layer: keep whatever persisted there consistent too (a later reset
    // of the project layer should fall back to these values, not to stale ones).
    savePersistedConfig(globalPatch)
  } catch { /* best-effort */ }
  if (!root) return false
  try {
    const projLayer = loadProjectConfig(cfg.devDir, root)
    const loc = projectFileOf(root, cfg.devDir)
    if (!loc) return false
    // v134 — a model choice must SURVIVE in a project-layer workspace even when
    // that workspace had no project file before: writing an empty layer means the
    // next store load rebuilds wsCfg from the global file only, and if any other
    // workspace then heals/persists a different level2Model globally, this
    // project's choice is silently re-shadowed (the exact C7 bug class). So:
    // non-empty layer → re-sync every project key from the merged view;
    // empty/no layer → seed it with just the explicit patch keys.
    const merged = { ...projLayer }
    if (Object.keys(projLayer).length > 0) {
      for (const k of Object.keys(projLayer)) if (k in cfg) merged[k] = cfg[k]
      // The explicit patch may carry keys the layer never had (e.g. heal added
      // them mid-flight); those land via cfg anyway only if listed — merge them
      // directly so the writer's intent is never dropped.
      for (const k of keys) merged[k] = cfg[k] !== undefined ? cfg[k] : patch[k]
    } else {
      for (const k of keys) merged[k] = cfg[k] !== undefined ? cfg[k] : patch[k]
    }
    writeProjectFile(loc, merged)
    return true
  } catch {
    return false
  }
}

// The full change pipeline. `source` is anything the registry can route
// (an invocation for the command path, an exec for the tool path); pass null for
// session-less hosts — then this behaves exactly like the pre-v132 global flow.
// Returns { result, redirected } where result is handleConfigCommand's
// {kind,text,changed?}, possibly with extra note lines appended.
export async function applyConfigChange(ctx, cfg, registry, rawInput, source) {
  let entry = null
  try {
    entry = registry?.peek?.(source) ?? registry?.resolve?.(source) ?? null
  } catch {
    // A host without session plumbing (verify harness, bare daemon) simply has no
    // workspace context: fall back to the global view exactly like pre-v132.
  }
  const wsCfg = entry?.cfg || cfg
  // v132 (C7): reset's project-layer warning must read the ANCHORED path
  // (<root>/<devDir>/pipeline-project.json), not the cwd-relative legacy one.
  const result = handleConfigCommand(wsCfg, rawInput, { workspaceRoot: entry?.root })
  let redirected = false
  if (result?.kind === 'success' && Array.isArray(result.changed) && result.changed.length > 0 && entry?.root) {
    try {
      const projLayer = loadProjectConfig(wsCfg.devDir, entry.root)
      if (Object.keys(projLayer).length > 0) {
        const loc = projectFileOf(entry.root, wsCfg.devDir)
        if (loc) {
          const merged = { ...projLayer }
          for (const k of result.changed) merged[k] = wsCfg[k]
          writeProjectFile(loc, merged)
          redirected = true
          result.text = `${result.text}\n（本项目存在 ${relative(entry.root, loc.file).replace(/\\/g, '/')}，改动已写入项目层而不是全局配置）`
        }
      }
    } catch { /* best-effort: global persistence already happened */ }
  }
  if (result?.kind !== 'success' || !Array.isArray(result.changed) || result.changed.length === 0) return { result, redirected }
  try {
    // v130 — pass the workspace store so the L1 retune can read the live
    // session's real context window (store.context.level1Window).
    const l1Store = entry?.r?.store ?? null
    const notes = await autoPairAfterConfig(ctx, wsCfg, result.changed, {
      store: l1Store,
      // v134: pairing/tuning corrections persist through the SAME layer decision
      // as the edit itself (previously they always went global).
      persist: (pairPatch) => {
        if (redirected && entry?.root) {
          try {
            const projLayer = loadProjectConfig(wsCfg.devDir, entry.root)
            const loc = projectFileOf(entry.root, wsCfg.devDir)
            if (loc) {
              const merged = { ...projLayer }
              for (const k of Object.keys(projLayer)) if (k in wsCfg) merged[k] = wsCfg[k]
              writeProjectFile(loc, merged)
            }
          } catch { /* best-effort */ }
          // The global save below still runs (persistConfigPatch semantics keep
          // both layers consistent); here we only ensure the project file wins.
          savePersistedConfig(pairPatch)
        } else {
          savePersistedConfig(pairPatch)
        }
      },
    })
    if (notes.length > 0) result.text = `${result.text}\n${notes.join('\n')}`
  } catch {
    // pairing is best-effort; the config change itself already succeeded
  }
  return { result, redirected }
}
