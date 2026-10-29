// dsh-pipeline — Web UI half of the GUI board. ONE widget, ONE place: a small card in the
// sidebar foot dock (next to the cost/token entries) with a status pill, budget progress
// bar and milestone count, polled from GET /pipeline/board (host half: lib/board-route.js).
// There is deliberately no second seat: no composer strip and no floating card, so the
// plugin never duplicates itself.
//
// Loader contract (see the decoration template): the factory must be
// side-effect-free apart from returning the slot plugin; all resources are owned
// by the slot registration and released on unload.
window.__ModuleLoader__.load({
  id: 'dsh-pipeline',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const POLL_MS = 2500
    const C = {
      text: 'var(--dsw-alias-label-primary)',
      sub: 'var(--dsw-alias-label-secondary)',
      ok: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
      // Finished levels get a calm blue bar regardless of how full it was.
      done: '#60a5fa',
    }
    const STATUS_LABEL = { active: '运行中', paused: '已暂停', done: '已完成', idle: '待命' }
    // Sidebar card (v94): sized by its parent slot (100% width, box-sizing border-box) so it
    // matches the sidebar column exactly instead of a fixed width; 13px text follows the
    // cost-meter card's rhythm, colours come only from the theme's alias tokens.
    const CARD = {
      boxSizing: 'border-box',
      width: '100%',
      display: 'flex',
      flexDirection: 'column',
      gap: 4,
      margin: '8px 0',
      padding: '9px 10px',
      borderRadius: 8,
      background: 'var(--dsw-alias-bg-layer-1)',
      border: '1px solid var(--dsw-alias-border-l1)',
      minWidth: 0,
      fontSize: 12,
      lineHeight: '18px',
      color: 'var(--dsw-alias-label-primary)',
      userSelect: 'none',
    }
    const ROW = {
      display: 'flex',
      alignItems: 'baseline',
      gap: 6,
      minWidth: 0,
      whiteSpace: 'nowrap',
      overflow: 'hidden',
    }

    function fmtCount(n) {
      const v = Number(n) || 0
      return v >= 1000 ? `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K` : String(v)
    }

    // v110 — follow the DSH workspace the user is looking at. The sidebar card has
    // no session prop, but every slot component receives the standard `useSessions`
    // hook; the shell marks the main view's session with retainedBy.mainView > 0,
    // so that session's cwd is the active workspace. v108/v109 persisted the pick in
    // localStorage, which pinned the card to a stale project across workspace
    // switches and refreshes; the explicit picker is now session-only, and clearing
    // the legacy key raises everyone back to "follow the current workspace".
    const PICK_KEY = 'dsh-pipeline.workspace'
    let pickedKey = null
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        window.localStorage.removeItem(PICK_KEY)
      }
    } catch {
      /* storage unavailable -> nothing to clear */
    }
    const pickSinks = new Set()
    function pickWorkspace(key) {
      const next = key ? String(key) : null
      if (next === pickedKey) return
      pickedKey = next
      for (const sink of pickSinks) sink()
    }
    function usePickedWorkspace() {
      const [, force] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => {
        pickSinks.add(force)
        return () => pickSinks.delete(force)
      }, [force])
      return pickedKey
    }

    // The session rendered in the main view. `retainedBy.mainView` is the marker the
    // shell's own mainSessionId() uses (see client-ui-workspace), and `cwd` is the
    // workspace path the board route normalizes back into a registry key.
    function selectMainCwd(sessions) {
      if (!sessions || !sessions.byId) return null
      for (const item of Object.values(sessions.byId)) {
        if (!item || !item.retainedBy || !(item.retainedBy.mainView > 0)) continue
        if (typeof item.cwd === 'string' && item.cwd) return item.cwd
      }
      return null
    }
    function useCurrentCwd(props) {
      const useSessions = props && typeof props.useSessions === 'function' ? props.useSessions : null
      if (!useSessions) return null
      return useSessions(selectMainCwd) || null
    }

    function useBoard(workspaceKey) {
      const [snap, setSnap] = React.useState(null)
      React.useEffect(() => {
        let alive = true
        let timer = 0
        const url = workspaceKey
          ? `/pipeline/board?workspace=${encodeURIComponent(workspaceKey)}`
          : '/pipeline/board'
        const schedule = () => {
          if (alive) timer = setTimeout(tick, POLL_MS)
        }
        const tick = async () => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
            schedule()
            return
          }
          try {
            const res = await fetch(url, { cache: 'no-store' })
            if (!alive) return
            // v106: keep the last good snapshot on a failed poll. A cold daemon with no
            // workspace store yet used to answer 404 here, and nulling the snapshot made
            // the whole sidebar card vanish; the server now answers idle, and a transient
            // error must never erase what we already showed.
            if (res.ok) {
              const data = await res.json()
              if (data && data.ok) setSnap(data)
            }
          } catch {
            /* keep the last snapshot */
          }
          schedule()
        }
        tick()
        return () => {
          alive = false
          if (timer) clearTimeout(timer)
        }
      }, [workspaceKey])
      return snap
    }

    // v108 — workspace switcher. It only appears when the daemon knows more than
    // one project; picking one re-points the poll at ?workspace=<key>, and the
    // host loads that project's store from disk on demand. v110 — the first entry
    // ("follow") returns to the live DSH workspace; a pick stays session-only so a
    // workspace switch in the app always wins by default.
    function workspacePicker(snap, picked, cwd, onPick) {
      const list = Array.isArray(snap && snap.workspaces) ? snap.workspaces : []
      if (list.length < 2) return null
      return h(
        'select',
        {
          'aria-label': '切换工作区',
          title: '切换看板显示的工作区',
          value: picked || '',
          onChange: (e) => onPick(e.target.value || null),
          style: {
            maxWidth: 132,
            marginLeft: 'auto',
            fontSize: 10,
            lineHeight: '14px',
            color: C.sub,
            background: 'transparent',
            border: '1px solid var(--dsw-alias-border-l1)',
            borderRadius: 4,
            padding: '1px 2px',
            cursor: 'pointer',
            flex: 'none',
          },
        },
        h('option', { key: '__follow__', value: '' }, cwd ? '跟随当前工作区' : '自动（最近工作区）'),
        list.map((w) => h('option', { key: w.key, value: w.key }, `${w.name}${w.active ? ' · 当前' : ''}`)),
      )
    }

    // The sidebar card: muted "待命" block before any run (still proves the plugin is
    // mounted), then a two-line card — state + milestone progress on top, budget and live
    // L2s below. Hovering shows the full detail (run id, milestones, L2s, recent events).
    function PipelineBoard(props) {
      const wide = !props || props.wide !== false
      const picked = usePickedWorkspace()
      // v110 — the shell hands every slot component the standard useSessions hook; the
      // session it renders in the main view carries the active workspace path. Unless
      // the user pinned a workspace in the picker, the card follows that path, so
      // switching workspaces in the app re-points the poll without needing a message
      // or any pipeline activity in the target project. The picker's "跟随当前工作区"
      // entry clears the pick again.
      const cwd = useCurrentCwd(props)
      const followKey = picked || cwd || null
      const snap = useBoard(followKey)
      // A workspace removed from disk disappears from the host list; drop the stale
      // pick so the next poll falls back to the host default instead of 404ing.
      React.useEffect(() => {
        if (!snap || !picked) return
        const list = Array.isArray(snap.workspaces) ? snap.workspaces : []
        if (list.length > 0 && !list.some((w) => w.key === picked)) pickWorkspace(null)
      }, [snap, picked])
      if (!snap || !snap.run) return null
      const run = snap.run
      const idle = !run.status || run.status === 'idle'
      const activeWs = (Array.isArray(snap.workspaces) ? snap.workspaces : []).find((w) => w.active)
      const wsName = activeWs ? activeWs.name : ''
      if (!wide) {
        // Collapsed sidebar (56px rail): no card fits, so degrade to one icon-sized
        // marker whose tooltip carries the state.
        return h(
          'div',
          {
            'data-pipeline-board': '1',
            title: idle
              ? `流水线待命${wsName ? ` · ${wsName}` : ''}`
              : `流水线 ${STATUS_LABEL[run.status] || run.status}${wsName ? ` · ${wsName}` : ''}`,
            style: {
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 14,
              lineHeight: '18px',
              color: idle ? C.sub : C.warn,
              userSelect: 'none',
            },
          },
          idle ? '◫' : '▣',
        )
      }
      if (idle) {
        return h(
          'div',
          {
            'data-pipeline-board': '1',
            title: '流水线待命：用 pipeline_lock_requirements 开始一个开发任务后，这里会显示状态、里程碑与预算',
            style: { ...CARD, opacity: 0.6 },
          },
          h('div', { style: { ...ROW, color: C.sub } }, '◫ 流水线待命'),
          workspacePicker(snap, picked, cwd, pickWorkspace),
        )
      }
      const milestones = snap.milestones || []
      const agents = snap.agents || []
      const events = snap.recentEvents || []
      const budget = snap.budget || {}
      const accepted = milestones.filter((m) => m.state === 'accepted').length
      const doneUnaccepted = milestones.filter((m) => m.state === 'done')
      const paused = run.paused === true
      const accent = paused || run.status === 'active' ? C.warn : run.status === 'done' ? C.ok : C.idle
      const detail = [
        `run: ${run.id || '(none)'} · ${STATUS_LABEL[run.status] || run.status}${paused ? `（${run.pauseReason || '已暂停'}）` : ''}`,
        `工作区: ${wsName || picked || cwd || '(host default)'}`,
        `甜点区: L1 ${fmtCount(snap.context?.level1?.tokens)}/${fmtCount(snap.context?.level1?.budget)} · L2 ${fmtCount(snap.context?.level2?.tokens)}/${fmtCount(snap.context?.level2?.budget)}`,
        ...milestones.map((m) => `· ${m.name}: ${m.state} (${m.done}/${m.total})`),
        ...agents.map((a) => `· L2 ${a.label}: ${a.state}${a.scopeDir ? ` @ ${a.scopeDir}` : ''}`),
        ...events.map((e) => `· ${e.type}: ${e.text}`),
      ].join('\n')
      const pillBg =
        run.status === 'done'
          ? 'rgba(74,222,128,.16)'
          : paused
            ? 'rgba(251,146,60,.18)'
            : run.status === 'active'
              ? 'rgba(251,191,36,.18)'
              : 'rgba(255,255,255,.10)'
      const subs = snap.subtasks || { total: 0, done: 0, failed: 0 }
      // v94 — per-level sweet-spot meters, one row each: label / value / mini bar.
      // Green = room left, amber = near the sweet spot, red = past it.
      const ctxInfo = snap.context || {}
      const l1spot = ctxInfo.level1 || { tokens: 0, budget: 0 }
      const l2spot = ctxInfo.level2 || { tokens: 0, budget: 0 }
      const models = ctxInfo.models || { level1: '', level2: '' }
      // Short, human-readable model tag ("deepseek-pro" -> "pro", "qwen3:14b" -> "qwen3:14b").
      const shortModel = (id) => {
        const s = String(id ?? '').trim()
        if (!s) return '—'
        const base = s.includes(':') ? s.split(':')[0] : s.replace(/^deepseek-/, '')
        return base.length > 12 ? `${base.slice(0, 11)}…` : base
      }
      const spotColor = (tokens, budget, danger) => {
        const lim = Number(danger) > 0 ? Number(danger) : Number(budget)
        if (!(lim > 0)) return C.idle
        if (Number(tokens) >= lim) return C.error
        if (Number(budget) > 0 && Number(tokens) >= Number(budget)) return C.warn
        return C.ok
      }
      // v97b — the bar is three fixed zones across the whole model window:
      //   green  = sweet spot         (0    → sweet budget)
      //   amber  = transition headroom(sweet→ danger line)
      //   red    = capability collapse(danger → window)
      // Zone colours never change; the current reading is a white tick on top, so it
      // stays readable inside whichever zone it sits in.
      const meter = (label, tokens, budget, color, key, finished, finishLabel, top, barH, caption, danger, contextWindow) => {
        const cap = Number(budget) || 0
        const used = Number(tokens) || 0
        const lim = Number(danger) > 0 ? Number(danger) : 0
        const win = Number(contextWindow) > 0 ? Number(contextWindow) : Math.max(lim, cap) || 0
        const bas = win > 0 ? win : Math.max(lim, cap)
        const pct = finished ? 100 : Math.max(0, Math.min(100, Math.round((bas > 0 ? used / bas : 0) * 100)))
        const inDanger = lim > 0 && used >= lim
        const inWarn = cap > 0 && used >= cap && !inDanger
        const sweetPct = bas > 0 && cap > 0 ? Math.max(3, Math.min(97, Math.round((cap / bas) * 100))) : 30
        const dangerPct = bas > 0 && lim > 0 ? Math.max(sweetPct + 2, Math.min(99, Math.round((lim / bas) * 100))) : 97
        const track = finished
          ? C.done
          : `linear-gradient(to right, rgba(52,211,153,.88) 0 ${sweetPct}%, rgba(251,191,36,.90) ${sweetPct}% ${dangerPct}%, rgba(248,81,73,.92) ${dangerPct}% 100%)`
        const valueColor = finished ? C.done : inDanger ? C.error : inWarn ? C.warn : C.text
        const titleText =
          lim > 0
            ? `${label}｜甜点 ${fmtCount(cap)}｜危险线 ${fmtCount(lim)}｜窗口 ${fmtCount(win)}（红区=能力打折）`
            : label
        return h(
          'div',
          { key, style: { display: 'flex', flexDirection: 'column', gap: 3, marginTop: top ?? 6 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0, fontSize: 11, lineHeight: '15px' } },
            h(
              'span',
              {
                style: { color: C.sub, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                title: titleText,
              },
              label,
            ),
            // Tiny caption keeps the numbers self-explanatory on a stranger's screen.
            caption
              ? h(
                  'span',
                  {
                    style: { color: C.sub, flex: 'none', fontSize: 9.5, lineHeight: '14px', opacity: 0.78, letterSpacing: 0.2 },
                  },
                  caption,
                )
              : null,
            finished
              ? h('span', { style: { color: C.done, fontWeight: 600, flex: 'none' } }, finishLabel || '已完成')
              : h(
                  'span',
                  { style: { color: cap > 0 ? valueColor : C.sub, fontWeight: 600, flex: 'none', fontVariantNumeric: 'tabular-nums' } },
                  cap > 0 ? `${fmtCount(used)}/${fmtCount(cap)}` : '—',
                ),
            finished
              ? null
              : h(
                  'span',
                  {
                    style: { color: inDanger ? C.error : C.sub, flex: 'none', width: 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
                  },
                  cap > 0 ? `${pct}%` : '—',
                ),
          ),
          h(
            'div',
            {
              style: {
                position: 'relative',
                height: barH ?? 4,
                borderRadius: 99,
                background: track,
                overflow: 'hidden',
              },
            },
            // Zone boundaries: sweet line (green→amber) and danger line (amber→red).
            cap > 0 && sweetPct < 96
              ? h('div', {
                  style: { position: 'absolute', left: `${sweetPct}%`, top: 0, bottom: 0, width: 1, background: 'rgba(0,0,0,.55)' },
                })
              : null,
            lim > 0 && dangerPct < 96 && dangerPct > sweetPct + 1
              ? h('div', {
                  style: { position: 'absolute', left: `${dangerPct}%`, top: 0, bottom: 0, width: 1, background: 'rgba(0,0,0,.55)' },
                })
              : null,
            // Current reading: a bright tick, not a re-coloured fill, so the three
            // zone colours stay visible.
            !finished && pct > 0
              ? h('div', {
                  style: {
                    position: 'absolute',
                    left: `calc(${pct}% - 1px)`,
                    top: -1,
                    bottom: -1,
                    width: 2,
                    borderRadius: 1,
                    background: 'rgba(255,255,255,.95)',
                    boxShadow: '0 0 2px rgba(0,0,0,.7)',
                  },
                })
              : null,
          ),
        )
      }
      // L3 counts discrete subtasks, not a token pressure, so a continuous bar
      // misleads: draw one slim cell per subtask (done green / failed red / pending
      // dim). Cells keep a fixed slim width so 3 tasks never stretch into fat blocks
      // and 20 tasks still fit on one row. A fully finished run paints them blue.
      const segments = (label, done, total, failed, key) => {
        const totalN = Math.max(0, Number(total) || 0)
        const doneN = Math.max(0, Number(done) || 0)
        const failedN = Math.max(0, Number(failed) || 0)
        const allDone = totalN > 0 && doneN >= totalN && failedN === 0
        const MAX = 20
        const shown = Math.min(totalN, MAX)
        const cells = []
        for (let i = 0; i < shown; i += 1) {
          let bg = 'rgba(255,255,255,.12)'
          if (allDone) bg = C.done
          else if (i < doneN) bg = C.ok
          else if (i < doneN + failedN) bg = C.error
          cells.push(
            h('div', {
              key: `c${i}`,
              title: i < doneN ? '已完成' : i < doneN + failedN ? '失败' : '待做',
              style: { flex: '0 0 auto', width: 7, height: 3, borderRadius: 1.5, background: bg },
            }),
          )
        }
        return h(
          'div',
          { key, style: { display: 'flex', flexDirection: 'column', gap: 4, marginTop: 9 } },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0, fontSize: 11, lineHeight: '15px' } },
            h('span', { style: { color: C.sub, flex: '1 1 auto', minWidth: 0 } }, label),
            h(
              'span',
              { style: { color: C.sub, flex: 'none', fontSize: 9.5, lineHeight: '14px', opacity: 0.78, letterSpacing: 0.2 } },
              '子任务',
            ),
            allDone
              ? null
              : h(
                  'span',
                  { style: { color: C.text, fontWeight: 600, flex: 'none', fontVariantNumeric: 'tabular-nums' } },
                  `${doneN}/${totalN}`,
                ),
          ),
          totalN > 0 ? h('div', { style: { display: 'flex', gap: 3, alignItems: 'center', flexWrap: 'wrap' } }, cells) : null,
          totalN > shown
            ? h('div', { style: { color: C.sub, fontSize: 9.5, lineHeight: '12px' } }, `另有 ${totalN - shown} 个`)
            : null,
        )
      }
      return h(
        'div',
        { 'data-pipeline-board': '1', title: detail, style: CARD },
        // Layer 1 — the title block. Brand + name + state on the top line; the two
        // progress figures sit tight under it in smaller/dimmer type so they read as
        // belonging to the title, not as another meter row.
        h(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
          // Brand mark: an orange "M" for MERHENTZ (a rounded M stroke), not a tool emoji.
          h(
            'div',
            { style: { ...ROW, gap: 5 } },
            h(
              'svg',
              {
                width: 14,
                height: 14,
                viewBox: '0 0 16 16',
                'aria-hidden': 'true',
                style: { flex: 'none', display: 'block' },
              },
              h('path', {
                d: 'M2.2 13V3.4L8 9.4L13.8 3.4V13',
                fill: 'none',
                stroke: '#ff8a3d',
                strokeWidth: 2.4,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
              }),
            ),
            h('span', { style: { color: C.text, fontWeight: 700, fontSize: 13 } }, '流水线'),
            h(
              'span',
              {
                style: {
                  color: accent,
                  fontWeight: 600,
                  fontSize: 11,
                  lineHeight: '16px',
                  padding: '1px 6px',
                  borderRadius: 999,
                  background: pillBg,
                  flex: 'none',
                  marginLeft: 'auto',
                },
              },
              paused ? '已暂停' : STATUS_LABEL[run.status] || run.status,
            ),
          ),
          // Sub row: smaller than everything below it, so hierarchy reads top-down.
          h(
            'div',
            { style: { display: 'flex', alignItems: 'baseline', gap: 6, minWidth: 0, fontSize: 10.5, lineHeight: '14px' } },
            milestones.length
              ? h(
                  'span',
                  { style: { color: '#ff8a3d', fontWeight: 700, fontSize: 11.5, whiteSpace: 'nowrap', flex: 'none' } },
                  `里程碑 ${accepted}/${milestones.length}`,
                )
              : h('span', { style: { color: C.sub, whiteSpace: 'nowrap' } }, '无里程碑'),
            h(
              'span',
              { style: { marginLeft: 'auto', color: C.sub, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', flex: 'none' } },
              `${fmtCount(budget.tokensUsed || 0)}/${fmtCount(budget.maxTokens || 0)}`,
            ),
          ),
          workspacePicker(snap, picked, cwd, pickWorkspace),
        ),
        // Divider: the title block ends here; everything below is the level board.
        h('div', { style: { height: 1, background: 'rgba(255,255,255,.08)', margin: '7px 0 1px' } }),
        // L1 header carries its model on the same line; L2 rows carry the lead name
        // and its model. Bar thickness encodes the layer (L1 thickest, L3 thinnest);
        // levels are separated by a modest gap so the card stays dense but grouped.
        meter(
          `L1 ${shortModel(models.level1)}`,
          l1spot.tokens,
          l1spot.budget,
          spotColor(l1spot.tokens, l1spot.budget, l1spot.danger),
          'l1',
          run.status === 'done',
          '已完成',
          0,
          5,
          null,
          l1spot.danger,
          l1spot.window,
        ),
        // Every lead gets a row — a finished one keeps its (blue, full) bar and says
        // 已完成/已结束 on the right, so the card still shows who worked when a run ends.
        ...(agents.length
          ? agents
              .slice()
              .sort((a, b) => {
                const rank = (x) => (x.state === 'done' || x.state === 'replaced' ? 2 : x.state === 'failed' ? 1 : 0)
                return rank(a) - rank(b)
              })
              .slice(0, 4)
              .map((a, i) => {
                const finished = a.state === 'done' || a.state === 'replaced'
                const failed = a.state === 'failed'
                // v94d: `tokens` is measured from the lead's own session by the host
                // (tokenMeter — local, no model call) and cached when it finishes.
                // v96b: `measured:false` means the host could not replay the lead's
                // session (e.g. already released), so the number is the spawn-time
                // prompt footprint — label it 估 so a static value is not mistaken
                // for a stalled meter.
                const live = a.measured === true
                const measured = typeof a.tokens === 'number' && a.tokens > 0
                const usedTokens = measured ? a.tokens : Number(a.estimatedTokens) || 0
                const estimateTag = !live && !finished ? ' · 估' : ''
                return meter(
                  `L2 ${a.label} · ${shortModel(a.model || models.level2)}${estimateTag}`,
                  usedTokens,
                  l2spot.budget,
                  failed ? C.error : live ? spotColor(usedTokens, l2spot.budget, l2spot.danger) : C.sub,
                  a.id,
                  finished,
                  a.state === 'replaced' ? '已结束' : '已完成',
                  i === 0 ? 9 : 4,
                  3,
                  null,
                  l2spot.danger,
                  l2spot.window,
                )
              })
          : [meter('L2', 0, l2spot.budget, C.idle, 'l2-none', false, null, 9, 3, null, l2spot.danger, l2spot.window)]),
        agents.length > 4
          ? h(
              'div',
              { style: { ...ROW, color: C.sub, fontSize: 11, lineHeight: '16px', marginTop: 4 } },
              `L2 另有 ${agents.length - 4} 个（悬浮查看全部）`,
            )
          : null,
        segments('L3', subs.done, subs.total, subs.failed, 'l3'),
        doneUnaccepted.length
          ? h(
              'div',
              { style: { ...ROW, gap: 4, color: C.warn, fontSize: 11, lineHeight: '15px', marginTop: 10 } },
              '⚠️ 待验收',
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Single seat (v94): the sidebar foot dock — same zone as the token/cost entries.
        // One widget, one place; nothing is drawn in the composer area or as a card.
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'pipeline-board',
              order: 1,
              label: '流水线',
            },
            PipelineBoard,
          ),
        )
      },
    }
  },
})
