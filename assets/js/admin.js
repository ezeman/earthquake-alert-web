// หน้าผู้ดูแล: ติดตามสถานการณ์ จัดการพื้นที่เฝ้าระวังและเกณฑ์ ออกประกาศ และส่งแจ้งเตือนทาง Telegram

import {
  HAZARDS, LEVELS, LEVEL_INFO, levelRank, escapeHtml, formatTime, store, newId,
  loadSiteConfig, loadAnnouncements, levelBadge, downloadFile
} from './core.js';
import { collectAlerts, matchZones } from './sources.js';
import { createMap, renderAlerts, renderZones } from './map.js';
import {
  $, $$, setupTabs, fillTypeSelect, fillLevelSelect, sortAlerts, renderSummary, renderAlertList,
  renderStatus, toast
} from './ui.js';
import {
  sendTelegram, formatAlertForTelegram, formatAnnouncementForTelegram, publishToGitHub,
  requestNotificationPermission, showBrowserNotification, playAlertSound
} from './notify.js';

const ALL_HAZARDS = Object.keys(HAZARDS).filter(k => k !== 'other');
const KEYS = {
  configDraft: 'admin.configDraft',
  annDraft: 'admin.announcementsDraft',
  settings: 'admin.settings',
  sent: 'admin.sentAlerts',
  handled: 'admin.handledAlerts',
  seen: 'admin.seenAlerts',
  log: 'admin.log'
};
const DEFAULT_SETTINGS = {
  telegramToken: '',
  telegramChatId: '',
  siteUrl: new URL('index.html', location.href).href,
  autoDispatch: false,
  dispatchMinLevel: 'warning',
  browserNotify: false,
  githubRepo: 'ezeman/earthquake-alert-web',
  githubBranch: 'main',
  githubToken: ''
};

let published = { config: null, announcements: [] };
let settings = { ...DEFAULT_SETTINGS, ...store.get(KEYS.settings, {}) };
let result = { alerts: [], status: [], updatedAt: Date.now() };
let alerts = [];
let markers = new Map();
let refreshTimer;
let refreshing = false;

const map = createMap('map');
const zoneLayer = L.layerGroup().addTo(map);
const alertLayer = L.layerGroup().addTo(map);

// ---------- ฉบับร่าง (แก้ไขในเครื่องก่อนเผยแพร่) ----------
const clone = obj => JSON.parse(JSON.stringify(obj));
const config = () => store.get(KEYS.configDraft, null) ?? published.config;
const announcements = () => store.get(KEYS.annDraft, null) ?? published.announcements;
const configDirty = () => JSON.stringify(config()) !== JSON.stringify(published.config);
const annDirty = () => JSON.stringify(announcements()) !== JSON.stringify(published.announcements);

function saveConfig(cfg) {
  store.set(KEYS.configDraft, cfg);
  updateDraftBar();
}

function saveAnnouncements(list) {
  store.set(KEYS.annDraft, list);
  updateDraftBar();
}

function dirtyFiles() {
  const files = [];
  if (configDirty()) files.push({ path: 'data/config.json', content: `${JSON.stringify(config(), null, 2)}\n` });
  if (annDirty()) files.push({ path: 'data/announcements.json', content: `${JSON.stringify(announcements(), null, 2)}\n` });
  return files;
}

function updateDraftBar() {
  const files = dirtyFiles();
  $('#draft-bar').hidden = !files.length;
  $('#draft-files').textContent = files.map(f => f.path).join(', ');
}

// ---------- ประวัติ ----------
function addLog(kind, title, ok, error) {
  const log = store.get(KEYS.log, []);
  log.unshift({ time: new Date().toISOString(), kind, title, ok, error: error ?? '' });
  store.set(KEYS.log, log.slice(0, 500));
  renderLog();
}

