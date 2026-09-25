/* Cockpit ↔ Xbox controller. Browser side: Gamepad API polling, visualisation, action dispatch, event history.
   Pipeline (all inspectable in the Controller view):
   physical input → raw gamepad (navigator.getGamepads) → normalize() → step() named controller event → resolve() mapping → Cockpit.actions[name]() → result. */
import * as core from './controller-core.js';

const C = { snap: null, lastRaw: null, lastRawNote: null, norm: null, machine: core.initialState(), others: [], history: [], trace: null, el: null, frames: 0, hz: 0, lastHzAt: 0, framesAtHz: 0, supported: typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function', lastPoll: 0, connectEvents: 0 };
try { C.history = JSON.parse(sessionStorage.getItem('cockpit.controller.history') || '[]').slice(0, 60); } catch { C.history = []; }
const HISTORY_MAX = 60;
const now = () => performance.now();
const clock = () => new Date().toLocaleTimeString([], { hour12: false }) + '.' + String(Date.now() % 1000).padStart(3, '0');

// ---------- dispatch: named event → mapping → action → result, recorded as one trace ----------
function dispatch(e) {
  const m = core.resolve(e.event); const focused = document.hasFocus();
  let result;
  if (!m) result = 'unmapped · nothing happens';
  else if (!focused) result = 'suspended · Cockpit window is not focused';
  else { try { result = window.Cockpit.actions[m.action]?.() ?? `no handler for ${m.action}`; } catch (err) { result = `error: ${err.message}`; } }
  const t = { at: clock(), physical: e.physical, raw: e.raw, event: e.event, action: m?.action || null, safety: m?.safety || null, result, kind: e.kind, repeat: !!e.repeat };
  C.trace = t;
  if (!e.repeat || C.history[0]?.event !== e.event) { C.history.unshift(t); C.history.length = Math.min(C.history.length, HISTORY_MAX); } else { C.history[0] = { ...t, repeats: (C.history[0].repeats || 1) + 1 }; }
  try { sessionStorage.setItem('cockpit.controller.history', JSON.stringify(C.history.slice(0, HISTORY_MAX))); } catch { }
  paintTrace();
}
function note(physical, result, kind = 'system') { const t = { at: clock(), physical, raw: '—', event: '—', action: null, result, kind }; C.trace = t; C.history.unshift(t); C.history.length = Math.min(C.history.length, HISTORY_MAX); paintTrace(); }

// ---------- polling ----------
function pickPrimary(list) { const live = list.filter((g) => g && g.connected); const xbox = live.find((g) => /xbox|045e/i.test(g.id) && g.mapping === 'standard'); return { primary: xbox || live.find((g) => g.mapping === 'standard') || live[0] || null, others: live.filter((g) => g !== (xbox || live.find((x) => x.mapping === 'standard') || live[0])) }; }
function poll() { requestAnimationFrame(poll); tick(); }
/** One frame: read gamepads → snapshot → normalize → step → dispatch → paint. Exposed for tests; the loop above is the only production caller. */
function tick() {
  if (!C.supported) return;
  const t = now(); C.frames++; if (t - C.lastHzAt >= 1000) { C.hz = C.frames - C.framesAtHz; C.framesAtHz = C.frames; C.lastHzAt = t; }
  const { primary, others } = pickPrimary(Array.from(navigator.getGamepads()));
  const prevSnap = C.snap, wasConnected = !!C.snap, prevKey = C.primaryKey; C.others = others.map((g) => ({ id: g.id, index: g.index, mapping: g.mapping }));
  C.snap = core.snapshot(primary); C.norm = core.normalize(C.snap); C.primaryKey = primary ? `${primary.index}:${primary.id}` : null;
  if (!!C.snap !== wasConnected) { note(C.snap ? `controller observed: ${C.snap.id}` : 'controller lost', C.snap ? `index ${C.snap.index} · mapping "${C.snap.mapping}" · ${C.snap.buttons.length} buttons · ${C.snap.axes.length} axes` : 'navigator.getGamepads() no longer lists it · held inputs released · focus kept', 'connect'); refreshNav(); }
  else if (C.snap && prevKey !== C.primaryKey) { C.machine = core.initialState(); note(`primary controller changed: ${C.snap.id}`, `index ${C.snap.index} · held inputs and repeats reset`, 'connect'); refreshNav(); }
  if (prevKey !== C.primaryKey) { C.lastRaw = null; C.lastRawNote = null; }
  const change = core.lastChanged(prevSnap, C.snap);
  if (change) {
    C.lastRaw = { ...change, at: clock() };
    const input = `${change.kind}[${change.index}]`;
    if (input !== C.lastRawNote) { C.lastRawNote = input; note(input, `${change.prev.toFixed(2)} → ${change.value.toFixed(2)}`, 'raw'); }
  }
  const { state, events } = core.step(C.machine, C.norm, t); C.machine = state;
  for (const e of events) dispatch(e);
  if (C.norm?.standard && document.hasFocus()) { const { lt, rt } = C.norm.triggers; if (lt.engaged || rt.engaged) { window.Cockpit.actions['cockpit.scrollDetail']((rt.value * rt.value - lt.value * lt.value) * 28); } }
  paint();
}
function refreshNav() { const it = [...document.querySelectorAll('#nav .item')].find((i) => i.textContent.startsWith('Controller')); const n = it?.querySelector('.n'); if (n) n.textContent = window.CockpitController.navCount(); }
window.addEventListener('gamepadconnected', (e) => { C.connectEvents++; note(`gamepadconnected event: ${e.gamepad.id}`, `index ${e.gamepad.index} · mapping "${e.gamepad.mapping}"`, 'connect'); });
window.addEventListener('gamepaddisconnected', (e) => { note(`gamepaddisconnected event: ${e.gamepad.id}`, `index ${e.gamepad.index}`, 'connect'); });
window.addEventListener('blur', () => { if (C.snap) paint(true); });
window.addEventListener('focus', () => { if (C.snap) paint(true); });
document.addEventListener('visibilitychange', () => { paint(true); });

// ---------- view ----------
const svgNS = 'http://www.w3.org/2000/svg';
function sv(tag, attrs = {}, ...kids) { const el = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); for (const k of kids) el.append(k); return el; }
function controllerSvg() {
  const R = {}; const btn = (name, x, y, w = 22, h = 22, text = core.label(name)) => { const g = sv('g', { class: 'gpb', 'data-btn': name }); g.append(sv('rect', { x, y, width: w, height: h }), sv('text', { x: x + w / 2, y: y + h / 2 + 3.5, 'text-anchor': 'middle' }, text)); R[name] = g; return g; };
  const stick = (name, cx, cy) => { const g = sv('g', { class: 'gps', 'data-stick': name }); const r = 30; g.append(sv('rect', { x: cx - r, y: cy - r, width: 2 * r, height: 2 * r, class: 'area' }), sv('rect', { x: cx - r * core.DEAD_ZONE, y: cy - r * core.DEAD_ZONE, width: 2 * r * core.DEAD_ZONE, height: 2 * r * core.DEAD_ZONE, class: 'dz' }), sv('line', { x1: cx - r, y1: cy, x2: cx + r, y2: cy, class: 'axis' }), sv('line', { x1: cx, y1: cy - r, x2: cx, y2: cy + r, class: 'axis' }), sv('text', { x: cx, y: cy + r + 12, 'text-anchor': 'middle' }, name === 'left' ? 'LEFT STICK' : 'RIGHT STICK')); const dot = sv('rect', { x: cx - 5, y: cy - 5, width: 10, height: 10, class: 'dot' }); g.append(dot); R[name + 'Dot'] = dot; R[name + 'C'] = [cx, cy, r]; return g; };
  const trig = (name, x, y) => { const g = sv('g', { class: 'gpt', 'data-trigger': name }); g.append(sv('rect', { x, y, width: 22, height: 44, class: 'well' })); const fill = sv('rect', { x, y: y + 44, width: 22, height: 0, class: 'fill' }); g.append(fill, sv('text', { x: x + 11, y: y + 56, 'text-anchor': 'middle' }, name.toUpperCase())); R[name] = g; R[name + 'Fill'] = fill; R[name + 'Y'] = y; const val = sv('text', { x: x + 11, y: y - 4, 'text-anchor': 'middle', class: 'val' }, '0.00'); g.append(val); R[name + 'Val'] = val; return g; };
  const svg = sv('svg', { viewBox: '0 -8 520 268', class: 'gamepad', 'aria-label': 'Xbox Wireless Controller schematic' });
  svg.append(sv('rect', { x: 20, y: 40, width: 480, height: 190, class: 'body' }));
  svg.append(trig('lt', 40, 6), trig('rt', 458, 6), btn('lb', 74, 14, 60, 22, 'LB'), btn('rb', 386, 14, 60, 22, 'RB'));
  svg.append(stick('left', 90, 105), btn('ls', 60, 150, 60, 14, 'L3 (press)'));
  svg.append(btn('up', 158, 150, 22, 22, '▲'), btn('down', 158, 198, 22, 22, '▼'), btn('left', 134, 174, 22, 22, '◀'), btn('right', 182, 174, 22, 22, '▶'));
  svg.append(btn('view', 218, 60, 34, 18, 'VIEW'), btn('xbox', 243, 88, 34, 24, 'XBOX'), btn('menu', 268, 60, 34, 18, 'MENU'));
  svg.append(btn('y', 400, 56), btn('x', 372, 84), btn('b', 428, 84), btn('a', 400, 112));
  svg.append(stick('right', 350, 190), btn('rs', 400, 176, 60, 14, 'R3 (press)'));
  svg.append(sv('text', { x: 170, y: 232, 'text-anchor': 'middle' }, 'D-PAD'));
  R.svg = svg; return R;
}
function traceSpine(t) {
  const n = (who, name, sm, st = 'complete') => h('div', { class: `node ${st}` }, h('div', { class: 'dot' }), h('div', {}, h('div', { class: 'nm' }, h('span', { class: `who ${who}` }, who + ' '), name), h('div', { class: 'sm' }, sm)), h('div', { class: 'line' }));
  if (!t) return h('div', { class: 'spine', style: 'padding:0' }, n('cockpit', 'PHYSICAL INPUT', 'waiting for the first meaningful input', 'queued'), n('cockpit', 'RAW GAMEPAD INPUT', '—', 'queued'), n('cockpit', 'NORMALIZED EVENT', '—', 'queued'), n('cockpit', 'MAPPING', '—', 'queued'), n('cockpit', 'COCKPIT ACTION', '—', 'queued'), n('cockpit', 'RESULT', '—', 'queued'));
  const mapped = !!t.action, sys = t.event === '—';
  return h('div', { class: 'spine', style: 'padding:0' },
    n('xbox', 'PHYSICAL INPUT', `${t.physical} · ${t.at}`),
    n('cockpit', 'RAW GAMEPAD INPUT', t.kind === 'raw' ? `${t.physical} ${t.result}` : sys ? 'gamepad connection state' : t.raw),
    n('cockpit', 'NORMALIZED EVENT', t.event + (t.repeat ? ' (repeat)' : ''), sys ? 'skipped' : 'complete'),
    n('cockpit', 'MAPPING', mapped ? `${t.event} → ${t.action} · ${t.safety}` : 'no mapping for this event (deliberately unmapped)', mapped ? 'complete' : 'skipped'),
    n('cockpit', 'COCKPIT ACTION', mapped ? t.action : '—', mapped ? (t.result.startsWith('suspended') ? 'cancelled' : 'complete') : 'skipped'),
    n('cockpit', 'RESULT', t.result, /^(error|suspended)/.test(t.result) ? 'failed' : mapped ? 'complete' : 'skipped'));
}
function historyTable() {
  const tbl = h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'time'), h('th', {}, 'input'), h('th', {}, 'normalized event'), h('th', {}, 'mapping'), h('th', {}, 'result'))),
    h('tbody', {}, C.history.length ? C.history.map((t) => h('tr', { class: t.kind === 'connect' ? 'connect' : '' }, h('td', { class: 'nano dim' }, t.at), h('td', {}, t.physical, t.repeats ? h('span', { class: 'nano dim' }, ` ×${t.repeats}`) : null), h('td', { class: t.event === '—' ? 'dim' : '' }, t.event), h('td', { class: t.action ? '' : 'dim' }, t.action || 'unmapped'), h('td', { class: 'muted' }, t.result))) : h('tr', {}, h('td', { colspan: 5, class: 'dim' }, 'No controller events yet.'))));
  return tbl;
}
function mappingTable() {
  return h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'physical'), h('th', {}, 'raw'), h('th', {}, 'normalized event'), h('th', {}, 'cockpit action'), h('th', {}, 'safety'), h('th', {}, 'effect'))),
    h('tbody', {}, core.MAPPINGS.map((m) => h('tr', { 'data-event': m.event, class: (C.trace?.event === m.event ? 'sel' : '') }, h('td', {}, m.physical), h('td', { class: 'dim' }, m.raw), h('td', {}, m.event), h('td', {}, m.action), h('td', { class: 'muted' }, m.safety), h('td', { class: 'muted' }, m.what)))));
}
function viewController() {
  const R = controllerSvg(); const el = { R };
  const live = (key, init = '—') => { const s = h('span', {}, init); el[key] = s; return s; };
  el.trace = h('div', { class: 'body', style: 'padding-top:8px' }, traceSpine(C.trace));
  el.hist = h('div', { class: 'list' }, historyTable());
  el.maps = h('div', { class: 'list' }, mappingTable());
  el.status = h('div', { class: 'gp-status' });
  const root = h('div', { style: 'display:flex;flex-direction:column;height:100%' },
    head('Controller', 'Xbox Wireless Controller → Gamepad API (Chrome) → normalized events → mapped Cockpit actions · nothing here is simulated', el.status),
    h('div', { class: 'split viewbody gp-split' },
      h('div', { class: 'list' },
        h('div', { class: 'panel' }, h('div', { class: 'eyebrow' }, 'physical controller ', h('span', { class: 'nano dim' }, 'live · reacts to every press')), h('div', { class: 'body' }, R.svg)),
        h('div', { class: 'panel' }, h('div', { class: 'eyebrow' }, 'raw + normalized input ', badge('observed', 'observed')), h('div', { class: 'body' }, kv([
          ['controller', live('id')], ['status', live('conn')], ['mapping mode', live('mapping')], ['gamepad index', live('index')], ['other gamepads', live('others', 'none')],
          ['buttons reported', live('buttonCount')], ['axes reported', live('axisCount')], ['last changed input', live('lastRaw')],
          ['raw buttons', live('rawb', 'none pressed')], ['raw axes', live('rawa')],
          ['left stick', live('ls')], ['right stick', live('rs')], ['triggers', live('trig')], ['dead zone', `${core.DEAD_ZONE} radial · nav engages at ${core.STICK_NAV_ON}, releases below ${core.STICK_NAV_OFF}`],
          ['repeat', `${core.REPEAT_DELAY}ms delay · ${core.REPEAT_INTERVAL}ms interval (D-pad, left stick)`],
          ['window focus', live('focus')], ['poll', live('poll')], ['browser', `${navigator.userAgent.match(/(Chrome|Safari|Firefox)\/[\d.]+/)?.[0] || 'unknown'} · Gamepad API ${C.supported ? 'available' : 'UNAVAILABLE'}`]]))),
        h('div', { class: 'panel' }, h('div', { class: 'eyebrow' }, 'mappings ', h('span', { class: 'nano dim' }, `${core.MAPPINGS.length} events mapped · everything else is unmapped on purpose`)), el.maps)),
      h('div', {},
        h('div', { class: 'panel' }, h('div', { class: 'eyebrow active' }, 'last trace ', h('span', { class: 'nano dim' }, 'physical → raw → normalized → mapping → action → result')), el.trace),
        h('div', { class: 'panel' }, h('div', { class: 'eyebrow' }, 'recent controller events ', h('span', { class: 'nano dim' }, `${C.history.length} · newest first · transitions and actions only, never per frame · kept for this browser tab`)), el.hist))));
  C.el = el; paint(true); return root;
}
function paintTrace() { if (!C.el || !C.el.trace.isConnected) return; C.el.trace.replaceChildren(traceSpine(C.trace)); C.el.hist.replaceChildren(historyTable()); C.el.maps.querySelectorAll('tr').forEach((tr) => tr.classList.toggle('sel', tr.dataset.event === C.trace?.event)); if (S.route.view === 'controller') { const n = C.el.hist.previousSibling?.querySelector?.('.nano'); if (n) n.textContent = `${C.history.length} · newest first · transitions and actions only, never per frame · kept for this browser tab`; } }
const fmt = (v) => (v >= 0 ? ' ' : '') + Number(v).toFixed(3);
function paint(force) {
  const el = C.el; if (!el || (!force && !el.R.svg.isConnected)) return;
  const s = C.snap, n = C.norm;
  const setText = (key, v) => { if (el[key].textContent !== v) el[key].textContent = v; };
  if (force || C.frames % 6 === 0) {
    const focused = document.hasFocus();
    el.status.replaceChildren(...(s ? [badge('connected', 'observed'), h('span', { class: 'nano dim' }, s.id.slice(0, 48))] : [badge(C.supported ? 'no controller' : 'unavailable', 'unavailable'), h('span', { class: 'nano dim' }, C.supported ? 'press any button on the controller' : 'Gamepad API missing')]));
    setText('id', s ? s.id : C.supported ? 'none reported by navigator.getGamepads() — Chrome lists a gamepad only after a button press on it (user gesture)' : 'UNAVAILABLE · navigator.getGamepads is not a function in this browser');
    setText('conn', s ? `CONNECTED · ${C.connectEvents} gamepadconnected event(s) this page` : 'DISCONNECTED');
    setText('mapping', s ? (n.standard ? `${s.mapping} · ${s.buttons.length} buttons · ${s.axes.length} axes` : `"${s.mapping || 'empty'}" · ${s.buttons.length} buttons · ${s.axes.length} axes · not the W3C standard layout: raw only, no named events, no actions`) : '—');
    setText('index', s ? String(s.index) : '—'); setText('others', C.others.length ? C.others.map((o) => `[${o.index}] ${o.id} (${o.mapping || 'no mapping'}) · ignored`).join(' · ') : 'none');
    setText('buttonCount', s ? String(s.buttons.length) : '—'); setText('axisCount', s ? String(s.axes.length) : '—');
    setText('focus', (focused ? 'focused · actions dispatch' : 'NOT FOCUSED · input still visualised, actions suspended') + ` · ${document.visibilityState}`); setText('poll', `requestAnimationFrame · ${C.hz} frames/s · frame ${C.frames}` + (document.visibilityState !== 'visible' ? ' · tab hidden, polling paused' : ''));
    el.R.svg.classList.toggle('off', !s); el.R.svg.classList.toggle('unfocused', !focused);
  }
  setText('lastRaw', C.lastRaw ? `${C.lastRaw.kind}[${C.lastRaw.index}] ${C.lastRaw.prev.toFixed(2)} → ${C.lastRaw.value.toFixed(2)} · ${C.lastRaw.at}` : '—');
  if (!s) { if (force) { for (const b of core.BUTTONS) el.R[b]?.classList.remove('on'); setText('rawb', '—'); setText('rawa', '—'); setText('ls', '—'); setText('rs', '—'); setText('trig', '—'); } return; }
  const pressed = s.buttons.map((b, i) => (b.pressed || b.value > 0 ? `button[${i}] = ${b.value.toFixed(2)}` : null)).filter(Boolean);
  setText('rawb', pressed.length ? pressed.join('   ') : 'none pressed');
  setText('rawa', s.axes.map((a, i) => `axes[${i}] = ${fmt(a)}`).join('   '));
  if (n.standard) {
    for (const b of core.BUTTONS) { const g = el.R[b]; if (g) g.classList.toggle('on', !!n.buttons[b]?.pressed); }
    for (const nm of ['left', 'right']) { const st = n.sticks[nm]; const [cx, cy, r] = el.R[nm + 'C']; const dot = el.R[nm + 'Dot']; dot.setAttribute('x', cx - 5 + st.raw.x * (r - 5)); dot.setAttribute('y', cy - 5 + st.raw.y * (r - 5)); dot.classList.toggle('active', st.active); }
    for (const t of ['lt', 'rt']) { const v = n.triggers[t].value; const f = el.R[t + 'Fill']; f.setAttribute('height', 44 * v); f.setAttribute('y', el.R[t + 'Y'] + 44 - 44 * v); el.R[t].classList.toggle('on', n.triggers[t].engaged); el.R[t + 'Val'].textContent = v.toFixed(2); }
    const L = n.sticks.left, Rr = n.sticks.right;
    setText('ls', `raw x ${fmt(L.raw.x)}  y ${fmt(L.raw.y)}   →   normalized x ${fmt(L.x)}  y ${fmt(L.y)}  magnitude ${L.magnitude.toFixed(3)}  ${L.active ? 'ACTIVE' : 'in dead zone'}${C.machine.stickDir ? '  nav ' + C.machine.stickDir : ''}`);
    setText('rs', `raw x ${fmt(Rr.raw.x)}  y ${fmt(Rr.raw.y)}   →   normalized x ${fmt(Rr.x)}  y ${fmt(Rr.y)}  magnitude ${Rr.magnitude.toFixed(3)}  ${Rr.active ? 'ACTIVE (unmapped)' : 'in dead zone'}`);
    setText('trig', `LT ${n.triggers.lt.value.toFixed(3)} ${n.triggers.lt.engaged ? 'ENGAGED' : 'idle'}   RT ${n.triggers.rt.value.toFixed(3)} ${n.triggers.rt.engaged ? 'ENGAGED' : 'idle'}   (engage above ${core.TRIGGER_ON})`);
  } else { setText('ls', 'UNAVAILABLE · non-standard mapping'); setText('rs', 'UNAVAILABLE · non-standard mapping'); setText('trig', 'UNAVAILABLE · non-standard mapping'); }
}

window.CockpitController = { view: viewController, navCount: () => (C.snap ? 'live' : ''), state: C, core, tick };
requestAnimationFrame(poll);
