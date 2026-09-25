// /timeline on the website: your time as blocks on a vertical timeline, one
// column per day on a shared hour axis. Data comes from Tymlee.timelineDays
// (core.js); colors are the categorical slots in style.css (--s1 … --s8).
(function (root) {
  'use strict';

  const T = root.Tymlee;
  const MIN_PX = 1.2; // pixels per minute (72px per hour: 15 minutes fits a line of text)

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const minutesOfDay = (ts, dayStart) => (ts - dayStart) / 60000;
  const slotColor = (slot) => (slot == null ? 'var(--muted)' : slot < 0 ? 'var(--s-other)' : `var(--s${slot + 1})`);

  function blockTitle(b) {
    if (b.off) return `off ${T.hhmm(b.start)}–${T.hhmm(b.end)} (${T.formatHM(b.end - b.start)})`;
    const end = b.running ? 'now' : T.hhmm(b.start + b.duration);
    return `#${b.n} ${b.wo ? `${T.woTag(b.wo)} ` : ''}${b.category}${b.note ? ` ${b.note}` : ''} · ${T.hhmm(b.start)}–${end} · ${T.formatHM(b.duration)}`;
  }

  const DAY_MS = 86400000;
  const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  // Every day of a (finite) range, with the days that have entries filled in.
  function allDays(range, days) {
    if (!Number.isFinite(range.from) || !Number.isFinite(range.to)) return days;
    const byKey = new Map(days.map((d) => [d.key, d]));
    const list = [];
    for (let d = range.from; d < range.to; d = T.addDays(d, 1)) {
      const key = T.ymd(d);
      list.push(byKey.get(key) || { key, start: d, blocks: [], totalMs: 0 });
    }
    return list;
  }

  // Render a timeline for `range`. Returns { el, refresh() }; refresh() redraws
  // from the store's current entries (for the live "now" and running block).
  //   mode      'day', 'week' (days side by side, always fitting the width)
  //             or 'month' (a calendar: a week per row, a small timeline per
  //             day)
  //   header(days)  an element for the bar that stays at the top while the
  //             timeline scrolls; called on every redraw with the days drawn
  //   onSelect(b, el)  a block was clicked
  //   onDay(key)       a calendar day was clicked
  function render({ store, range, mode = 'day', onSelect, onDay, header }) {
    const rootEl = el('div', `tl tl-mode-${mode}`);
    rootEl.setAttribute('role', 'group');
    const tip = el('div', 'tl-tip');
    tip.hidden = true;

    function draw() {
      const now = Date.now();
      const { days, axisFrom, axisTo, legend } = T.timelineDays(store.entries, range, now);
      rootEl.replaceChildren();
      rootEl.setAttribute('aria-label', `Timeline, ${range.label}. /log or /report shows the same entries as text.`);
      rootEl.classList.toggle('tl-one-day', mode === 'day' && days.length === 1);
      const top = el('div', 'tl-top');
      if (header) top.append(header(days));
      rootEl.append(top);
      if (!days.length) {
        rootEl.append(el('div', 'tl-empty', `no entries (${range.label})`));
        return;
      }

      // Legend: identity is never color alone (phones leave it out for room;
      // tapping a block shows what it is).
      const legendEl = el('div', 'tl-legend');
      for (const t of legend) {
        const item = el('span', 'tl-key');
        const sw = el('i', 'tl-swatch');
        sw.style.setProperty('--c', slotColor(t.slot));
        item.append(sw, el('span', null, t.category), el('span', 'tl-muted', ` ${T.formatHM(t.ms)}`));
        legendEl.append(item);
      }
      top.append(legendEl);

      if (mode === 'month') rootEl.append(drawCalendar(days, axisFrom, axisTo, now));
      else rootEl.append(drawGrid(mode === 'week' ? allDays(range, days) : days, axisFrom, axisTo, now, top));
      rootEl.append(tip);
    }

    function wireBlock(block, b, title) {
      block.setAttribute('aria-label', title);
      block.addEventListener('click', (e) => {
        e.stopPropagation();
        hideTip();
        if (onSelect) onSelect(b, block);
      });
      block.addEventListener('pointerenter', (e) => showTip(e, title, b.notes));
      block.addEventListener('pointermove', moveTip);
      block.addEventListener('pointerleave', hideTip);
    }

    // An hour axis and a column per day, from axisFrom to axisTo (minutes
    // from midnight). Columns share the width, however narrow that gets.
    // Several days: their names go in the bar on top (`top`), so they stay
    // in view while the hours scroll.
    function drawGrid(days, axisFrom, axisTo, now, top) {
      const height = (axisTo - axisFrom) * MIN_PX;
      const scroll = el('div', 'tl-scroll');
      const grid = el('div', 'tl-grid');
      const columns = `var(--axis, 3.2em) repeat(${days.length}, minmax(0, 1fr))`;
      grid.style.gridTemplateColumns = columns;
      let heads = grid;
      if (days.length > 1) {
        heads = el('div', 'tl-grid tl-heads');
        heads.style.gridTemplateColumns = columns;
        top.append(heads);
      }

      // Header row.
      heads.append(el('div', 'tl-head'));
      for (const day of days) {
        const head = el('div', `tl-head${T.ymd(now) === day.key ? ' tl-today' : ''}`);
        const d = new Date(day.start);
        const name = mode === 'week' ? `${WEEKDAYS[(d.getDay() + 6) % 7]} ${d.getDate()}` : `${WEEKDAYS[(d.getDay() + 6) % 7]} ${day.key}`;
        head.append(el('span', 'tl-head-name', name), el('span', 'tl-muted tl-head-total', day.totalMs ? T.formatHM(day.totalMs) : ''));
        heads.append(head);
      }

      // Hour axis.
      const axis = el('div', 'tl-axis');
      axis.style.height = `${height}px`;
      for (let m = axisFrom; m <= axisTo; m += 60) {
        const tick = el('span', 'tl-hour');
        tick.append(String(Math.floor(m / 60) % 24).padStart(2, '0'), el('span', 'tl-min', ':00'));
        tick.style.top = `${(m - axisFrom) * MIN_PX}px`;
        axis.append(tick);
      }
      grid.append(axis);

      for (const day of days) {
        const col = el('div', `tl-day${day.start > now ? ' tl-future' : ''}`);
        col.style.height = `${height}px`;
        col.style.setProperty('--hour', `${60 * MIN_PX}px`);
        col.style.setProperty('--offset', `${(60 - (axisFrom % 60)) % 60 * MIN_PX}px`);
        for (const b of day.blocks) {
          const top = (minutesOfDay(b.start, day.start) - axisFrom) * MIN_PX;
          const full = (b.end - b.start) / 60000 * MIN_PX;
          const h = Math.max(2, full - 2); // 2px gap between blocks
          const block = el('div', `tl-block${b.off ? ' tl-offblock' : ''}${b.running ? ' tl-running' : ''}${b.clipped ? ' tl-clipped' : ''}`);
          block.style.top = `${top + 1}px`;
          block.style.height = `${h}px`;
          block.style.setProperty('--c', slotColor(b.slot));
          const title = blockTitle(b);
          if (h >= 16) {
            const line1 = el('div', 'tl-line');
            if (b.off) {
              line1.append(el('span', 'tl-muted', 'off'));
            } else {
              if (b.wo) line1.append(el('span', 'tl-wo', T.woTag(b.wo)));
              line1.append(el('b', null, b.category));
              if (b.note) line1.append(el('span', 'tl-note', ` ${b.note}`));
            }
            if (h < 34 && !b.off) line1.append(el('span', 'tl-muted tl-dur', ` ${T.formatHM(b.duration)}`));
            block.append(line1);
          }
          if (h >= 34 && !b.off) {
            const end = b.running ? 'now' : T.hhmm(b.start + b.duration);
            block.append(el('div', 'tl-line tl-muted tl-times', `${T.hhmm(b.start)}–${end} · ${T.formatHM(b.duration)}${b.notes ? '  ✎' : ''}`));
          }
          // Notes: as many lines as the block has room for.
          if (h >= 52 && b.notes) {
            const room = Math.floor((h - 34) / 16);
            const lines = b.notes.split('\n');
            for (const line of lines.slice(0, room)) block.append(el('div', 'tl-line tl-notes', line || ' '));
            if (lines.length > room && room > 0) block.lastChild.textContent += ' …';
          }
          if (b.off) block.setAttribute('aria-label', title);
          else wireBlock(block, b, title);
          col.append(block);
        }
        // "now" across today's column.
        if (T.ymd(now) === day.key) {
          const m = minutesOfDay(now, day.start);
          if (m >= axisFrom && m <= axisTo) {
            const line = el('div', 'tl-now');
            line.style.top = `${(m - axisFrom) * MIN_PX}px`;
            line.append(el('span', null, T.hhmm(now)));
            col.append(line);
          }
        }
        grid.append(col);
      }
      scroll.append(grid);
      return scroll;
    }

    // A month as a calendar: a row per week (Monday first), each day a small
    // timeline on the month's shared hours, top to bottom.
    function drawCalendar(days, axisFrom, axisTo, now) {
      const byKey = new Map(days.map((d) => [d.key, d]));
      const first = Number.isFinite(range.from) ? range.from : days[0].start;
      const last = Number.isFinite(range.to) ? T.addDays(range.to, -1) : days[days.length - 1].start;
      let start = first;
      while (new Date(start).getDay() !== 1) start = T.addDays(start, -1);
      const span = Math.max(60, axisTo - axisFrom);
      const hh = (m) => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:00`;

      const wrap = el('div', 'tl-cal');
      wrap.append(el('div', 'tl-cal-hours tl-muted', `each day ${hh(axisFrom)}–${hh(axisTo)}, top to bottom`));
      const grid = el('div', 'tl-cal-grid');
      for (const w of WEEKDAYS) {
        const head = el('div', 'tl-cal-wd');
        head.append(el('span', 'tl-long', w), el('span', 'tl-short', w[0]));
        grid.append(head);
      }
      const todayKey = T.ymd(now);
      for (let d = start; ; d = T.addDays(d, 1)) {
        const key = T.ymd(d);
        const inRange = d >= first && d <= last;
        const day = inRange ? byKey.get(key) : null;
        const cell = el('div', `tl-cell${inRange ? '' : ' tl-out'}${key === todayKey ? ' tl-today' : ''}${d > now ? ' tl-future' : ''}`);
        const head = el('button', 'tl-date');
        head.type = 'button';
        head.append(el('span', 'tl-date-n', String(new Date(d).getDate())));
        if (day && day.totalMs) head.append(el('span', 'tl-muted tl-date-total', T.formatHM(day.totalMs)));
        head.setAttribute('aria-label', `${key}${day ? `, ${T.formatHM(day.totalMs)}` : ''}: open this day`);
        if (inRange && onDay) head.addEventListener('click', () => onDay(key));
        else head.disabled = true;
        const mini = el('div', 'tl-mini');
        if (day) {
          for (const b of day.blocks) {
            if (b.off) continue;
            const block = el('div', `tl-mblock${b.running ? ' tl-running' : ''}`);
            block.style.top = `calc(${((minutesOfDay(b.start, day.start) - axisFrom) / span) * 100}% + 1px)`;
            block.style.height = `calc(${((b.end - b.start) / 60000 / span) * 100}% - 2px)`; // a 2px gap between blocks
            block.style.setProperty('--c', slotColor(b.slot));
            wireBlock(block, b, blockTitle(b));
            mini.append(block);
          }
          if (key === todayKey) {
            const m = minutesOfDay(now, day.start);
            if (m >= axisFrom && m <= axisTo) {
              const line = el('div', 'tl-mnow');
              line.style.top = `${((m - axisFrom) / span) * 100}%`;
              mini.append(line);
            }
          }
        }
        cell.append(head, mini);
        grid.append(cell);
        if (d >= last && new Date(d).getDay() === 0) break;
      }
      wrap.append(grid);
      return wrap;
    }

    function showTip(e, title, notes) {
      if (e.pointerType === 'touch') return; // a tap opens the edit card instead
      tip.replaceChildren(el('div', null, title), ...(notes ? notes.split('\n').map((l) => el('div', 'tl-muted', `> ${l}`)) : []));
      tip.hidden = false;
      moveTip(e);
    }

    function moveTip(e) {
      if (tip.hidden) return;
      const box = rootEl.getBoundingClientRect();
      const x = Math.min(e.clientX - box.left + 12, box.width - tip.offsetWidth - 4);
      tip.style.left = `${Math.max(4, x)}px`;
      tip.style.top = `${e.clientY - box.top + 14}px`;
    }

    function hideTip() {
      tip.hidden = true;
    }

    draw();
    return { el: rootEl, refresh: draw, live: () => range.to > Date.now() };
  }

  root.TymleeTimeline = { render };
})(typeof globalThis !== 'undefined' ? globalThis : this);
