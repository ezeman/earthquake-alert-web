// ส่วนประกอบหน้าจอที่ใช้ร่วมกัน

import {
  HAZARDS, LEVELS, LEVEL_INFO, levelRank, escapeHtml, formatTime, timeAgo, hazardBadge, levelBadge
} from './core.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function setupTabs(onChange) {
  $$('.tabs button').forEach(btn => btn.addEventListener('click', () => {
    $$('.tabs button').forEach(b => b.classList.toggle('active', b === btn));
    $$('.tab-content').forEach(c => { c.hidden = c.dataset.tab !== btn.dataset.tab; });
    onChange?.(btn.dataset.tab);
  }));
}

export function fillTypeSelect(select, allLabel = 'ทุกประเภทภัย') {
  select.innerHTML = `<option value="">${allLabel}</option>` +
    Object.entries(HAZARDS).map(([k, h]) => `<option value="${k}">${h.icon} ${h.label}</option>`).join('');
}

export function fillLevelSelect(select, { allLabel, suffix = '' } = {}) {
  select.innerHTML = (allLabel ? `<option value="">${allLabel}</option>` : '') +
    LEVELS.map(l => `<option value="${l}">${LEVEL_INFO[l].label}${suffix}</option>`).join('');
}

export function sortAlerts(alerts) {
  return [...alerts].sort((a, b) => levelRank(b.level) - levelRank(a.level) || b.time - a.time);
}

export function renderSummary(el, alerts) {
  const counts = Object.fromEntries(LEVELS.map(l => [l, 0]));
  alerts.forEach(a => { counts[a.level] = (counts[a.level] ?? 0) + 1; });
  el.innerHTML = [...LEVELS].reverse().map(l =>
    `<div class="tile" style="background:${LEVEL_INFO[l].color}"><b>${counts[l]}</b><span>${LEVEL_INFO[l].label}</span></div>`
  ).join('');
}

// extra(alert) คืนค่า HTML เพิ่มเติมท้ายรายการ (เช่น ปุ่มของผู้ดูแล)
export function renderAlertList(el, alerts, { onSelect, extra, emptyText = 'ไม่มีรายการ' } = {}) {
  if (!alerts.length) {
    el.innerHTML = `<li class="empty">${escapeHtml(emptyText)}</li>`;
    return;
  }
  el.innerHTML = alerts.map(a => {
    const zones = a.zones?.length
      ? ` · ${escapeHtml(a.zones.map(z => z.distanceKm ? `${z.name} ${z.distanceKm} กม.` : z.name).join(', '))}`
      : '';
    return `<li class="alert-item" data-id="${escapeHtml(a.id)}" style="--level-color:${LEVEL_INFO[a.level]?.color}">
      <div class="row"><span>${levelBadge(a.level)} ${hazardBadge(a.type)}</span>
        <span class="meta" title="${escapeHtml(formatTime(a.time))}">${escapeHtml(timeAgo(a.time))}</span></div>
      <div class="title">${escapeHtml(a.title)}</div>
      <div class="row"><span class="meta">${escapeHtml(a.source)}${zones}</span>${extra ? extra(a) : ''}</div>
    </li>`;
  }).join('');
  if (onSelect) {
    $$('.alert-item', el).forEach(li => li.addEventListener('click', e => {
      if (e.target.closest('button, a')) return;
      onSelect(li.dataset.id);
    }));
  }
}

export function renderAnnouncements(el, list) {
  el.innerHTML = list.map(a => `
    <div class="announcement" style="--level-color:${LEVEL_INFO[a.level]?.color ?? '#888'}">
      <h3>📢 ${levelBadge(a.level)} ${escapeHtml(a.title)}</h3>
      <p>${escapeHtml(a.body)}</p>
      <small>${a.area ? `พื้นที่: ${escapeHtml(a.area)} · ` : ''}ประกาศ ${escapeHtml(formatTime(a.time))}${a.expires ? ` · มีผลถึง ${escapeHtml(formatTime(a.expires))}` : ''}</small>
    </div>`).join('');
}

export function renderStatus(el, result) {
  const parts = result.status.map(s => s.ok
    ? `<span class="ok">✔ ${escapeHtml(s.name)} (${s.count})</span>`
    : `<span class="err" title="${escapeHtml(s.error)}">✖ ${escapeHtml(s.name)}</span>`);
  el.innerHTML = `อัปเดต ${escapeHtml(new Date(result.updatedAt).toLocaleTimeString('th-TH'))} · ${parts.join(' · ')}`;
}

let toastTimer;
export function toast(message) {
  let el = $('.toast');
  if (!el) {
    el = Object.assign(document.createElement('div'), { className: 'toast' });
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4000);
}
