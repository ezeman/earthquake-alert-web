// แผนที่ Leaflet ที่ใช้ร่วมกัน (L มาจาก leaflet.js ที่โหลดผ่าน <script>)

import { HAZARDS, LEVEL_INFO, levelRank, escapeHtml, formatTime, levelBadge } from './core.js';

export function createMap(elementId, center = [13.5, 100.5], zoom = 5) {
  const map = L.map(elementId, { worldCopyJump: true }).setView(center, zoom);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors | ข้อมูล: USGS, GDACS, NASA EONET, Open-Meteo'
  }).addTo(map);
  return map;
}

function alertIcon(alert) {
  const h = HAZARDS[alert.type] ?? HAZARDS.other;
  const color = LEVEL_INFO[alert.level]?.color ?? '#555';
  const size = 22 + levelRank(alert.level) * 4;
  return L.divIcon({
    className: 'hazard-icon',
    html: `<span style="background:${color};width:${size}px;height:${size}px;font-size:${size * 0.55}px">${h.icon}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -size / 2]
  });
}

export function alertPopupHtml(alert) {
  const h = HAZARDS[alert.type] ?? HAZARDS.other;
  const rows = (alert.details ?? [])
    .map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('');
  const zones = alert.zones?.length
    ? `<tr><th>พื้นที่เฝ้าระวัง</th><td>${escapeHtml(alert.zones.map(z => z.distanceKm ? `${z.name} (${z.distanceKm} กม.)` : z.name).join(', '))}</td></tr>`
    : '';
  const link = alert.url ? `<a href="${escapeHtml(alert.url)}" target="_blank" rel="noopener">ดูรายละเอียดจาก ${escapeHtml(alert.source)}</a>` : '';
  return `<div class="popup">
    <div>${levelBadge(alert.level)} ${h.icon} ${escapeHtml(h.label)}</div>
    <h3>${escapeHtml(alert.title)}</h3>
    <table>${rows}<tr><th>เวลา</th><td>${escapeHtml(formatTime(alert.time))}</td></tr>${zones}
      <tr><th>แหล่งข้อมูล</th><td>${escapeHtml(alert.source)}</td></tr></table>
    ${link}
  </div>`;
}

// คืนค่า Map ของ id -> marker เพื่อให้รายการด้านข้างเปิด popup ได้
export function renderAlerts(layer, alerts) {
  layer.clearLayers();
  const markers = new Map();
  // วาดระดับต่ำก่อน เพื่อให้ระดับรุนแรงอยู่ด้านบน
  [...alerts].sort((a, b) => levelRank(a.level) - levelRank(b.level)).forEach(a => {
    const m = L.marker([a.lat, a.lon], { icon: alertIcon(a), zIndexOffset: levelRank(a.level) * 100 })
      .bindPopup(alertPopupHtml(a), { maxWidth: 320 })
      .addTo(layer);
    markers.set(a.id, m);
  });
  return markers;
}

export function renderZones(layer, zones, { color = '#1565c0', onClick } = {}) {
  layer.clearLayers();
  zones.forEach(z => {
    L.circle([z.lat, z.lon], {
      radius: z.radiusKm * 1000,
      color,
      weight: 1.5,
      dashArray: '6 4',
      fillOpacity: 0.05,
      interactive: false
    }).addTo(layer);
    const m = L.circleMarker([z.lat, z.lon], { radius: 6, color, fillColor: '#fff', fillOpacity: 1, weight: 3 })
      .bindTooltip(`${escapeHtml(z.name)} (รัศมี ${z.radiusKm} กม.)`)
      .addTo(layer);
    if (onClick) m.on('click', () => onClick(z));
  });
}
