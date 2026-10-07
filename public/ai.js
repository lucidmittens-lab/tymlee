// /ai: plain language in, tymlee changes out. Each person uses their own
// Claude API key (/aikey), kept with their encrypted settings; requests go
// straight from their device to Anthropic. Claude only sees what a request
// needs (categories, their full names, recent entries, open to-dos, the
// words typed and any PDF given) and answers in a fixed JSON shape, which
// tymlee checks, shows as a preview and applies only when confirmed.
//
// Shared by the website and the terminal app; each passes in a way to make
// an Anthropic SDK client (the browser loads vendor/anthropic.js).
(function (root) {
  'use strict';

  const MODELS = {
    opus: { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', fallbacks: true, effort: true },
    sonnet: { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', fallbacks: true, effort: true },
    haiku: { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', fallbacks: false, effort: false },
  };
  const DEFAULT_MODEL = 'opus';

  const ACTIONS = ['add_entry', 'edit_entry', 'delete_entry', 'break', 'off', 'link_wo', 'link_eq', 'add_todo', 'add_name'];

  // Every change has every field ("" when it doesn't apply), which keeps the
  // schema flat and the answer easy to check.
  const FIELDS = ['action', 'id', 'date', 'time', 'category', 'note', 'wo', 'eq', 'kind', 'name', 'due'];
  const SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['message', 'changes'],
    properties: {
      message: { type: 'string', description: 'One or two short sentences for the person: what you did, or a question if the request is unclear.' },
      changes: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: FIELDS,
          properties: {
            action: { type: 'string', enum: ACTIONS },
            id: { type: 'string', description: 'edit_entry / delete_entry: the entry ID as listed, e.g. 000040. Otherwise "".' },
            date: { type: 'string', description: 'YYYY-MM-DD, or "" for today.' },
            time: { type: 'string', description: 'HH:MM on the 24-hour clock, or "".' },
            category: { type: 'string', description: 'One word, no spaces. Use an existing category when one fits.' },
            note: { type: 'string', description: 'What the entry or to-do is about, without the category.' },
            wo: { type: 'string', description: 'Work order number, or "".' },
            eq: { type: 'string', description: 'Equipment, comma-separated, or "".' },
            kind: { type: 'string', description: 'break: "paid" or "unpaid". Otherwise "".' },
            name: { type: 'string', description: 'add_name: a full name (as on a schedule) that means this category.' },
            due: { type: 'string', description: 'add_todo: YYYY-MM-DD, or "".' },
          },
        },
      },
    },
  };

  const SYSTEM = [
    'You turn what someone writes (and any schedule they attach) into changes to their time log in tymlee.',
    '',
    'How tymlee works: each entry starts at a time and runs until the next one starts. An entry is a category (one word, e.g. ACME or dev) and an optional note. "off" stops the clock; a break is paid or unpaid and also ends at the next entry. Work orders (wo) and equipment (eq) can be on an entry, or linked to a category for a day (link_wo / link_eq), which gives every entry in that category that day the work order.',
    '',
    'Actions:',
    '- add_entry: date, time, category, note (and wo / eq if given).',
    '- edit_entry: id of an existing entry; fill only the fields that change (time, category, note, wo, eq); leave the rest "".',
    '- delete_entry: id.',
    '- break: date, time, kind ("paid" unless they say unpaid or lunch).',
    '- off: date, time.',
    '- link_wo / link_eq: date, category, wo / eq. Use these for work orders from a schedule.',
    '- add_todo: category, note, due ("" if none).',
    '- add_name: category, name. When a schedule or the person uses a full name (e.g. "Silent Partner Productions") that you matched to a category (SILENTPARTNER), suggest it so it is known next time. Never repeat a name already listed.',
    '',
    'Schedules: an attached schedule (e.g. an operator schedule) lists bookings like "WO#1033587 - Silent Partner Film LLC Project: Silent Partner Editorial Conform" with a date, start, end, status (Confirmed, Second Hold, ...) and room. Bookings are plans, often overlapping, not time worked, so unless asked otherwise:',
    '- Link each booking\'s work order to its category for that date (link_wo). The work order is the digits after "WO#" (1033587).',
    '- Match the category by the project name first, then the client, using the categories and full names listed below.',
    '- Do not add entries for bookings unless asked.',
    '- Include holds (e.g. "Second Hold") but name them in the message, since they may not happen.',
    '- tymlee links one work order per category per day. If two bookings fall on the same category and day, link the first and name the other in the message.',
    '- When no category fits, make one in the style of the existing ones: upper case, one word, from the project\'s main title; initials for a title of three or more words ("Line of Fire" -> LOF, "Here Comes the Flood" -> HCTF), the words run together for shorter ones ("Ha-Chan" -> HACHAN, "IX XI" -> IXXI, "Silent Partner" -> SILENTPARTNER). Say in the message which categories are new.',
    '- For every booking you matched or made, suggest add_name with the project title as written (e.g. "Silent Partner") unless it is listed already.',
    '',
    'Rules:',
    '- Use existing categories and their full names to match. Only invent a category when nothing fits, and say so in the message.',
    '- Times are 24-hour HH:MM. "Lunch" is an unpaid break. "Until 3" means the next thing (or off) starts at 15:00.',
    '- There are no end times: something ends when the next thing starts. Never add or move anything to a time later than now (given at the top); tymlee refuses it.',
    '- An interruption to what is running now: add the interruption at its start time. If it has already ended, also add an entry that resumes what was running (same category and note) at the time it ended. If it is still going, add only the interruption.',
    '- Only edit or delete entries listed below, by their ID. Never invent IDs.',
    '- If the request is unclear, return no changes and ask one short question in the message.',
    '- Keep the message short. Do not list the changes in it; tymlee shows them.',
  ].join('\n');

  // What Claude is told about the log: the date and time, categories with
  // their full names, recent entries, open to-dos.
  function contextText({ T, now, entries, names, todos }) {
    const lines = [];
    const d = new Date(now);
    lines.push(`Now: ${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][d.getDay()]} ${T.ymd(now)} ${T.clockAs('24', now)}`);
    const cats = T.knownCategories(entries);
    lines.push('', 'Categories (and the full names that mean them):');
    if (!cats.length) lines.push('  (none yet)');
    for (const c of cats) {
      const full = (names && names[c]) || [];
      lines.push(`  ${c}${full.length ? ` = ${full.join(' | ')}` : ''}`);
    }
    for (const [c, full] of Object.entries(names || {})) {
      if (!cats.includes(c) && full.length) lines.push(`  ${c} = ${full.join(' | ')}`);
    }
    // The last three days of entries, with IDs to edit by.
    const since = T.addDays(T.startOfDay(now), -2);
    const spans = T.withSpans(entries, now).filter((s) => s.ts >= since);
    lines.push('', 'Recent entries (ID, date, start-end, what):');
    if (!spans.length) lines.push('  (none)');
    for (const s of spans) {
      const end = s.running ? 'now' : T.clockAs('24', s.end);
      const tags = `${s.wo ? ` wo:${s.wo}` : ''}${s.eq ? ` eq:${s.eq}` : ''}`;
      lines.push(`  ${s.n}  ${T.ymd(s.ts)} ${T.clockAs('24', s.ts)}-${end}  ${s.category}${s.note ? ` ${s.note}` : ''}${tags}`);
    }
    if (todos && todos.length) {
      lines.push('', 'Open to-dos:');
      for (const t of todos) lines.push(`  ${t.tag}  ${t.text}${t.due ? ` (due ${t.due})` : ''}`);
    }
    return lines.join('\n');
  }

  // The request for the Messages API. `pdf` is base64 (or null).
  function buildRequest({ model, context, text, pdf }) {
    const m = MODELS[model] || MODELS[DEFAULT_MODEL];
    const content = [];
    if (pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } });
    content.push({ type: 'text', text: `${context}\n\nRequest: ${text || 'Link the work orders in the attached schedule to my categories.'}` });
    const req = {
      model: m.id,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    };
    // Thinking depth: a sentence needs little; a schedule a bit more.
    if (m.effort) req.output_config.effort = pdf ? 'medium' : 'low';
    // If the model declines, the API tries another one in the same call.
    if (m.fallbacks) {
      req.betas = ['server-side-fallback-2026-07-01'];
      req.fallbacks = 'default';
    }
    return req;
  }

  // The reply -> { message, changes } or { error }.
  function readReply(res) {
    if (!res || !Array.isArray(res.content)) return { error: 'no reply from Claude' };
    if (res.stop_reason === 'refusal') return { error: 'Claude declined this request' };
    if (res.stop_reason === 'max_tokens') return { error: 'the reply was cut off; try a shorter request' };
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    let out;
    try {
      out = JSON.parse(text);
    } catch (_) {
      return { error: 'Claude answered in an unexpected form; try again' };
    }
    const changes = (Array.isArray(out.changes) ? out.changes : [])
      .filter((c) => c && ACTIONS.includes(c.action))
      .map((c) => Object.fromEntries(FIELDS.map((f) => [f, String(c[f] == null ? '' : c[f]).trim()])));
    return { message: String(out.message || '').trim(), changes };
  }

  // How the API is called: the beta endpoint when fallbacks are on.
  async function send(client, req) {
    const { betas, ...body } = req;
    return betas ? client.beta.messages.create({ ...body, betas }) : client.messages.create(body);
  }

  const api = { MODELS, DEFAULT_MODEL, ACTIONS, SCHEMA, SYSTEM, contextText, buildRequest, readReply, send };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TymleeAi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
