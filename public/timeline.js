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

  // Render a timeline for `range`. Returns { el, refresh() }; refresh() redraws
  // from the store's current entries (for the live "now" and running block).
  // `header(days)` (optional) returns an element that sits with the legend in
  // a bar that stays at the top while the timeline scrolls. It is called on
  // every redraw with the days drawn. With `stack()` true (narrow screens),
  // several days are drawn one under another, each on its own hours, so
  // nothing needs scrolling sideways.
  function render({ store, range, onSelect, header, stack }) {
    const rootEl = el('div', 'tl');
    rootEl.setAttribute('role', 'group');
    const tip = el('div', 'tl-tip');
    tip.hidden = true;

    function draw() {
      const now = Date.now();
      const { days, axisFrom, axisTo, legend } = T.timelineDays(store.entries, range, now);
      rootEl.replaceChildren();
      rootEl.setAttribute('aria-label', `Timeline, ${range.label}. /log or /report shows the same entries as text.`);
      rootEl.classList.toggle('tl-one-day', days.length === 1 && range.to - range.from <= 90000000);
      const top = el('div', 'tl-top');
      if (header) top.append(header(days));
      rootEl.append(top);
      if (!days.length) {
        rootEl.append(el('div', 'tl-empty', `no entries (${range.label})`));
        return;
      }

      // Legend: identity is never color alone.
      const legendEl = el('div', 'tl-legend');
      for (const t of legend) {
        const item = el('span', 'tl-key');
        const sw = el('i', 'tl-swatch');
        sw.style.setProperty('--c', slotColor(t.slot));
        item.append(sw, el('span', null, t.category), el('span', 'tl-muted', ` ${T.formatHM(t.ms)}`));
        legendEl.append(item);
      }
      top.append(legendEl);

      if (days.length > 1 && stack && stack()) {
        for (const day of days) rootEl.append(drawGrid([day], day.axisFrom, day.axisTo, now, true));
      } else {
        rootEl.append(drawGrid(days, axisFrom, axisTo, now, false));
      }
      rootEl.append(tip);
    }

    // One grid: an hour axis and a column per day, from axisFrom to axisTo
    // (minutes from midnight).
    function drawGrid(days, axisFrom, axisTo, now, stacked) {
      const height = (axisTo - axisFrom) * MIN_PX;
      const scroll = el('div', `tl-scroll${stacked ? ' tl-stacked' : ''}`);
      const grid = el('div', 'tl-grid');
      grid.style.gridTemplateColumns = `3.2em repeat(${days.length}, minmax(${days.length > 1 ? '9.5em' : stacked ? '0' : '12em'}, 1fr))`;

      // Header row.
      grid.append(el('div', 'tl-head'));
      for (const day of days) {
        const head = el('div', 'tl-head');
        head.append(el('span', null, day.label), el('span', 'tl-muted', `  ${T.formatHM(day.totalMs)}`));
        grid.append(head);
      }

      // Hour axis.
      const axis = el('div', 'tl-axis');
      axis.style.height = `${height}px`;
      for (let m = axisFrom; m <= axisTo; m += 60) {
        const tick = el('span', 'tl-hour', `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:00`);
        tick.style.top = `${(m - axisFrom) * MIN_PX}px`;
        axis.append(tick);
      }
      grid.append(axis);

      for (const day of days) {
        const col = el('div', 'tl-day');
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
          block.setAttribute('aria-label', title);
          if (h >= 16) {
            const line1 = el('div', 'tl-line');
            if (b.off) {
              line1.append(el('span', 'tl-muted', 'off'));
            } else {
              if (b.wo) line1.append(el('span', 'tl-wo', T.woTag(b.wo)));
              line1.append(el('b', null, b.category));
              if (b.note) line1.append(el('span', null, ` ${b.note}`));
            }
            if (h < 34 && !b.off) line1.append(el('span', 'tl-muted tl-dur', ` ${T.formatHM(b.duration)}`));
            block.append(line1);
          }
          if (h >= 34 && !b.off) {
            const end = b.running ? 'now' : T.hhmm(b.start + b.duration);
            block.append(el('div', 'tl-line tl-muted', `${T.hhmm(b.start)}–${end} · ${T.formatHM(b.duration)}${b.notes ? '  ✎' : ''}`));
          }
          if (h >= 52 && b.notes) block.append(el('div', 'tl-line tl-notes', b.notes.split('\n')[0]));
          if (!b.off) {
            block.addEventListener('click', () => {
              hideTip();
              if (onSelect) onSelect(b, block);
            });
            block.addEventListener('pointerenter', (e) => showTip(e, title, b.notes));
            block.addEventListener('pointermove', moveTip);
            block.addEventListener('pointerleave', hideTip);
          }
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