function renderLog() {
  const log = store.get(KEYS.log, []);
  $('#log-table').innerHTML = log.length
    ? `<tr><th>เวลา</th><th>ประเภท</th><th>รายการ</th><th>ผล</th></tr>` + log.map(l => `
        <tr><td>${escapeHtml(formatTime(l.time))}</td><td>${escapeHtml(l.kind)}</td><td>${escapeHtml(l.title)}</td>
        <td>${l.ok ? '✔' : `<span style="color:var(--danger)" title="${escapeHtml(l.error)}">✖ ${escapeHtml(l.error)}</span>`}</td></tr>`).join('')
    : '<tr><td class="empty">ยังไม่มีประวัติการส่ง</td></tr>';
}

// ---------- ภาพรวม ----------
function render() {
  const cfg = config();
  alerts = matchZones(result.alerts, cfg.zones);
  const inZones = alerts.filter(a => a.zones.length);
  const sent = new Set(store.get(KEYS.sent, []));

  renderZones(zoneLayer, cfg.zones, { onClick: z => focusZone(z.id) });
  markers = renderAlerts(alertLayer, alerts);
  renderSummary($('#summary'), inZones);

  $('#zone-table').innerHTML = `<tr><th>พื้นที่</th><th>ระดับสูงสุด</th><th>จำนวน</th><th>ประเภท</th></tr>` +
    cfg.zones.map(z => {
      const here = inZones.filter(a => a.zones.some(h => h.id === z.id));
      const top = here.reduce((m, a) => (levelRank(a.level) > levelRank(m) ? a.level : m), 'info');
      const types = [...new Set(here.map(a => a.type))].map(t => HAZARDS[t]?.icon).join(' ');
      return `<tr><td>${escapeHtml(z.name)}</td><td>${here.length ? levelBadge(top) : '-'}</td><td>${here.length}</td><td>${types}</td></tr>`;
    }).join('');

  const type = $('#filter-type').value;
  const level = $('#filter-level').value;
  const onlyZones = $('#only-zones').checked;
  renderAlertList($('#alert-list'), sortAlerts(alerts).filter(a =>
    (!onlyZones || a.zones.length) && (!type || a.type === type) &&
    (!level || levelRank(a.level) >= levelRank(level))
  ), {
    onSelect: focusAlert,
    emptyText: 'ไม่พบภัยตามเงื่อนไข',
    extra: a => sent.has(a.id)
      ? '<span class="meta">✔ ส่งแล้ว</span>'
      : `<button type="button" class="small" data-send="${escapeHtml(a.id)}">✈️ ส่ง Telegram</button>`
  });
  renderStatus($('#status'), result);
}

function focusAlert(id) {
  const m = markers.get(id);
  if (!m) return;
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 7));
  m.openPopup();
}

function focusZone(id) {
  const z = config().zones.find(x => x.id === id);
  if (z) map.setView([z.lat, z.lon], 7);
}

// ---------- ส่งแจ้งเตือน ----------
function telegramSettings() {
  return { token: settings.telegramToken, chatId: settings.telegramChatId };
}

