// หน้าสาธารณะ: แผนที่ภัย รายการภัยในพื้นที่ของผู้ใช้ และการแจ้งเตือนบนเบราว์เซอร์

import {
  HAZARDS, levelRank, escapeHtml, store, newId, loadSiteConfig, loadAnnouncements, activeAnnouncements
} from './core.js';
import { collectAlerts, matchZones } from './sources.js';
import { createMap, renderAlerts, renderZones } from './map.js';
import {
  $, setupTabs, fillTypeSelect, fillLevelSelect, sortAlerts, renderSummary, renderAlertList,
  renderAnnouncements, renderStatus, toast
} from './ui.js';
import {
  notificationSupported, requestNotificationPermission, showBrowserNotification, playAlertSound
} from './notify.js';

const ALL_HAZARDS = Object.keys(HAZARDS).filter(k => k !== 'other');
const KEYS = {
  personalZones: 'public.personalZones',
  hiddenOfficial: 'public.hiddenOfficialZones',
  seen: 'public.seenAlerts',
  prefs: 'public.prefs'
};

let config;
let result = { alerts: [], status: [], updatedAt: Date.now() };
let markers = new Map();
let refreshTimer;
const prefs = { notify: false, minLevel: 'warning', sound: true, ...store.get(KEYS.prefs, {}) };

const map = createMap('map');
const zoneLayer = L.layerGroup().addTo(map);
const alertLayer = L.layerGroup().addTo(map);

function savePrefs() { store.set(KEYS.prefs, prefs); }

function personalZones() { return store.get(KEYS.personalZones, []); }
function hiddenOfficial() { return new Set(store.get(KEYS.hiddenOfficial, [])); }

function myZones() {
  const hidden = hiddenOfficial();
  return [...config.zones.filter(z => !hidden.has(z.id)), ...personalZones()];
}

// ---------- แสดงผล ----------
function render() {
  const zones = myZones();
  const alerts = matchZones(result.alerts, zones);
  const mine = sortAlerts(alerts.filter(a => a.zones.length));

  renderZones(zoneLayer, zones);
  markers = renderAlerts(alertLayer, alerts);
  renderSummary($('#summary'), mine);

  const typeMine = $('#filter-type-mine').value;
  renderAlertList($('#list-mine'), mine.filter(a => !typeMine || a.type === typeMine), {
    onSelect: focusAlert,
    emptyText: zones.length ? 'ไม่พบภัยในพื้นที่ที่ติดตาม' : 'ยังไม่ได้เลือกพื้นที่ติดตาม (ดูแท็บ "พื้นที่ & การตั้งค่า")'
  });

  const typeAll = $('#filter-type-all').value;
  const levelAll = $('#filter-level-all').value;
  renderAlertList($('#list-all'), sortAlerts(alerts).filter(a =>
    (!typeAll || a.type === typeAll) && (!levelAll || levelRank(a.level) >= levelRank(levelAll))
  ), { onSelect: focusAlert, emptyText: 'ไม่พบข้อมูลภัยในภูมิภาค' });

  renderZoneSettings();
  renderStatus($('#status'), result);
  return alerts;
}

function focusAlert(id) {
  const m = markers.get(id);
  if (!m) return;
  map.setView(m.getLatLng(), Math.max(map.getZoom(), 7));
  m.openPopup();
}

function renderZoneSettings() {
  const hidden = hiddenOfficial();
  $('#official-zones').innerHTML = config.zones.length
    ? `<div class="card"><h3>พื้นที่ที่หน่วยงานกำหนด</h3>${config.zones.map(z => `
        <label class="inline"><input type="checkbox" data-official="${escapeHtml(z.id)}" ${hidden.has(z.id) ? '' : 'checked'} />
          ${escapeHtml(z.name)} (${z.radiusKm} กม.)</label>`).join('<br>')}</div>`
    : '';
  const mine = personalZones();
  $('#personal-zones').innerHTML = mine.length
    ? `<div class="card"><h3>พื้นที่ของฉัน</h3>${mine.map(z => `
        <div class="row" style="display:flex;justify-content:space-between;align-items:center;margin:4px 0">
          <span>📍 ${escapeHtml(z.name)} (${z.radiusKm} กม.)</span>
          <button type="button" class="small danger" data-remove="${escapeHtml(z.id)}">ลบ</button>
        </div>`).join('')}</div>`
    : '';
}

// ---------- การแจ้งเตือน ----------
function notifyNew(alerts) {
  const seenList = store.get(KEYS.seen, null);
  const relevant = alerts.filter(a => a.zones.length);
  const firstRun = seenList === null;
  const seen = new Set(seenList ?? []);
  const fresh = relevant.filter(a => !seen.has(a.id));
  relevant.forEach(a => seen.add(a.id));
  store.set(KEYS.seen, [...seen].slice(-2000));

  // ครั้งแรกที่เปิดเว็บไม่แจ้งเตือนย้อนหลัง เพื่อไม่ให้แจ้งเตือนรัวๆ
  if (firstRun || !prefs.notify) return;
  const toNotify = fresh.filter(a => levelRank(a.level) >= levelRank(prefs.minLevel));
  toNotify.slice(0, 5).forEach(showBrowserNotification);
  if (toNotify.length && prefs.sound) {
    playAlertSound(toNotify.some(a => a.level === 'severe') ? 'severe' : 'warning');
  }
  if (toNotify.length) toast(`มีการแจ้งเตือนใหม่ ${toNotify.length} รายการ`);
}

