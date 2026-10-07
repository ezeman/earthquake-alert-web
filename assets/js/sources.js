// ดึงข้อมูลภัยจากแหล่งสาธารณะ แล้วแปลงให้อยู่ในรูปแบบเดียวกัน (alert)
//
// alert = { id, source, type, level, title, lat, lon, time, details: [[label, value]], url, zoneId? }

import { fetchJson, levelFromThresholds, distanceKm } from './core.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// วันที่ "YYYY-MM-DD" จาก Open-Meteo เป็นเวลาท้องถิ่นของพื้นที่ จึงไม่ให้แปลงเป็น UTC
const thaiDate = day => new Date(`${day}T00:00`).toLocaleDateString('th-TH');

function inRegion(lat, lon, r) {
  return lat >= r.minLat && lat <= r.maxLat && lon >= r.minLon && lon <= r.maxLon;
}

// เวลาของ GDACS ไม่มี timezone ต่อท้าย แต่เป็น UTC
function parseUtc(str) {
  if (!str) return null;
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? str : `${str}Z`);
}

// ---------- USGS: แผ่นดินไหว + สัญญาณสึนามิ ----------
async function fetchUsgs(config) {
  const r = config.region;
  const t = config.thresholds;
  const start = new Date(Date.now() - 7 * DAY_MS).toISOString();
  const url = 'https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&orderby=time' +
    `&starttime=${start}&minmagnitude=2.5` +
    `&minlatitude=${r.minLat}&maxlatitude=${r.maxLat}&minlongitude=${r.minLon}&maxlongitude=${r.maxLon}`;
  const data = await fetchJson(url);
  const alerts = [];

  for (const f of data.features ?? []) {
    const [lon, lat, depth] = f.geometry?.coordinates ?? [];
    const p = f.properties ?? {};
    if (lat == null || lon == null) continue;
    const mag = typeof p.mag === 'number' ? p.mag : null;
    const details = [
      ['ขนาด', mag ?? 'ไม่ทราบ'],
      ['ความลึก', depth != null ? `${Math.round(depth)} กม.` : 'ไม่ทราบ'],
      ['สถานที่', p.place ?? 'ไม่ทราบ']
    ];
    alerts.push({
      id: `usgs:${f.id}`,
      source: 'USGS',
      type: 'earthquake',
      level: levelFromThresholds(mag, t.earthquake) ?? 'info',
      title: `แผ่นดินไหวขนาด ${mag ?? '?'} ${p.place ?? ''}`.trim(),
      lat, lon,
      time: p.time,
      details,
      url: p.url
    });

    // USGS ตั้ง tsunami=1 เมื่อเหตุการณ์อยู่ในเกณฑ์ที่ศูนย์เตือนภัยสึนามิออกข้อมูล
    if (p.tsunami === 1) {
      alerts.push({
        id: `usgs-tsunami:${f.id}`,
        source: 'USGS',
        type: 'tsunami',
        level: mag != null && mag >= t.tsunamiSevereMagnitude ? 'severe' : 'warning',
        title: `อาจเกิดสึนามิจากแผ่นดินไหวขนาด ${mag ?? '?'} ${p.place ?? ''}`.trim(),
        lat, lon,
        time: p.time,
        details: [...details, ['หมายเหตุ', 'โปรดติดตามประกาศจากกรมอุตุนิยมวิทยาและศูนย์เตือนภัยพิบัติแห่งชาติ']],
        url: p.url
      });
    }
  }
  return alerts;
}

// ---------- GDACS: พายุ น้ำท่วม ภูเขาไฟ ภัยแล้ง ไฟป่า ----------
const GDACS_TYPES = { TC: 'storm', FL: 'flood', VO: 'volcano', DR: 'drought', WF: 'wildfire' };
const GDACS_LEVELS = { red: 'severe', orange: 'warning', green: 'watch' };