async function sendAlert(alert) {
  try {
    await sendTelegram(telegramSettings(), formatAlertForTelegram(alert, settings.siteUrl));
    const sent = store.get(KEYS.sent, []);
    sent.push(alert.id);
    store.set(KEYS.sent, sent.slice(-2000));
    addLog('แจ้งเตือนภัย', alert.title, true);
    return true;
  } catch (err) {
    addLog('แจ้งเตือนภัย', alert.title, false, err.message);
    toast(`ส่งไม่สำเร็จ: ${err.message}`);
    return false;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function dispatchCandidates() {
  const handled = new Set(store.get(KEYS.handled, []));
  return alerts.filter(a => a.zones.length &&
    levelRank(a.level) >= levelRank(settings.dispatchMinLevel) && !handled.has(a.id));
}

function markHandled(ids) {
  const handled = store.get(KEYS.handled, []);
  store.set(KEYS.handled, [...handled, ...ids].slice(-3000));
}

async function autoDispatch() {
  if (!settings.autoDispatch) return;
  const queue = sortAlerts(dispatchCandidates()).slice(0, 10);
  for (const a of queue) {
    if (await sendAlert(a)) markHandled([a.id]);
    await sleep(1100);  // Telegram จำกัดประมาณ 1 ข้อความ/วินาที ต่อแชท
  }
  if (queue.length) render();
}

function notifyAdmin() {
  const relevant = alerts.filter(a => a.zones.length && levelRank(a.level) >= levelRank(settings.dispatchMinLevel));
  const seenList = store.get(KEYS.seen, null);
  const seen = new Set(seenList ?? []);
  const fresh = relevant.filter(a => !seen.has(a.id));
  relevant.forEach(a => seen.add(a.id));
  store.set(KEYS.seen, [...seen].slice(-2000));
  if (seenList === null || !fresh.length) return;
  if (settings.browserNotify) {
    fresh.slice(0, 5).forEach(showBrowserNotification);
    playAlertSound(fresh.some(a => a.level === 'severe') ? 'severe' : 'warning');
  }
  toast(`มีภัยใหม่ในพื้นที่เฝ้าระวัง ${fresh.length} รายการ`);
}

function updateAutoIndicator() {
  $('#auto-indicator').innerHTML = settings.autoDispatch
    ? '<span class="badge" style="background:var(--ok)">🤖 ส่งอัตโนมัติ: เปิด</span>'
    : '';
}

// ---------- โหลดข้อมูล ----------
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  $('#status').textContent = 'กำลังโหลดข้อมูล...';
  try {
    result = await collectAlerts(config(), config().zones);
    render();
    notifyAdmin();
    await autoDispatch();
  } finally {
    refreshing = false;
  }
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, Math.max(config().refreshMinutes, 1) * 60 * 1000);
}

let refreshDebounce;
function refreshSoon() {
  clearTimeout(refreshDebounce);
  refreshDebounce = setTimeout(refresh, 800);
}

// ---------- พื้นที่เฝ้าระวัง ----------
function renderZoneEditor() {
  const zones = config().zones;
  $('#zone-editor').innerHTML = zones.length ? zones.map(z => `
    <div class="card" data-zone="${escapeHtml(z.id)}">
      <div class="grid-2">
        <div><label>ชื่อพื้นที่</label><input data-field="name" value="${escapeHtml(z.name)}" /></div>
        <div><label>รัศมี (กม.)</label><input data-field="radiusKm" type="number" min="1" max="3000" value="${z.radiusKm}" /></div>
        <div><label>ละติจูด</label><input data-field="lat" type="number" step="0.0001" min="-90" max="90" value="${z.lat}" /></div>
        <div><label>ลองจิจูด</label><input data-field="lon" type="number" step="0.0001" min="-180" max="180" value="${z.lon}" /></div>
      </div>
      <label>ประเภทภัยที่เฝ้าระวัง</label>
      <div>${ALL_HAZARDS.map(h => `<label class="inline"><input type="checkbox" data-hazard="${h}" ${z.hazards.includes(h) ? 'checked' : ''} />${HAZARDS[h].icon} ${HAZARDS[h].label}</label>`).join('')}</div>
      <div class="toolbar" style="margin-top:8px">
        <button type="button" class="small" data-action="pick">🗺️ เลือกตำแหน่งจากแผนที่</button>
        <button type="button" class="small" data-action="focus">ดูบนแผนที่</button>
        <button type="button" class="small danger" data-action="delete">ลบพื้นที่</button>
      </div>
    </div>`).join('') : '<p class="empty">ยังไม่มีพื้นที่เฝ้าระวัง</p>';
}

function updateZone(id, fn) {
  const cfg = clone(config());
  const z = cfg.zones.find(x => x.id === id);
  if (!z) return;
  fn(z, cfg);
  saveConfig(cfg);
  renderZones(zoneLayer, cfg.zones, { onClick: zz => focusZone(zz.id) });
  refreshSoon();
}

