// ข้อมูลพื้นฐานที่ใช้ร่วมกันระหว่างหน้าสาธารณะและหน้าผู้ดูแล

export const HAZARDS = {
  earthquake: { label: 'แผ่นดินไหว', icon: '🌐' },
  tsunami:    { label: 'สึนามิ', icon: '🌊' },
  flood:      { label: 'น้ำท่วม', icon: '💧' },
  storm:      { label: 'พายุ', icon: '🌀' },
  rain:       { label: 'ฝนตกหนัก', icon: '🌧️' },
  wind:       { label: 'ลมแรง', icon: '💨' },
  wildfire:   { label: 'ไฟป่า', icon: '🔥' },
  pm25:       { label: 'ฝุ่น PM2.5', icon: '😷' },
  volcano:    { label: 'ภูเขาไฟ', icon: '🌋' },
  landslide:  { label: 'ดินถล่ม', icon: '⛰️' },
  drought:    { label: 'ภัยแล้ง', icon: '☀️' },
  other:      { label: 'อื่นๆ', icon: '⚠️' }
};

export const LEVELS = ['info', 'watch', 'warning', 'severe'];

export const LEVEL_INFO = {
  info:    { label: 'ข้อมูล', color: '#2e7d32' },
  watch:   { label: 'เฝ้าระวัง', color: '#f9a825' },
  warning: { label: 'เตือนภัย', color: '#ef6c00' },
  severe:  { label: 'อันตราย', color: '#c62828' }
};

export const levelRank = (level) => Math.max(LEVELS.indexOf(level), 0);

export function levelFromThresholds(value, t) {
  if (value == null || !t) return null;
  if (value >= t.severe) return 'severe';
  if (value >= t.warning) return 'warning';
  if (value >= t.watch) return 'watch';
  return null;
}

export function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

export function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function formatTime(time) {
  return new Date(time).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}

export function timeAgo(time) {
  const mins = Math.round((Date.now() - new Date(time).getTime()) / 60000);
  if (mins < 0) return 'คาดการณ์';
  if (mins < 60) return `${mins} นาทีที่แล้ว`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} ชั่วโมงที่แล้ว`;
  return `${Math.round(hours / 24)} วันที่แล้ว`;
}

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// localStorage อาจใช้ไม่ได้ (โหมดส่วนตัว, ถูกบล็อก) จึงห่อด้วย try/catch เสมอ
export const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      console.warn('บันทึกข้อมูลในเครื่องไม่ได้', err);
    }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }
};

export async function fetchJson(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} จาก ${new URL(url, location.href).host}`);
  return res.json();
}

export async function loadSiteConfig() {
  return fetchJson(`data/config.json?t=${Date.now()}`);
}

export async function loadAnnouncements() {
  try {
    const list = await fetchJson(`data/announcements.json?t=${Date.now()}`);
    return Array.isArray(list) ? list : [];
  } catch (err) {
    console.warn('โหลดประกาศไม่ได้', err);
    return [];
  }
}

export function activeAnnouncements(list) {
  const now = Date.now();
  return list
    .filter(a => !a.expires || new Date(a.expires).getTime() > now)
    .sort((a, b) => levelRank(b.level) - levelRank(a.level) ||
                    new Date(b.time) - new Date(a.time));
}

export function hazardBadge(type) {
  const h = HAZARDS[type] ?? HAZARDS.other;
  return `${h.icon} ${h.label}`;
}

export function levelBadge(level) {
  const l = LEVEL_INFO[level] ?? LEVEL_INFO.info;
  return `<span class="badge" style="background:${l.color}">${l.label}</span>`;
}

export function downloadFile(filename, content, type = 'application/json') {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