async function fetchGdacs(config) {
  const day = d => d.toISOString().slice(0, 10);
  const url = 'https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH' +
    `?eventlist=${Object.keys(GDACS_TYPES).join(';')}&alertlevel=green;orange;red` +
    `&fromdate=${day(new Date(Date.now() - 30 * DAY_MS))}&todate=${day(new Date(Date.now() + DAY_MS))}`;
  const data = await fetchJson(url);
  const alerts = [];

  for (const f of data.features ?? []) {
    const p = f.properties ?? {};
    const type = GDACS_TYPES[p.eventtype];
    let [lon, lat] = f.geometry?.type === 'Point' ? f.geometry.coordinates : [];
    if (lat == null && p.latitude != null) { lat = p.latitude; lon = p.longitude; }
    if (!type || lat == null || !inRegion(lat, lon, config.region)) continue;
    if (p.iscurrent === false || p.iscurrent === 'false') continue;

    alerts.push({
      id: `gdacs:${p.eventtype}${p.eventid}:${p.episodeid ?? ''}`,
      source: 'GDACS',
      type,
      level: GDACS_LEVELS[String(p.alertlevel).toLowerCase()] ?? 'info',
      title: p.name || p.description || `${type} (GDACS)`,
      lat, lon,
      time: (parseUtc(p.todate) ?? parseUtc(p.fromdate) ?? new Date()).getTime(),
      details: [
        ['ประเทศ', p.country || '-'],
        ['ความรุนแรง', p.severitydata?.severitytext || '-'],
        ['ช่วงเวลา', `${parseUtc(p.fromdate)?.toLocaleDateString('th-TH') ?? '?'} – ${parseUtc(p.todate)?.toLocaleDateString('th-TH') ?? '?'}`]
      ],
      url: p.url?.report
    });
  }
  return alerts;
}

// ---------- NASA EONET: ไฟป่า ภูเขาไฟ พายุ ดินถล่ม หมอกควัน ----------
const EONET_TYPES = {
  wildfires: 'wildfire', volcanoes: 'volcano', severeStorms: 'storm', floods: 'flood',
  landslides: 'landslide', drought: 'drought', dustHaze: 'pm25'
};
const EONET_LEVELS = { severeStorms: 'warning', landslides: 'warning', floods: 'warning' };

function geometryPoint(g) {
  if (!g) return [];
  if (g.type === 'Point') return g.coordinates;
  if (g.type === 'Polygon' && g.coordinates?.[0]?.length) {
    const ring = g.coordinates[0];
    const sum = ring.reduce((acc, [x, y]) => [acc[0] + x, acc[1] + y], [0, 0]);
    return [sum[0] / ring.length, sum[1] / ring.length];
  }
  return [];
}

async function fetchEonet(config) {
  const r = config.region;
  const url = 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30' +
    `&bbox=${r.minLon},${r.maxLat},${r.maxLon},${r.minLat}`;
  const data = await fetchJson(url);
  const alerts = [];

  for (const e of data.events ?? []) {
    const cat = e.categories?.find(c => EONET_TYPES[c.id]);
    if (!cat) continue;
    const g = e.geometry?.[e.geometry.length - 1];
    const [lon, lat] = geometryPoint(g);
    if (lat == null || !inRegion(lat, lon, r)) continue;

    const details = [['ประเภท', cat.title]];
    if (g.magnitudeValue != null) details.push(['ค่าที่วัดได้', `${g.magnitudeValue} ${g.magnitudeUnit ?? ''}`.trim()]);
    alerts.push({
      id: `eonet:${e.id}`,
      source: 'NASA EONET',
      type: EONET_TYPES[cat.id],
      level: EONET_LEVELS[cat.id] ?? 'watch',
      title: e.title,
      lat, lon,
      time: new Date(g.date).getTime(),
      details,
      url: e.sources?.[0]?.url ?? e.link
    });
  }
  return alerts;
}

// ---------- Open-Meteo: พยากรณ์ฝนและลม 3 วันของแต่ละพื้นที่ ----------
async function fetchWeather(zone, config) {
  const url = 'https://api.open-meteo.com/v1/forecast' +
    `?latitude=${zone.lat}&longitude=${zone.lon}` +
    '&daily=precipitation_sum,wind_gusts_10m_max&timezone=auto&forecast_days=3';
  const data = await fetchJson(url);
  const d = data.daily ?? {};
  const checks = [
    { type: 'rain', key: 'precipitation_sum', unit: 'มม./วัน', label: 'ปริมาณฝน', t: config.thresholds.rainMmPerDay },
    { type: 'wind', key: 'wind_gusts_10m_max', unit: 'กม./ชม.', label: 'ลมกระโชกสูงสุด', t: config.thresholds.windGustKmh }
  ];
  const alerts = [];

  for (const c of checks) {
    if (!zone.hazards.includes(c.type)) continue;
    // เลือกวันที่รุนแรงที่สุดในช่วงพยากรณ์
    let worst = null;
    (d[c.key] ?? []).forEach((value, i) => {
      const level = levelFromThresholds(value, c.t);
      if (level && (!worst || value > worst.value)) worst = { value, level, date: d.time[i] };
    });
    if (!worst) continue;
    const name = c.type === 'rain' ? 'ฝนตกหนัก' : 'ลมแรง';
    alerts.push({
      id: `${c.type}:${zone.id}:${worst.date}:${worst.level}`,
      source: 'Open-Meteo',
      type: c.type,
      level: worst.level,
      title: `พยากรณ์${name} ${zone.name} วันที่ ${thaiDate(worst.date)}`,
      lat: zone.lat, lon: zone.lon,
      time: new Date(`${worst.date}T00:00`).getTime(),
      details: [[c.label, `${Math.round(worst.value * 10) / 10} ${c.unit}`]],
      zoneId: zone.id
    });
  }
  return alerts;
}