function bindZoneEditor() {
  $('#zone-editor').addEventListener('change', e => {
    const card = e.target.closest('[data-zone]');
    if (!card) return;
    const id = card.dataset.zone;
    if (e.target.dataset.hazard) {
      updateZone(id, z => {
        const set = new Set(z.hazards);
        if (e.target.checked) set.add(e.target.dataset.hazard); else set.delete(e.target.dataset.hazard);
        z.hazards = ALL_HAZARDS.filter(h => set.has(h));
      });
      return;
    }
    const field = e.target.dataset.field;
    if (!field) return;
    const raw = e.target.value;
    if (field === 'name') {
      if (!raw.trim()) return toast('ชื่อพื้นที่ต้องไม่ว่าง');
      updateZone(id, z => { z.name = raw.trim(); });
    } else {
      const num = Number(raw);
      if (!Number.isFinite(num) || !e.target.checkValidity()) return toast('ค่าตัวเลขไม่ถูกต้อง');
      updateZone(id, z => { z[field] = num; });
    }
  });

  $('#zone-editor').addEventListener('click', e => {
    const action = e.target.dataset.action;
    const card = e.target.closest('[data-zone]');
    if (!action || !card) return;
    const id = card.dataset.zone;
    if (action === 'focus') focusZone(id);
    if (action === 'delete') {
      const z = config().zones.find(x => x.id === id);
      if (!confirm(`ลบพื้นที่ "${z?.name}" ?`)) return;
      const cfg = clone(config());
      cfg.zones = cfg.zones.filter(x => x.id !== id);
      saveConfig(cfg);
      renderZoneEditor();
      refreshSoon();
    }
    if (action === 'pick') {
      document.body.classList.add('map-picking');
      toast('คลิกบนแผนที่เพื่อกำหนดตำแหน่ง');
      map.once('click', ev => {
        document.body.classList.remove('map-picking');
        updateZone(id, z => {
          z.lat = Math.round(ev.latlng.lat * 10000) / 10000;
          z.lon = Math.round(ev.latlng.lng * 10000) / 10000;
        });
        renderZoneEditor();
      });
    }
  });

  $('#add-zone').addEventListener('click', () => {
    const c = map.getCenter();
    const cfg = clone(config());
    cfg.zones.push({
      id: newId('zone'), name: `พื้นที่ใหม่ ${cfg.zones.length + 1}`,
      lat: Math.round(c.lat * 10000) / 10000, lon: Math.round(c.lng * 10000) / 10000,
      radiusKm: 200, hazards: [...ALL_HAZARDS]
    });
    saveConfig(cfg);
    renderZoneEditor();
    refreshSoon();
    toast('เพิ่มพื้นที่ที่กึ่งกลางแผนที่แล้ว ใช้ปุ่ม "เลือกตำแหน่งจากแผนที่" เพื่อย้าย');
  });
}

// ---------- เกณฑ์และการตั้งค่าทั่วไป ----------
const THRESHOLD_ROWS = [
  { key: 'earthquake', label: '🌐 แผ่นดินไหว (ขนาด)' },
  { key: 'rainMmPerDay', label: '🌧️ ฝน (มม./วัน)' },
  { key: 'windGustKmh', label: '💨 ลมกระโชก (กม./ชม.)' },
  { key: 'pm25', label: '😷 PM2.5 เฉลี่ย 24 ชม. (µg/m³)' }
];

