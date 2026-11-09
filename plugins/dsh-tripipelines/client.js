// dsh-tripipelines — Web UI half of the GUI board. ONE widget, ONE place: a small card in the
// sidebar foot dock (next to the cost/token entries) with a status pill, budget progress
// bar and milestone count, polled from GET /pipeline/board (host half: lib/board-route.js).
// There is deliberately no second seat: no composer strip and no floating card, so the
// plugin never duplicates itself.
//
// Loader contract (see the decoration template): the factory must be
// side-effect-free apart from returning the slot plugin; all resources are owned
// by the slot registration and released on unload.
window.__ModuleLoader__.load({
  id: 'dsh-tripipelines',
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
    // v132 (B5) — i18n dictionaries. Chinese is the canonical language; every UI string
    // lives here so the slot framework can inject a localized `t` (registered below via
    // ctx.locale.register + entry option `locale`). When no locale face is installed the
    // component falls back to zh, so the card never blanks out. Dynamic strings are
    // functions taking their arguments.
    const I18N_NS = 'pipeline-board'
    const L_ZH = {
      title: '流水线',
      status_active: '运行中', status_paused: '已暂停', status_done: '已完成', status_idle: '待命',
      switch_ws_aria: '切换工作区', switch_ws_title: '切换看板显示的工作区',
      follow_ws: '跟随当前工作区', auto_ws_hint: '自动（最近工作区）', current_suffix: ' · 当前',
      rail_idle: '流水线待命',
      idle_row: '◫ 流水线待命',
      idle_tip: '流水线待命：用 pipeline_lock_requirements 开始一个开发任务后，这里会显示状态、里程碑与预算',
      run_line: (id, statusLabel, pause) => `run: ${id} · ${statusLabel}${pause}`,
      paused_suffix: (why) => `（${why}）`,
      ws_line: (ws) => `工作区: ${ws}`,
      spot_line: (l1u, l1b, m1, l2u, l2b, m2) => `甜点区: L1 ${l1u}/${l1b}（${m1}） · L2 ${l2u}/${l2b}（${m2}）`,
      measured_word: '实测', estimated_word: '估算',
      badge_measured: '测', badge_estimated: '估',
      badge_measured_title: '宿主 tokenMeter 实测（请求压力口径）',
      badge_estimated_title: '估算读数（尾部窗口或缓存），不是精确占用',
      meter_tip: (label, used, cap, lim, win) => `${label}｜当前 ${used}／甜点 ${cap}／危险线 ${lim}／窗口 ${win}。装了压缩代理时这是原始请求压力，实际上下文可能小得多、表现照常——灰色=过甜点仅提示，琥珀=逼近危险线，红色=过线才建议 checkpoint（数值见各条）`,
      meter_tip_unknown: (label, used) => `${label}｜当前 ${used}：该模型没有内置档案、宿主也未上报窗口，不画假刻度。换模型时命令会自动对齐；也可手动 /pipe-config level1ContextWindow <值>`,
      finish_done: '已完成', finish_end: '已结束',
      unknown_window: '未知', no_data: '—',
      seg_done: '已完成', seg_failed: '失败', seg_pending: '待做',
      subtasks_caption: '子任务', more_n: (n) => `另有 ${n} 个`,
      l2_overflow: (n) => `L2 另有 ${n} 个（悬浮查看全部）`,
      pending_accept: '⚠️ 待验收',
      milestone_count: (accepted, total) => `里程碑 ${accepted}/${total}`,
      no_milestones: '无里程碑',
      l1_row: (model) => `L1 ${model}`,
      l2_row: (label, model) => `L2 ${label} · ${model}`,
    }
    const L_EN = {
      title: 'Pipeline',
      status_active: 'Running', status_paused: 'Paused', status_done: 'Done', status_idle: 'Idle',
      switch_ws_aria: 'Switch workspace', switch_ws_title: 'Choose which workspace the board shows',
      follow_ws: 'Follow current workspace', auto_ws_hint: 'Auto (recent workspace)', current_suffix: ' · current',
      rail_idle: 'Pipeline standby',
      idle_row: '◫ Pipeline standby',
      idle_tip: 'Standby: start a development task with pipeline_lock_requirements and this card shows status, milestones and budget.',
      run_line: (id, statusLabel, pause) => `run: ${id} · ${statusLabel}${pause}`,
      paused_suffix: (why) => ` (${why})`,
      ws_line: (ws) => `Workspace: ${ws}`,
      spot_line: (l1u, l1b, m1, l2u, l2b, m2) => `Sweet spot: L1 ${l1u}/${l1b} (${m1}) · L2 ${l2u}/${l2b} (${m2})`,
      measured_word: 'measured', estimated_word: 'est.',
      badge_measured: 'M', badge_estimated: 'E',
      badge_measured_title: 'Measured by host tokenMeter (request-pressure basis)',
      badge_estimated_title: 'Estimated reading (tail window or cache), not exact usage',
      meter_tip: (label, used, cap, lim, win) => `${label} | current ${used} / sweet ${cap} / danger ${lim} / window ${win}. With a compression proxy this is raw request pressure — real context may be far smaller and behavior normal. Grey = past the sweet spot (hint only), amber = approaching the danger line, red = past it: consider a checkpoint.`,
      meter_tip_unknown: (label, used) => `${label} | current ${used}: no built-in profile for this model and the host reports no window, so no fake scale. Switching models re-aligns automatically; you can also set /pipe-config level1ContextWindow <value>.`,
      finish_done: 'Done', finish_end: 'Ended',
      unknown_window: 'unknown', no_data: '—',
      seg_done: 'done', seg_failed: 'failed', seg_pending: 'pending',
      subtasks_caption: 'subtasks', more_n: (n) => `+${n} more`,
      l2_overflow: (n) => `L2 +${n} more (hover for all)`,
      pending_accept: '⚠️ Awaiting acceptance',
      milestone_count: (accepted, total) => `Milestones ${accepted}/${total}`,
      no_milestones: 'No milestones',
      l1_row: (model) => `L1 ${model}`,
      l2_row: (label, model) => `L2 ${label} · ${model}`,
    }
    // Translate helper: props.t from the slot framework when present, zh dictionary
    // otherwise. Function values are called with their args; missing keys echo the key.
    const mkT = (t) => (key, ...args) => {
      let v
      if (typeof t === 'function') {
        try { v = t(key) } catch { v = undefined }
      }
      if (v == null || v === key) v = L_ZH[key]
      return typeof v === 'function' ? v(...args) : (v == null ? key : String(v))
    }
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
    const PICK_KEY = 'dsh-tripipelines.workspace'
    const LEGACY_PICK_KEYS = ['dsh-pipeline.workspace']
    let pickedKey = null
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        for (const k of [PICK_KEY, ...LEGACY_PICK_KEYS]) window.localStorage.removeItem(k)
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
    function workspacePicker(t, snap, picked, cwd, onPick) {
      const list = Array.isArray(snap && snap.workspaces) ? snap.workspaces : []
      if (list.length < 2) return null
      return h(
        'select',
        {
          'aria-label': t('switch_ws_aria'),
          title: t('switch_ws_title'),
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
        h('option', { key: '__follow__', value: '' }, cwd ? t('follow_ws') : t('auto_ws_hint')),
        list.map((w) => h('option', { key: w.key, value: w.key }, `${w.name}${w.active ? t('current_suffix') : ''}`)),
      )
    }

    // The sidebar card: muted "待命" block before any run (still proves the plugin is
    // mounted), then a two-line card — state + milestone progress on top, budget and live
    // L2s below. Hovering shows the full detail (run id, milestones, L2s, recent events).
    function PipelineBoard(props) {
      const t = mkT(props && typeof props.t === 'function' ? props.t : null)
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
        const statusLabel = t(`status_${run.status}`) !== `status_${run.status}` ? t(`status_${run.status}`) : run.status
        return h(
          'div',
          {
            'data-pipeline-board': '1',
            title: idle
              ? `${t('rail_idle')}${wsName ? ` · ${wsName}` : ''}`
              : `${t('title')} ${statusLabel}${wsName ? ` · ${wsName}` : ''}`,
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
            title: t('idle_tip'),
            style: { ...CARD, opacity: 0.6 },
          },
          h('div', { style: { ...ROW, color: C.sub } }, t('idle_row')),
          workspacePicker(t, snap, picked, cwd, pickWorkspace),
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
        t('run_line', run.id || '(none)', `status_${run.status}` in L_ZH ? t(`status_${run.status}`) : run.status, paused ? t('paused_suffix', run.pauseReason || t('status_paused')) : ''),
        t('ws_line', wsName || picked || cwd || '(host default)'),
        t(
          'spot_line',
          fmtCount(snap.context?.level1?.tokens),
          fmtCount(snap.context?.level1?.budget),
          snap.context?.level1?.source === 'tokenMeter.measure' ? t('measured_word') : t('estimated_word'),
          fmtCount(snap.context?.level2?.tokens),
          fmtCount(snap.context?.level2?.budget),
          snap.context?.level2?.measured ? t('measured_word') : t('estimated_word'),
        ),
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
      // v94 — per-level meters, one row each: label / value / mini bar.
      // v127 — green = inside the sweet spot, grey = past it (advisory only),
      // red = past the danger line (near real collapse). See meter() for why.
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
      // v126 — honest meter. The old three-zone gradient implied the white tick was
      // an exact position inside a known window; with compression proxies (ACP) in
      // play the host reading is request pressure, not post-fold billed context, so
      // that precision was theatre. New shape: one fill coloured by where it sits
      // relative to sweet/danger (colours unchanged), no tick pretending to be exact,
      // and a provenance badge — 测 = host measurement, 估 = estimate or stale cache.
      // Thresholds stay in the tooltip instead of eating card width.
      // v127 — colour semantics follow the ADVISORY truth: sweet-spot/danger lines
      // describe plain long-context degradation. Under a compression proxy the raw
      // pressure can sit far past them while the model still works well, so painting
      // amber at "past sweet spot" made healthy sessions look sick and confused
      // users. Past-sweet is now NEUTRAL steel (a hint, not an alarm); red is
      // reserved for past-danger = near real collapse; amber only shades the last
      // stretch before the danger line when there is room to show it.
      const meter = (label, tokens, budget, color, key, finished, finishLabel, top, barH, caption, danger, contextWindow, badge) => {
        const cap = Number(budget) || 0
        const used = Number(tokens) || 0
        const lim = Number(danger) > 0 ? Number(danger) : 0
        const win = Number(contextWindow) > 0 ? Number(contextWindow) : Math.max(lim, cap) || 0
        // v128 — when neither a built-in profile nor the host knows this model's
        // window (e.g. an L1 chat model with no /pipe-config level1Model profile),
        // there is no honest scale to paint: show "窗口未知" and neutral steel fill
        // instead of inventing percentages against a guessed base.
        const winUnknown = !(Number(contextWindow) > 0) && used > 0
        const bas = win > 0 ? win : Math.max(lim, cap)
        const pct = finished ? 100 : Math.max(0, Math.min(100, Math.round((bas > 0 ? used / bas : 0) * 100)))
        const inDanger = lim > 0 && used >= lim
        const inWarn = cap > 0 && used >= cap && !inDanger
        // v127 — near-collapse heads-up band: amber only inside the last 5% of the
        // window before the danger line. A plain session at 96K/128K (danger=96K)
        // still shades amber approaching it; a compressed session at 100K pressure
        // on a 1M-window model stays neutral steel, not alarmist.
        const nearDanger = !winUnknown && inWarn && lim > 0 && win > 0 && used / win >= Math.max(0, lim / win - 0.05)
        const fillColor = finished
          ? C.done
          : winUnknown
            ? 'rgba(148,163,184,.55)'
            : inDanger
            ? 'rgba(248,81,73,.92)'
            : nearDanger
              ? 'rgba(251,191,36,.90)'
              : inWarn
                ? 'rgba(148,163,184,.85)'
                : 'rgba(52,211,153,.88)'
        const valueColor = finished ? C.done : inDanger ? C.error : nearDanger ? C.warn : inWarn ? C.sub : C.text
        const titleText = lim > 0
          ? t('meter_tip', label, fmtCount(used), fmtCount(cap), fmtCount(lim), win > 0 ? fmtCount(win) : t('unknown_window'))
          : winUnknown
            ? t('meter_tip_unknown', label, fmtCount(used))
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
              ? h('span', { style: { color: C.done, fontWeight: 600, flex: 'none' } }, finishLabel || t('finish_done'))
              : h(
                  'span',
                  { style: { color: cap > 0 ? valueColor : C.sub, fontWeight: 600, flex: 'none', fontVariantNumeric: 'tabular-nums' } },
                  cap > 0 && !winUnknown ? `${fmtCount(used)}/${fmtCount(cap)}` : winUnknown ? fmtCount(used) : '—',
                ),
            finished
              ? null
              : h(
                  'span',
                  {
                    style: { color: inDanger ? C.error : C.sub, flex: 'none', width: 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
                  },
                  cap > 0 && !winUnknown ? `${pct}%` : winUnknown ? t('unknown_window') : t('no_data'),
                ),
            // Provenance badge sits right of the percent so M/E never wrap.
            !finished && badge
              ? h(
                  'span',
                  {
                    style: {
                      color: badge === t('badge_measured') ? C.ok : C.warn,
                      flex: 'none',
                      fontSize: 9.5,
                      lineHeight: '14px',
                      padding: '0 3px',
                      borderRadius: 3,
                      background: badge === t('badge_measured') ? 'rgba(52,211,153,.12)' : 'rgba(251,191,36,.14)',
                    },
                    title: badge === t('badge_measured') ? t('badge_measured_title') : t('badge_estimated_title'),
                  },
                  badge,
                )
              : null,
          ),
          h(
            'div',
            {
              style: {
                position: 'relative',
                height: barH ?? 4,
                borderRadius: 99,
                background: 'rgba(255,255,255,.08)',
                overflow: 'hidden',
              },
            },
            // Single fill: green until the sweet spot, neutral steel through the
            // advisory headroom (past-sweet is a hint, not an alarm — v127), red
            // only past the danger line. No zone boundaries painted — they were the
            // part that implied false precision.
            h('div', {
              style: {
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${pct}%`,
                borderRadius: 99,
                background: fillColor,
              },
            }),
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
              title: i < doneN ? t('seg_done') : i < doneN + failedN ? t('seg_failed') : t('seg_pending'),
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
              t('subtasks_caption'),
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
            ? h('div', { style: { color: C.sub, fontSize: 9.5, lineHeight: '12px' } }, t('more_n', totalN - shown))
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
            h('span', { style: { color: C.text, fontWeight: 700, fontSize: 13 } }, t('title')),
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
              paused ? t('status_paused') : `status_${run.status}` in L_ZH ? t(`status_${run.status}`) : run.status,
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
                  t('milestone_count', accepted, milestones.length),
                )
              : h('span', { style: { color: C.sub, whiteSpace: 'nowrap' } }, t('no_milestones')),
            h(
              'span',
              { style: { marginLeft: 'auto', color: C.sub, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', flex: 'none' } },
              `${fmtCount(budget.tokensUsed || 0)}/${fmtCount(budget.maxTokens || 0)}`,
            ),
          ),
          workspacePicker(t, snap, picked, cwd, pickWorkspace),
        ),
        // Divider: the title block ends here; everything below is the level board.
        h('div', { style: { height: 1, background: 'rgba(255,255,255,.08)', margin: '7px 0 1px' } }),
        // L1 header carries its model on the same line; L2 rows carry the lead name
        // and its model. Bar thickness encodes the layer (L1 thickest, L3 thinnest);
        // levels are separated by a modest gap so the card stays dense but grouped.
        meter(
          t('l1_row', shortModel(models.level1)),
          l1spot.tokens,
          l1spot.budget,
          spotColor(l1spot.tokens, l1spot.budget, l1spot.danger),
          'l1',
          run.status === 'done',
          t('finish_done'),
          0,
          5,
          null,
          l1spot.danger,
          l1spot.window,
          // v126 — badge from the provenance the server now ships. No reading yet
          // (source=null && tokens=0) shows nothing rather than a fake estimate.
          l1spot.source === 'tokenMeter.measure'
            ? t('badge_measured')
            : l1spot.approximate || l1spot.tokens > 0
              ? t('badge_estimated')
              : null,
        ),
        // Every lead gets a row — a finished one keeps its (blue, full) bar and says
        // 已完成/已结束 on the right, so the card still shows who worked when a run ends.
        ...(agents.length
          ? agents
              .slice()
              .sort((a, b) => {
                // v132 (audit D1) — archived leads are retired like replaced ones.
                const rank = (x) => (x.state === 'done' || x.state === 'replaced' || x.state === 'archived' ? 2 : x.state === 'failed' ? 1 : 0)
                return rank(a) - rank(b)
              })
              .slice(0, 4)
              .map((a, i) => {
                const finished = a.state === 'done' || a.state === 'replaced' || a.state === 'archived'
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
                return meter(
                  t('l2_row', a.label, shortModel(a.model || models.level2)),
                  usedTokens,
                  l2spot.budget,
                  failed ? C.error : live ? spotColor(usedTokens, l2spot.budget, l2spot.danger) : C.sub,
                  a.id,
                  finished,
                  a.state === 'replaced' || a.state === 'archived' ? t('finish_end') : t('finish_done'),
                  i === 0 ? 9 : 4,
                  3,
                  null,
                  l2spot.danger,
                  l2spot.window,
                  // v126 — the old estimate suffix becomes the same badge as L1's.
                  live ? t('badge_measured') : t('badge_estimated'),
                )
              })
          : [meter('L2', 0, l2spot.budget, C.idle, 'l2-none', false, null, 9, 3, null, l2spot.danger, l2spot.window, null)]),
        agents.length > 4
          ? h(
              'div',
              { style: { ...ROW, color: C.sub, fontSize: 11, lineHeight: '16px', marginTop: 4 } },
              t('l2_overflow', agents.length - 4),
            )
          : null,
        segments('L3', subs.done, subs.total, subs.failed, 'l3'),
        doneUnaccepted.length
          ? h(
              'div',
              { style: { ...ROW, gap: 4, color: C.warn, fontSize: 11, lineHeight: '15px', marginTop: 10 } },
              t('pending_accept'),
            )
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // v132 (B5): register the UI dictionary with the Client locale service when it is
        // installed (late registration is picked up without remount; zh+en are the baseline
        // languages). The slot entry then receives an injected props.t that re-renders on
        // locale switches. Without the face, mkT falls back to the zh dictionary.
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          try {
            ctx.effect(() => ctx.locale.register(I18N_NS, { zh: L_ZH, en: L_EN }))
          } catch {
            /* locale face unavailable — zh fallback keeps the card fully functional */
          }
        }
        // Single seat (v94): the sidebar foot dock — same zone as the token/cost entries.
        // One widget, one place; nothing is drawn in the composer area or as a card.
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'pipeline-board',
              order: 1,
              label: () => mkT(ctx.locale?.bind?.(I18N_NS))(L_ZH.title),
              locale: I18N_NS,
            },
            PipelineBoard,
          ),
        )
      },
    }
  },
})