function updateNotifyButton() {
  const btn = $('#notify-btn');
  if (!notificationSupported()) {
    btn.textContent = '🔕 เบราว์เซอร์ไม่รองรับการแจ้งเตือน';
    btn.disabled = true;
    return;
  }
  const on = prefs.notify && Notification.permission === 'granted';
  btn.textContent = on ? '🔔 การแจ้งเตือน: เปิด' : '🔕 เปิดการแจ้งเตือน';
  btn.classList.toggle('primary', on);
}

// ---------- โหลดข้อมูล ----------
async function refresh() {
  $('#status').textContent = 'กำลังโหลดข้อมูล...';
  const [res, announcements] = await Promise.all([
    collectAlerts(config, myZones()),
    loadAnnouncements()
  ]);
  result = res;
  renderAnnouncements($('#announcements'), activeAnnouncements(announcements));
  notifyNew(render());
}

function scheduleRefresh() {
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refresh, Math.max(config.refreshMinutes, 1) * 60 * 1000);
}

function addPersonalZone(lat, lon) {
  const name = $('#pz-name').value.trim() || 'พื้นที่ของฉัน';
  const radiusKm = Math.min(Math.max(Number($('#pz-radius').value) || 200, 10), 2000);
  const zones = personalZones();
  zones.push({ id: newId('me'), name, lat, lon, radiusKm, hazards: ALL_HAZARDS });
  store.set(KEYS.personalZones, zones);
  $('#pz-name').value = '';
  map.setView([lat, lon], 7);
  toast(`เพิ่ม "${name}" แล้ว กำลังโหลดข้อมูลของพื้นที่นี้`);
  refresh();
}

// ---------- เริ่มต้น ----------
function bindEvents() {
  setupTabs();
  ['#filter-type-mine', '#filter-type-all', '#filter-level-all'].forEach(s => $(s).addEventListener('change', render));
  $('#refresh-btn').addEventListener('click', refresh);

  $('#notify-btn').addEventListener('click', async () => {
    if (prefs.notify && Notification.permission === 'granted') {
      prefs.notify = false;
    } else {
      const perm = await requestNotificationPermission();
      prefs.notify = perm === 'granted';
      if (!prefs.notify) toast('เบราว์เซอร์ไม่อนุญาตการแจ้งเตือน กรุณาเปิดสิทธิ์ในการตั้งค่าเบราว์เซอร์');
      else toast('เปิดการแจ้งเตือนแล้ว จะแจ้งเมื่อมีภัยใหม่ในพื้นที่ที่ติดตาม');
    }
    savePrefs();
    updateNotifyButton();
  });

  $('#min-level').value = prefs.minLevel;
  $('#min-level').addEventListener('change', e => { prefs.minLevel = e.target.value; savePrefs(); });
  $('#sound-on').checked = prefs.sound;
  $('#sound-on').addEventListener('change', e => { prefs.sound = e.target.checked; savePrefs(); });

  $('#official-zones').addEventListener('change', e => {
    const id = e.target.dataset.official;
    if (!id) return;
    const hidden = hiddenOfficial();
    if (e.target.checked) hidden.delete(id); else hidden.add(id);
    store.set(KEYS.hiddenOfficial, [...hidden]);
    refresh();
  });

  $('#personal-zones').addEventListener('click', e => {
    const id = e.target.dataset.remove;
    if (!id) return;
    store.set(KEYS.personalZones, personalZones().filter(z => z.id !== id));
    refresh();
  });

  $('#pz-locate').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('เบราว์เซอร์ไม่รองรับการระบุตำแหน่ง');
    toast('กำลังขอตำแหน่ง...');
    navigator.geolocation.getCurrentPosition(
      pos => addPersonalZone(pos.coords.latitude, pos.coords.longitude),
      () => toast('ไม่สามารถระบุตำแหน่งได้ ลองเลือกจากแผนที่แทน'),
      { timeout: 15000, maximumAge: 5 * 60 * 1000 }
    );
  });

  $('#pz-pick').addEventListener('click', () => {
    document.body.classList.add('map-picking');
    toast('คลิกบนแผนที่เพื่อเลือกตำแหน่ง');
    map.once('click', e => {
      document.body.classList.remove('map-picking');
      addPersonalZone(e.latlng.lat, e.latlng.lng);
    });
  });
}

async function init() {
  fillTypeSelect($('#filter-type-mine'));
  fillTypeSelect($('#filter-type-all'));
  fillLevelSelect($('#filter-level-all'), { allLabel: 'ทุกระดับ', suffix: ' ขึ้นไป' });
  fillLevelSelect($('#min-level'), { suffix: ' ขึ้นไป' });
  bindEvents();
  updateNotifyButton();

  try {
    config = await loadSiteConfig();
  } catch (err) {
    console.error(err);
    $('#status').innerHTML = '<span class="err">โหลดไฟล์ตั้งค่า (data/config.json) ไม่ได้</span>';
    return;
  }

  document.title = config.siteName;
  $('#site-name').textContent = config.siteName;
  if (config.telegramChannelUrl) {
    $('#telegram-link').href = config.telegramChannelUrl;
    $('#telegram-link').hidden = false;
  }
  const r = config.region;
  map.fitBounds([[r.minLat, r.minLon], [r.maxLat, r.maxLon]]);

  await refresh();
  scheduleRefresh();
}

init();