function renderSettingsForm() {
  const cfg = config();
  const t = cfg.thresholds;
  const r = cfg.region;
  $('#settings-form').innerHTML = `
    <div class="card">
      <h3>ทั่วไป</h3>
      <label for="s-name">ชื่อระบบ</label><input id="s-name" style="width:100%" value="${escapeHtml(cfg.siteName)}" required />
      <div class="grid-2">
        <div><label for="s-refresh">โหลดข้อมูลใหม่ทุก (นาที)</label><input id="s-refresh" type="number" min="1" max="120" value="${cfg.refreshMinutes}" required /></div>
      </div>
      <label for="s-tg-url">ลิงก์ช่อง Telegram สาธารณะ (แสดงบนหน้าเว็บ)</label>
      <input id="s-tg-url" type="url" style="width:100%" placeholder="https://t.me/your_channel" value="${escapeHtml(cfg.telegramChannelUrl ?? '')}" />
    </div>
    <div class="card">
      <h3>เกณฑ์ระดับการเตือน (ค่าตั้งแต่)</h3>
      <table class="data">
        <tr><th></th>${['watch', 'warning', 'severe'].map(l => `<th>${levelBadge(l)}</th>`).join('')}</tr>
        ${THRESHOLD_ROWS.map(row => `<tr><td>${row.label}</td>${['watch', 'warning', 'severe'].map(l =>
          `<td><input type="number" step="0.1" min="0" style="width:80px" data-th="${row.key}" data-level="${l}" value="${t[row.key][l]}" required /></td>`).join('')}</tr>`).join('')}
      </table>
      <label for="s-tsunami">สึนามิระดับ "อันตราย" เมื่อแผ่นดินไหวขนาดตั้งแต่</label>
      <input id="s-tsunami" type="number" step="0.1" min="0" value="${t.tsunamiSevereMagnitude}" required />
      <p style="font-size:0.82rem;color:var(--muted)">PM2.5 ค่าเริ่มต้นอิงเกณฑ์ของกรมควบคุมมลพิษ · ฝนอิงเกณฑ์กรมอุตุนิยมวิทยา (ฝนหนัก 35.1 มม., หนักมาก 90.1 มม.)</p>
    </div>
    <div class="card">
      <h3>ขอบเขตภูมิภาคที่ดึงข้อมูล</h3>
      <div class="grid-2">
        <div><label>ละติจูดต่ำสุด</label><input id="s-minLat" type="number" step="0.1" min="-90" max="90" value="${r.minLat}" required /></div>
        <div><label>ละติจูดสูงสุด</label><input id="s-maxLat" type="number" step="0.1" min="-90" max="90" value="${r.maxLat}" required /></div>
        <div><label>ลองจิจูดต่ำสุด</label><input id="s-minLon" type="number" step="0.1" min="-180" max="180" value="${r.minLon}" required /></div>
        <div><label>ลองจิจูดสูงสุด</label><input id="s-maxLon" type="number" step="0.1" min="-180" max="180" value="${r.maxLon}" required /></div>
      </div>
    </div>
    <div class="toolbar"><button type="submit" class="primary">บันทึกการตั้งค่า</button></div>`;
}

function bindSettingsForm() {
  $('#settings-form').addEventListener('submit', e => {
    e.preventDefault();
    const cfg = clone(config());
    cfg.siteName = $('#s-name').value.trim();
    cfg.refreshMinutes = Number($('#s-refresh').value);
    cfg.telegramChannelUrl = $('#s-tg-url').value.trim();
    $$('[data-th]').forEach(inp => { cfg.thresholds[inp.dataset.th][inp.dataset.level] = Number(inp.value); });
    cfg.thresholds.tsunamiSevereMagnitude = Number($('#s-tsunami').value);
    cfg.region = {
      minLat: Number($('#s-minLat').value), maxLat: Number($('#s-maxLat').value),
      minLon: Number($('#s-minLon').value), maxLon: Number($('#s-maxLon').value)
    };

    for (const row of THRESHOLD_ROWS) {
      const th = cfg.thresholds[row.key];
      if (!(th.watch <= th.warning && th.warning <= th.severe)) {
        return toast(`${row.label}: ค่าต้องเรียง เฝ้าระวัง ≤ เตือนภัย ≤ อันตราย`);
      }
    }
    if (cfg.region.minLat >= cfg.region.maxLat || cfg.region.minLon >= cfg.region.maxLon) {
      return toast('ขอบเขตภูมิภาคไม่ถูกต้อง (ค่าต่ำสุดต้องน้อยกว่าค่าสูงสุด)');
    }
    saveConfig(cfg);
    $('#site-name').textContent = cfg.siteName;
    scheduleRefresh();
    refresh();
    toast('บันทึกเป็นฉบับร่างแล้ว กด "เผยแพร่" เพื่อให้มีผลกับหน้าสาธารณะ');
  });
}