// ---------- Open-Meteo Air Quality: PM2.5 ----------
async function fetchAirQuality(zone, config) {
  const url = 'https://air-quality-api.open-meteo.com/v1/air-quality' +
    `?latitude=${zone.lat}&longitude=${zone.lon}` +
    '&current=pm2_5&hourly=pm2_5&forecast_days=2&timezone=auto';
  const data = await fetchJson(url);

  // มาตรฐานไทยใช้ค่าเฉลี่ย 24 ชั่วโมง จึงคำนวณค่าเฉลี่ยรายวันจากข้อมูลรายชั่วโมง
  const byDay = {};
  (data.hourly?.time ?? []).forEach((time, i) => {
    const v = data.hourly.pm2_5[i];
    if (v == null) return;
    const day = time.slice(0, 10);
    (byDay[day] ??= []).push(v);
  });
  const daily = Object.entries(byDay).map(([day, vals]) => ({
    day, avg: vals.reduce((a, b) => a + b, 0) / vals.length
  }));
  if (!daily.length) return [];

  const worst = daily.reduce((a, b) => (b.avg > a.avg ? b : a));
  const current = data.current?.pm2_5;
  const level = levelFromThresholds(worst.avg, config.thresholds.pm25) ?? 'info';
  return [{
    id: `pm25:${zone.id}:${worst.day}:${level}`,
    source: 'Open-Meteo',
    type: 'pm25',
    level,
    title: `PM2.5 ${zone.name} เฉลี่ย ${worst.avg.toFixed(1)} µg/m³ (${thaiDate(worst.day)})`,
    lat: zone.lat, lon: zone.lon,
    time: Date.now(),
    details: [
      ['ค่าปัจจุบัน', current != null ? `${current.toFixed(1)} µg/m³` : 'ไม่ทราบ'],
      ...daily.map(x => [`เฉลี่ย ${thaiDate(x.day)}`, `${x.avg.toFixed(1)} µg/m³`])
    ],
    zoneId: zone.id
  }];
}

// ---------- รวมทุกแหล่ง ----------
export async function collectAlerts(config, zones) {
  const jobs = [
    { name: 'USGS (แผ่นดินไหว)', run: () => fetchUsgs(config) },
    { name: 'GDACS', run: () => fetchGdacs(config) },
    { name: 'NASA EONET', run: () => fetchEonet(config) }
  ];
  const weatherZones = zones.filter(z => z.hazards.includes('rain') || z.hazards.includes('wind'));
  const airZones = zones.filter(z => z.hazards.includes('pm25'));
  if (weatherZones.length) {
    jobs.push({ name: 'Open-Meteo (ฝน/ลม)', run: async () => (await Promise.all(weatherZones.map(z => fetchWeather(z, config)))).flat() });
  }
  if (airZones.length) {
    jobs.push({ name: 'Open-Meteo (PM2.5)', run: async () => (await Promise.all(airZones.map(z => fetchAirQuality(z, config)))).flat() });
  }

  const results = await Promise.allSettled(jobs.map(j => j.run()));
  const status = results.map((r, i) => ({
    name: jobs[i].name,
    ok: r.status === 'fulfilled',
    count: r.status === 'fulfilled' ? r.value.length : 0,
    error: r.status === 'rejected' ? String(r.reason?.message ?? r.reason) : null
  }));
  results.filter(r => r.status === 'rejected').forEach(r => console.warn(r.reason));

  const seen = new Set();
  const alerts = results
    .flatMap(r => (r.status === 'fulfilled' ? r.value : []))
    .filter(a => !seen.has(a.id) && seen.add(a.id));
  return { alerts, status, updatedAt: Date.now() };
}

// ระบุว่าภัยแต่ละรายการอยู่ในพื้นที่เฝ้าระวังใดบ้าง
export function matchZones(alerts, zones) {
  return alerts.map(a => {
    const hits = [];
    for (const z of zones) {
      if (!z.hazards.includes(a.type)) continue;
      if (a.zoneId) {
        if (a.zoneId === z.id) hits.push({ id: z.id, name: z.name, distanceKm: 0 });
        continue;
      }
      const d = distanceKm(z.lat, z.lon, a.lat, a.lon);
      if (d <= z.radiusKm) hits.push({ id: z.id, name: z.name, distanceKm: Math.round(d) });
    }
    return { ...a, zones: hits };
  });
}
