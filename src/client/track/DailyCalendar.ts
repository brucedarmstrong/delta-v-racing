// Mod-only calendar for curating the Daily track schedule. Mobile-first: drag
// uses Pointer Events (not HTML5 dragstart/drop, which never fire on touch),
// and every drag gesture has a tap-tap equivalent (select a chip/day, then tap
// the target day) since precise dragging is failure-prone on small touchscreens.

import {
  fetchDailyTracks, fetchMineTracks, fetchCommunityTracks,
  reassignDailyTrack, removeDailyTrack, promoteDraftToDaily,
} from './TrackUpload';
import type { DailyTrackEntry, MineTrackMeta, CommunityTrackMeta } from '../../shared/api';

const DRAG_THRESHOLD = 10; // px of movement before a pointerdown counts as a drag, not a tap

type Selection =
  | { kind: 'cell';       date: string }              // moving an already-scheduled day
  | { kind: 'draft';      mineId: string; name: string }
  | { kind: 'community';  trackId: string; name: string };

// onClose fires once the dialog is dismissed (✕ or tap-outside), after any
// edits made in this session — so the caller can refresh whatever list it's
// showing behind the dialog (schedule/draft/community state may have changed).
export function showDailyCalendarDialog(onClose?: () => void): void {
  const todayStr = new Date().toISOString().slice(0, 10);
  const view = new Date();
  view.setDate(1);

  let schedule: Map<string, DailyTrackEntry> = new Map();
  let drafts: MineTrackMeta[] = [];
  let communityQuery = '';
  let communityTracks: CommunityTrackMeta[] = [];
  let selection: Selection | null = null;
  let viewedDate: string | null = null; // day tapped just to inspect its full name, not to move it
  let loaded = false;

  const overlay = document.createElement('div');
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:2000',
    'display:flex', 'align-items:flex-start', 'justify-content:center',
    'background:rgba(0,0,0,0.82)', 'padding:16px', 'box-sizing:border-box',
    'overflow-y:auto',
  ].join(';');
  const close = (): void => {
    overlay.remove();
    onClose?.();
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const card = document.createElement('div');
  card.style.cssText = [
    'background:#0d0d1e', 'border:1.5px solid #335566', 'border-radius:10px',
    'padding:16px', 'width:min(480px,100%)', 'box-sizing:border-box',
    'display:flex', 'flex-direction:column', 'gap:14px',
    'font-family:Arial,sans-serif', 'color:#ccddff',
    'box-shadow:0 8px 32px rgba(0,0,0,0.85)',
  ].join(';');

  const headerRow = document.createElement('div');
  headerRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
  const title = document.createElement('div');
  title.textContent = 'Daily Schedule';
  title.style.cssText = 'font:bold 16px "Arial Black",Arial,sans-serif;color:#aaccff;';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none;border:none;color:#8899bb;font:18px Arial;cursor:pointer;padding:4px 8px;';
  closeBtn.addEventListener('click', () => close());
  headerRow.appendChild(title);
  headerRow.appendChild(closeBtn);

  const monthNavRow = document.createElement('div');
  monthNavRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;';
  const prevBtn = mkNavBtn('‹');
  const nextBtn = mkNavBtn('›');
  const monthLabel = document.createElement('div');
  monthLabel.style.cssText = 'font:bold 14px Arial,sans-serif;color:#e8e8ff;';
  prevBtn.addEventListener('click', () => { view.setMonth(view.getMonth() - 1); renderGrid(); });
  nextBtn.addEventListener('click', () => { view.setMonth(view.getMonth() + 1); renderGrid(); });
  monthNavRow.appendChild(prevBtn);
  monthNavRow.appendChild(monthLabel);
  monthNavRow.appendChild(nextBtn);

  const gridEl = document.createElement('div');
  gridEl.style.cssText = 'display:grid;grid-template-columns:repeat(7,1fr);gap:4px;min-width:0;';

  // Shows the tapped day's un-truncated track name — cells clamp long names to
  // 2 lines, so this is the only place to read a long title in full. Tapping
  // a day just to inspect it here never moves anything; only a real drag (or
  // tapping a selected chip onto a day) reassigns.
  const viewedNameEl = document.createElement('div');
  viewedNameEl.style.cssText = [
    'min-height:16px', 'font:bold 12px Arial,sans-serif', 'color:#ffee88',
    'text-align:center', 'word-break:break-word', 'padding:0 4px',
  ].join(';');

  const hint = document.createElement('div');
  hint.textContent = 'Tap a track below, then tap a day — or drag it onto one. Drag an assigned day to move it.';
  hint.style.cssText = 'font:11px Arial,sans-serif;color:#667799;text-align:center;';

  const sourceWrap = document.createElement('div');
  sourceWrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;';

  const draftsHeading = document.createElement('div');
  draftsHeading.textContent = 'MY VERIFIED DRAFTS';
  draftsHeading.style.cssText = 'font:bold 11px Arial,sans-serif;color:#778;letter-spacing:0.08em;';
  const draftsList = document.createElement('div');
  draftsList.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:160px;overflow-y:auto;';

  const communityHeading = document.createElement('div');
  communityHeading.textContent = 'COMMUNITY TRACKS';
  communityHeading.style.cssText = 'font:bold 11px Arial,sans-serif;color:#778;letter-spacing:0.08em;margin-top:4px;';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search community tracks…';
  searchInput.style.cssText = [
    'width:100%', 'padding:8px', 'box-sizing:border-box', 'margin-top:4px',
    'background:#1a1a2e', 'border:1px solid #335566', 'border-radius:5px',
    'color:#ccddff', 'font:13px Arial,sans-serif',
  ].join(';');
  let searchDebounce: ReturnType<typeof setTimeout> | null = null;
  searchInput.addEventListener('input', () => {
    if (searchDebounce) clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => {
      communityQuery = searchInput.value.trim();
      void loadCommunity();
    }, 250);
  });
  const communityList = document.createElement('div');
  communityList.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:200px;overflow-y:auto;margin-top:6px;';

  const status = document.createElement('div');
  status.textContent = 'Loading…';
  status.style.cssText = 'text-align:center;color:#667799;font:13px Arial,sans-serif;';

  sourceWrap.appendChild(draftsHeading);
  sourceWrap.appendChild(draftsList);
  sourceWrap.appendChild(communityHeading);
  sourceWrap.appendChild(searchInput);
  sourceWrap.appendChild(communityList);

  card.appendChild(headerRow);
  card.appendChild(monthNavRow);
  card.appendChild(gridEl);
  card.appendChild(viewedNameEl);
  card.appendChild(hint);
  card.appendChild(status);
  card.appendChild(sourceWrap);
  overlay.appendChild(card);
  document.body.appendChild(overlay);

  void init();

  // ── Data loading ──────────────────────────────────────────────────────────

  async function init(): Promise<void> {
    try {
      const [scheduleEntries, myDrafts] = await Promise.all([fetchDailyTracks(), fetchMineTracks()]);
      schedule = new Map(scheduleEntries.map(e => [e.date, e]));
      drafts   = myDrafts.filter(d => d.verified);
      loaded   = true;
      status.remove();
      renderGrid();
      renderDrafts();
      await loadCommunity();
    } catch {
      status.textContent = 'Failed to load daily schedule.';
    }
  }

  async function loadCommunity(): Promise<void> {
    try {
      const { tracks } = await fetchCommunityTracks({ q: communityQuery, limit: 20 });
      communityTracks = tracks;
      renderCommunity();
    } catch { /* leave previous list showing */ }
  }

  async function refreshSchedule(): Promise<void> {
    const entries = await fetchDailyTracks();
    schedule = new Map(entries.map(e => [e.date, e]));
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  function renderGrid(): void {
    if (!loaded) return;
    gridEl.innerHTML = '';
    monthLabel.textContent = view.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

    const year  = view.getFullYear();
    const month = view.getMonth();
    const firstWeekday = new Date(year, month, 1).getDay();
    const daysInMonth  = new Date(year, month + 1, 0).getDate();

    for (const wd of ['S', 'M', 'T', 'W', 'T', 'F', 'S']) {
      const el = document.createElement('div');
      el.textContent = wd;
      el.style.cssText = 'text-align:center;font:bold 10px Arial,sans-serif;color:#556;padding-bottom:2px;';
      gridEl.appendChild(el);
    }
    for (let i = 0; i < firstWeekday; i++) gridEl.appendChild(document.createElement('div'));

    for (let day = 1; day <= daysInMonth; day++) {
      const date    = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const entry   = schedule.get(date);
      const isPast  = date < todayStr;
      const isToday = date === todayStr;

      const cell = document.createElement('div');
      cell.dataset.calDate = date;
      cell.style.cssText = [
        'min-height:44px', 'min-width:0', 'border-radius:6px', 'padding:3px',
        'box-sizing:border-box', 'display:flex', 'flex-direction:column',
        'gap:2px', 'font:10px Arial,sans-serif', 'cursor:pointer', 'overflow:hidden',
        `background:${entry ? (isPast ? '#16222e' : '#182a3a') : '#12122a'}`,
        `border:1px solid ${isToday ? '#5566aa' : entry ? (isPast ? '#2a4050' : '#335566') : '#2a2a4a'}`,
        isPast ? 'opacity:0.8;' : '',
        'position:relative', 'touch-action:none', 'user-select:none',
      ].join(';');

      const dayNum = document.createElement('div');
      dayNum.textContent = String(day);
      dayNum.style.cssText = 'font:bold 10px Arial,sans-serif;color:#8899cc;';
      cell.appendChild(dayNum);

      if (entry) {
        // Multi-word names wrap onto a second line instead of forcing the grid
        // column wide enough for one unbroken line (which pushed the whole
        // calendar into horizontal-scroll territory on narrow screens); a
        // single very long word still breaks mid-word rather than overflowing.
        const nameEl = document.createElement('div');
        nameEl.textContent = entry.name;
        nameEl.style.cssText = [
          'color:#aaddff', 'font:10px Arial,sans-serif', 'line-height:1.15',
          'overflow:hidden', 'display:-webkit-box',
          '-webkit-line-clamp:2', '-webkit-box-orient:vertical',
          'overflow-wrap:break-word', 'word-break:break-word',
        ].join(';');
        cell.appendChild(nameEl);

        const rmBtn = document.createElement('div');
        rmBtn.textContent = '✕';
        rmBtn.dataset.rmBtn = '1';
        rmBtn.style.cssText = [
          'position:absolute', 'top:1px', 'right:2px', 'color:#996666',
          'font:10px Arial,sans-serif', 'cursor:pointer', 'padding:2px',
        ].join(';');
        rmBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          void removeDailyTrack(date).then(() => { selection = null; void refreshSchedule().then(() => { renderGrid(); renderDrafts(); void loadCommunity(); }); });
        });
        cell.appendChild(rmBtn);
      }

      wireCellInteraction(cell, date, !!entry);
      gridEl.appendChild(cell);
    }

    highlightSelection();
    renderViewedName();
  }

  function renderViewedName(): void {
    if (!viewedDate) { viewedNameEl.textContent = ''; return; }
    const entry = schedule.get(viewedDate);
    const [y, m, d] = viewedDate.split('-').map(Number);
    const label = new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    viewedNameEl.textContent = entry ? `${label}: ${entry.name}` : `${label}: unassigned`;
  }

  function renderDrafts(): void {
    draftsList.innerHTML = '';
    const scheduledIds = new Set(Array.from(schedule.values()).map(e => e.trackId));
    const eligible = drafts.filter(d => !scheduledIds.has(d.id));
    if (eligible.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No verified drafts available.';
      empty.style.cssText = 'font:12px Arial,sans-serif;color:#556;';
      draftsList.appendChild(empty);
      return;
    }
    for (const d of eligible) {
      const chip = mkChip(d.name);
      chip.dataset.chipId = d.id;
      wireSourceInteraction(chip, { kind: 'draft', mineId: d.id, name: d.name });
      draftsList.appendChild(chip);
    }
  }

  function renderCommunity(): void {
    communityList.innerHTML = '';
    const scheduledIds = new Set(Array.from(schedule.values()).map(e => e.trackId));
    const eligible = communityTracks.filter(t => !scheduledIds.has(t.id));
    if (eligible.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = 'No matching community tracks.';
      empty.style.cssText = 'font:12px Arial,sans-serif;color:#556;';
      communityList.appendChild(empty);
      return;
    }
    for (const t of eligible) {
      const chip = mkChip(`${t.name}`, `by ${t.author}`);
      chip.dataset.chipId = t.id;
      wireSourceInteraction(chip, { kind: 'community', trackId: t.id, name: t.name });
      communityList.appendChild(chip);
    }
  }

  function highlightSelection(): void {
    for (const cellEl of Array.from(gridEl.children) as HTMLElement[]) {
      const date = cellEl.dataset.calDate;
      const isDragSel = !!date && selection?.kind === 'cell' && selection.date === date;
      const isViewed  = !!date && viewedDate === date;
      cellEl.style.outline = isDragSel ? '2px solid #ffcc44' : isViewed ? '2px solid #557799' : 'none';
    }
    for (const list of [draftsList, communityList]) {
      for (const chipEl of Array.from(list.children) as HTMLElement[]) {
        const id = chipEl.dataset.chipId;
        const isSel =
          !!id && ((selection?.kind === 'draft' && selection.mineId === id) ||
                   (selection?.kind === 'community' && selection.trackId === id));
        chipEl.style.outline = isSel ? '2px solid #ffcc44' : 'none';
      }
    }
  }

  // ── Commit (shared by drag drop and tap-tap) ───────────────────────────────

  async function commitTo(toDate: string): Promise<void> {
    if (!selection) return;
    const sel = selection;
    selection = null;
    try {
      if (sel.kind === 'cell') {
        if (sel.date === toDate) { highlightSelection(); return; }
        const entry = schedule.get(sel.date);
        if (!entry) return;
        await reassignDailyTrack(entry.trackId, toDate, sel.date);
      } else if (sel.kind === 'draft') {
        await promoteDraftToDaily(sel.mineId, toDate);
      } else {
        await reassignDailyTrack(sel.trackId, toDate);
      }
      await refreshSchedule();
      renderGrid();
      renderDrafts();
      renderCommunity();
    } catch (err) {
      showLocalToast(err instanceof Error ? err.message : 'Failed to assign track');
      highlightSelection();
    }
  }

  // ── Interaction: tap-tap + pointer drag, unified ───────────────────────────

  function wireCellInteraction(cell: HTMLElement, date: string, occupied: boolean): void {
    let dragging = false, moved = false, startX = 0, startY = 0, ghost: HTMLElement | null = null;

    const isRmBtn = (e: Event) => (e.target as HTMLElement).closest('[data-rm-btn]') !== null;

    cell.addEventListener('pointerdown', (e) => {
      if (!occupied || isRmBtn(e)) return; // empty days are drop targets only; let the ✕ handle its own click
      startX = e.clientX; startY = e.clientY; moved = false; dragging = true;
      cell.setPointerCapture(e.pointerId);
    });
    cell.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        moved = true;
        selection = { kind: 'cell', date };
        highlightSelection();
        ghost = mkGhost(schedule.get(date)?.name ?? '');
      }
      if (moved && ghost) positionGhost(ghost, e.clientX, e.clientY);
    });
    cell.addEventListener('pointerup', (e) => {
      if (isRmBtn(e)) return;
      dragging = false;
      if (moved && ghost) {
        ghost.remove(); ghost = null;
        const dropDate = dateAtPoint(e.clientX, e.clientY);
        if (dropDate) { selection = { kind: 'cell', date }; void commitTo(dropDate); }
        return;
      }
      // Plain tap. A pending chip (draft/community) selection still commits
      // on tap — that's the "tap a track, then tap a day" assign flow. But a
      // plain tap on one day then another never swaps/moves anything; that's
      // drag-only now, so mods can tap around to compare full names (below
      // the calendar) without accidentally rearranging the schedule.
      if (selection && selection.kind !== 'cell') { void commitTo(date); return; }
      viewedDate = viewedDate === date ? null : date;
      renderViewedName();
      highlightSelection();
    });
  }

  function wireSourceInteraction(chip: HTMLElement, item: Selection): void {
    let dragging = false, moved = false, startX = 0, startY = 0, ghost: HTMLElement | null = null;

    chip.addEventListener('pointerdown', (e) => {
      startX = e.clientX; startY = e.clientY; moved = false; dragging = true;
      chip.setPointerCapture(e.pointerId);
    });
    chip.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (!moved && Math.hypot(dx, dy) > DRAG_THRESHOLD) {
        moved = true;
        selection = item;
        highlightSelection();
        ghost = mkGhost(item.kind === 'cell' ? '' : item.name);
      }
      if (moved && ghost) positionGhost(ghost, e.clientX, e.clientY);
    });
    chip.addEventListener('pointerup', (e) => {
      dragging = false;
      if (moved && ghost) {
        ghost.remove(); ghost = null;
        const dropDate = dateAtPoint(e.clientX, e.clientY);
        if (dropDate) { selection = item; void commitTo(dropDate); }
        return;
      }
      // Plain tap: toggle selection.
      const same =
        (selection?.kind === 'draft' && item.kind === 'draft' && selection.mineId === item.mineId) ||
        (selection?.kind === 'community' && item.kind === 'community' && selection.trackId === item.trackId);
      selection = same ? null : item;
      highlightSelection();
    });
  }

  function dateAtPoint(x: number, y: number): string | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const cellEl = el?.closest<HTMLElement>('[data-cal-date]');
    return cellEl?.dataset.calDate ?? null;
  }

  // ── Small DOM builders ──────────────────────────────────────────────────────

  function mkNavBtn(label: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = [
      'background:#1a1a2e', 'border:1px solid #335566', 'border-radius:6px',
      'color:#aaccff', 'font:bold 16px Arial,sans-serif', 'padding:4px 14px', 'cursor:pointer',
    ].join(';');
    return b;
  }

  function mkChip(name: string, sub?: string): HTMLElement {
    const chip = document.createElement('div');
    chip.style.cssText = [
      'background:#182a3a', 'border:1px solid #335566', 'border-radius:6px',
      'padding:8px 10px', 'display:flex', 'flex-direction:column', 'gap:2px',
      'touch-action:none', 'user-select:none', 'cursor:pointer',
    ].join(';');
    const nameEl = document.createElement('div');
    nameEl.textContent = name;
    nameEl.style.cssText = 'font:bold 12px Arial,sans-serif;color:#ccddff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    chip.appendChild(nameEl);
    if (sub) {
      const subEl = document.createElement('div');
      subEl.textContent = sub;
      subEl.style.cssText = 'font:10px Arial,sans-serif;color:#667799;';
      chip.appendChild(subEl);
    }
    return chip;
  }

  function mkGhost(label: string): HTMLElement {
    const g = document.createElement('div');
    g.textContent = label;
    g.style.cssText = [
      'position:fixed', 'z-index:2100', 'pointer-events:none',
      'background:#22224a', 'border:1.5px solid #6666cc', 'border-radius:6px',
      'padding:6px 10px', 'font:bold 12px Arial,sans-serif', 'color:#ffee88',
      'transform:translate(-50%,-140%)', 'max-width:140px', 'overflow:hidden',
      'text-overflow:ellipsis', 'white-space:nowrap', 'box-shadow:0 4px 16px rgba(0,0,0,0.6)',
    ].join(';');
    document.body.appendChild(g);
    return g;
  }

  function positionGhost(ghost: HTMLElement, x: number, y: number): void {
    ghost.style.left = `${x}px`;
    ghost.style.top  = `${y}px`;
  }

  function showLocalToast(msg: string): void {
    const t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = [
      'position:fixed', 'bottom:28px', 'left:50%', 'transform:translateX(-50%)',
      'background:rgba(20,20,48,0.96)', 'color:#e8e8ff', 'padding:10px 20px',
      'border-radius:8px', 'font:13px Arial,sans-serif', 'z-index:2200',
      'border:1px solid #3a3a6a', 'max-width:90vw', 'text-align:center',
    ].join(';');
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 2600);
  }
}