// ---------- ประกาศ ----------
function renderAnnouncementList() {
  const list = [...announcements()].sort((a, b) => new Date(b.time) - new Date(a.time));
  const now = Date.now();
  $('#announce-list').innerHTML = list.length ? list.map(a => {
    const active = !a.expires || new Date(a.expires).getTime() > now;
    return `<div class="card announcement" style="--level-color:${LEVEL_INFO[a.level]?.color}" data-ann="${escapeHtml(a.id)}">
      <h3>${levelBadge(a.level)} ${escapeHtml(a.title)} ${active ? '' : '<small>(สิ้นสุดแล้ว)</small>'}</h3>
      <p>${escapeHtml(a.body)}</p>
      <small>${a.area ? `พื้นที่: ${escapeHtml(a.area)} · ` : ''}${escapeHtml(formatTime(a.time))}${a.expires ? ` · ถึง ${escapeHtml(formatTime(a.expires))}` : ''}</small>
      <div class="toolbar" style="margin-top:6px">
        <button type="button" class="small" data-ann-action="send">✈️ ส่ง Telegram</button>
        ${active ? '<button type="button" class="small" data-ann-action="end">ยุติประกาศ</button>' : ''}
        <button type="button" class="small danger" data-ann-action="delete">ลบ</button>
      </div>
    </div>`;
  }).join('') : '<p class="empty">ยังไม่มีประกาศ</p>';
}

async function sendAnnouncement(a) {
  try {
    await sendTelegram(telegramSettings(), formatAnnouncementForTelegram(a));
    addLog('ประกาศ', a.title, true);
    toast('ส่งประกาศทาง Telegram แล้ว');
  } catch (err) {
    addLog('ประกาศ', a.title, false, err.message);
    toast(`ส่ง Telegram ไม่สำเร็จ: ${err.message}`);
  }
}

function bindAnnouncements() {
  $('#announce-form').addEventListener('submit', async e => {
    e.preventDefault();
    const expires = $('#an-expires').value;
    const a = {
      id: newId('ann'),
      title: $('#an-title').value.trim(),
      body: $('#an-body').value.trim(),
      level: $('#an-level').value,
      area: $('#an-area').value.trim(),
      time: new Date().toISOString(),
      expires: expires ? new Date(expires).toISOString() : null
    };
    if (a.expires && new Date(a.expires) <= new Date()) return toast('เวลาสิ้นสุดต้องเป็นเวลาในอนาคต');
    const sendNow = $('#an-telegram').checked;
    saveAnnouncements([...announcements(), a]);
    renderAnnouncementList();
    e.target.reset();
    $('#an-level').value = 'warning';
    $('#an-telegram').checked = true;
    toast('บันทึกประกาศแล้ว กด "เผยแพร่" เพื่อแสดงบนหน้าสาธารณะ');
    if (sendNow) await sendAnnouncement(a);
  });

  $('#announce-list').addEventListener('click', async e => {
    const action = e.target.dataset.annAction;
    const card = e.target.closest('[data-ann]');
    if (!action || !card) return;
    const list = clone(announcements());
    const a = list.find(x => x.id === card.dataset.ann);
    if (!a) return;
    if (action === 'send') {
      e.target.disabled = true;
      await sendAnnouncement(a);
      e.target.disabled = false;
      return;
    }
    if (action === 'end') a.expires = new Date().toISOString();
    if (action === 'delete' && !confirm(`ลบประกาศ "${a.title}" ?`)) return;
    saveAnnouncements(action === 'delete' ? list.filter(x => x !== a) : list);
    renderAnnouncementList();
  });
}

