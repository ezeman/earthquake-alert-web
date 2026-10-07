// ช่องทางแจ้งเตือน: เบราว์เซอร์ และ Telegram + การเผยแพร่ไฟล์ขึ้น GitHub

import { HAZARDS, LEVEL_INFO, escapeHtml, formatTime } from './core.js';

// ---------- แจ้งเตือนบนเบราว์เซอร์ ----------
export function notificationSupported() {
  return 'Notification' in window;
}

export async function requestNotificationPermission() {
  if (!notificationSupported()) return 'unsupported';
  if (Notification.permission === 'default') return Notification.requestPermission();
  return Notification.permission;
}

export function showBrowserNotification(alert) {
  if (!notificationSupported() || Notification.permission !== 'granted') return;
  const h = HAZARDS[alert.type] ?? HAZARDS.other;
  const lvl = LEVEL_INFO[alert.level]?.label ?? '';
  const where = alert.zones?.length ? `พื้นที่: ${alert.zones.map(z => z.name).join(', ')}` : '';
  try {
    const n = new Notification(`${h.icon} [${lvl}] ${h.label}`, {
      body: `${alert.title}\n${where}`.trim(),
      tag: alert.id,
      requireInteraction: alert.level === 'severe'
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch (err) {
    // บางเบราว์เซอร์บนมือถือต้องใช้ Service Worker ในการแสดงแจ้งเตือน
    console.warn('แสดงแจ้งเตือนไม่ได้', err);
  }
}

let audioCtx;
export function playAlertSound(level) {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const beeps = level === 'severe' ? 3 : 1;
    for (let i = 0; i < beeps; i++) {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.frequency.value = level === 'severe' ? 880 : 660;
      osc.connect(gain).connect(audioCtx.destination);
      const t = audioCtx.currentTime + i * 0.35;
      gain.gain.setValueAtTime(0.25, t);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
      osc.start(t);
      osc.stop(t + 0.3);
    }
  } catch { /* ไม่มีเสียงก็ไม่เป็นไร */ }
}

// ---------- Telegram ----------
export function formatAlertForTelegram(alert, siteUrl) {
  const h = HAZARDS[alert.type] ?? HAZARDS.other;
  const lvl = LEVEL_INFO[alert.level]?.label ?? '';
  const lines = [
    `${h.icon} <b>[${escapeHtml(lvl)}] ${escapeHtml(h.label)}</b>`,
    escapeHtml(alert.title),
    '',
    ...(alert.details ?? []).map(([k, v]) => `• ${escapeHtml(k)}: ${escapeHtml(v)}`),
    `• เวลา: ${escapeHtml(formatTime(alert.time))}`
  ];
  if (alert.zones?.length) {
    lines.push(`• พื้นที่: ${escapeHtml(alert.zones.map(z => z.distanceKm ? `${z.name} (${z.distanceKm} กม.)` : z.name).join(', '))}`);
  }
  lines.push(`• แหล่งข้อมูล: ${escapeHtml(alert.source)}`);
  if (alert.url) lines.push(`<a href="${escapeHtml(alert.url)}">รายละเอียด</a>`);
  if (siteUrl) lines.push(`<a href="${escapeHtml(siteUrl)}">เปิดแผนที่</a>`);
  return lines.join('\n');
}

export function formatAnnouncementForTelegram(a) {
  const lvl = LEVEL_INFO[a.level]?.label ?? '';
  const lines = [`📢 <b>ประกาศ [${escapeHtml(lvl)}]: ${escapeHtml(a.title)}</b>`, '', escapeHtml(a.body)];
  if (a.area) lines.push('', `พื้นที่: ${escapeHtml(a.area)}`);
  if (a.expires) lines.push(`มีผลถึง: ${escapeHtml(formatTime(a.expires))}`);
  return lines.join('\n');
}

export async function sendTelegram({ token, chatId }, html) {
  if (!token || !chatId) throw new Error('ยังไม่ได้ตั้งค่า Bot Token หรือ Chat ID');
  // ส่งแบบ form-urlencoded เพื่อเลี่ยง CORS preflight
  const body = new URLSearchParams({
    chat_id: chatId,
    text: html,
    parse_mode: 'HTML',
    disable_web_page_preview: 'true'
  });
  const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, { method: 'POST', body });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data.description || `Telegram ตอบกลับ HTTP ${res.status}`);
  return data.result;
}

// ---------- เผยแพร่ไฟล์ขึ้น GitHub (ใช้ Personal Access Token ของผู้ดูแล) ----------
function toBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

export async function publishToGitHub({ repo, branch, token }, path, content, message) {
  if (!repo || !token) throw new Error('ยังไม่ได้ตั้งค่า GitHub repository หรือ token');
  const api = `https://api.github.com/repos/${repo}/contents/${path}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' };

  let sha;
  const existing = await fetch(`${api}?ref=${encodeURIComponent(branch)}`, { headers });
  if (existing.ok) sha = (await existing.json()).sha;
  else if (existing.status !== 404) throw new Error(`อ่านไฟล์เดิมไม่ได้ (HTTP ${existing.status})`);

  const res = await fetch(api, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ message, content: toBase64Utf8(content), branch, sha })
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.message || `GitHub ตอบกลับ HTTP ${res.status}`);
  }
  return res.json();
}