// ---------- ช่องทางแจ้งเตือน ----------
function fillChannelForm() {
  $('#tg-token').value = settings.telegramToken;
  $('#tg-chat').value = settings.telegramChatId;
  $('#site-url').value = settings.siteUrl;
  $('#auto-dispatch').checked = settings.autoDispatch;
  $('#dispatch-level').value = settings.dispatchMinLevel;
  $('#admin-browser-notify').checked = settings.browserNotify;
  $('#gh-repo').value = settings.githubRepo;
  $('#gh-branch').value = settings.githubBranch;
  $('#gh-token').value = settings.githubToken;
}

function readChannelForm() {
  return {
    ...settings,
    telegramToken: $('#tg-token').value.trim(),
    telegramChatId: $('#tg-chat').value.trim(),
    siteUrl: $('#site-url').value.trim(),
    autoDispatch: $('#auto-dispatch').checked,
    dispatchMinLevel: $('#dispatch-level').value,
    browserNotify: $('#admin-browser-notify').checked,
    githubRepo: $('#gh-repo').value.trim(),
    githubBranch: $('#gh-branch').value.trim() || 'main',
    githubToken: $('#gh-token').value.trim()
  };
}

function bindChannels() {
  $('#channel-form').addEventListener('submit', async e => {
    e.preventDefault();
    const next = readChannelForm();
    if (next.autoDispatch && (!next.telegramToken || !next.telegramChatId)) {
      return toast('ต้องตั้งค่า Bot Token และ Chat ID ก่อนเปิดการส่งอัตโนมัติ');
    }
    if (next.browserNotify && (await requestNotificationPermission()) !== 'granted') {
      next.browserNotify = false;
      $('#admin-browser-notify').checked = false;
      toast('เบราว์เซอร์ไม่อนุญาตการแจ้งเตือน');
    }
    const turningOn = next.autoDispatch && !settings.autoDispatch;
    settings = next;
    store.set(KEYS.settings, settings);
    if (turningOn) {
      // ภัยที่มีอยู่แล้วไม่ส่งย้อนหลัง ส่งเฉพาะที่เกิดใหม่หลังจากนี้
      markHandled(dispatchCandidates().map(a => a.id));
    }
    updateAutoIndicator();
    toast('บันทึกการตั้งค่าช่องทางแล้ว (เก็บในเบราว์เซอร์นี้เท่านั้น)');
  });

  $('#tg-test').addEventListener('click', async () => {
    const s = readChannelForm();
    try {
      await sendTelegram({ token: s.telegramToken, chatId: s.telegramChatId },
        `✅ ทดสอบการเชื่อมต่อจาก <b>${escapeHtml(config().siteName)}</b>`);
      addLog('ทดสอบ', 'ข้อความทดสอบ', true);
      toast('ส่งข้อความทดสอบสำเร็จ');
    } catch (err) {
      addLog('ทดสอบ', 'ข้อความทดสอบ', false, err.message);
      toast(`ส่งไม่สำเร็จ: ${err.message}`);
    }
  });
}

// ---------- เผยแพร่ ----------
function bindDraftBar() {
  $('#publish-btn').addEventListener('click', async () => {
    const files = dirtyFiles();
    if (!files.length) return;
    if (!settings.githubToken) {
      toast('ยังไม่ได้ตั้งค่า GitHub token (แท็บ "ช่องทางแจ้งเตือน") หรือใช้ปุ่มดาวน์โหลดไฟล์แทน');
      return;
    }
    const btn = $('#publish-btn');
    btn.disabled = true;
    try {
      const gh = { repo: settings.githubRepo, branch: settings.githubBranch, token: settings.githubToken };
      for (const f of files) {
        await publishToGitHub(gh, f.path, f.content, `อัปเดต ${f.path} จากหน้าผู้ดูแล`);
        addLog('เผยแพร่', f.path, true);
      }
      published = { config: config(), announcements: announcements() };
      store.remove(KEYS.configDraft);
      store.remove(KEYS.annDraft);
      updateDraftBar();
      toast('เผยแพร่แล้ว หน้าสาธารณะจะอัปเดตภายในประมาณ 1-2 นาที');
    } catch (err) {
      addLog('เผยแพร่', files.map(f => f.path).join(', '), false, err.message);
      toast(`เผยแพร่ไม่สำเร็จ: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  });

  $('#download-btn').addEventListener('click', () => {
    dirtyFiles().forEach(f => downloadFile(f.path.split('/').pop(), f.content));
    toast('นำไฟล์ที่ดาวน์โหลดไปแทนที่ในโฟลเดอร์ data/ ของ repository');
  });

  $('#discard-btn').addEventListener('click', () => {
    if (!confirm('ยกเลิกการแก้ไขทั้งหมดที่ยังไม่เผยแพร่?')) return;
    store.remove(KEYS.configDraft);
    store.remove(KEYS.annDraft);
    updateDraftBar();
    renderZoneEditor();
    renderSettingsForm();
    renderAnnouncementList();
    refresh();
  });
}

// ---------- เริ่มต้น ----------
async function init() {
  fillTypeSelect($('#filter-type'));
  fillLevelSelect($('#filter-level'), { allLabel: 'ทุกระดับ', suffix: ' ขึ้นไป' });
  fillLevelSelect($('#an-level'));
  fillLevelSelect($('#dispatch-level'), { suffix: ' ขึ้นไป' });
  $('#an-level').value = 'warning';
  setupTabs();

  try {
    const [cfg, anns] = await Promise.all([loadSiteConfig(), loadAnnouncements()]);
    published = { config: cfg, announcements: anns };
  } catch (err) {
    console.error(err);
    $('#status').innerHTML = '<span class="err">โหลดไฟล์ตั้งค่า (data/config.json) ไม่ได้</span>';
    return;
  }

  $('#site-name').textContent = config().siteName;
  const r = config().region;
  map.fitBounds([[r.minLat, r.minLon], [r.maxLat, r.maxLon]]);

  ['#filter-type', '#filter-level', '#only-zones'].forEach(s => $(s).addEventListener('change', render));
  $('#refresh-btn').addEventListener('click', refresh);
  $('#alert-list').addEventListener('click', async e => {
    const id = e.target.dataset.send;
    const a = id && alerts.find(x => x.id === id);
    if (!a) return;
    e.target.disabled = true;
    if (await sendAlert(a)) {
      markHandled([a.id]);
      toast('ส่งทาง Telegram แล้ว');
      render();
    } else {
      e.target.disabled = false;
    }
  });
  $('#log-export').addEventListener('click', () => {
    const rows = [['เวลา', 'ประเภท', 'รายการ', 'สำเร็จ', 'ข้อผิดพลาด'],
      ...store.get(KEYS.log, []).map(l => [l.time, l.kind, l.title, l.ok ? 'ใช่' : 'ไม่', l.error])];
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');
    downloadFile('alert-log.csv', `﻿${csv}`, 'text/csv');
  });
  $('#log-clear').addEventListener('click', () => {
    if (confirm('ล้างประวัติทั้งหมด?')) { store.remove(KEYS.log); renderLog(); }
  });

  bindZoneEditor();
  bindSettingsForm();
  bindAnnouncements();
  bindChannels();
  bindDraftBar();

  renderZoneEditor();
  renderSettingsForm();
  renderAnnouncementList();
  fillChannelForm();
  renderLog();
  updateDraftBar();
  updateAutoIndicator();

  await refresh();
  scheduleRefresh();
}

init();
