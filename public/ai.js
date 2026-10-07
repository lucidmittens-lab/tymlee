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
  const FIELDS = ['action', 'id', 'date', 'time', 'category', 'title', 'notes', 'wo', 'eq', 'kind', 'name', 'due'];
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
            title: { type: 'string', description: 'The words after the category on the entry\'s one line (or the to-do\'s text). Changing it renames the entry. "" to leave it.' },
            notes: { type: 'string', description: 'add_entry / edit_entry: lines to ADD under the entry as notes (tymlee keeps the ones already there). "" for none.' },
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
    'How tymlee works: each entry starts at a time and runs until the next one starts. "off" stops the clock; a break is paid or unpaid and also ends at the next entry.',
    '',
    'Glossary: the parts of an entry, and the fields that change them. Keep them apart.',
    '- category: the first word of the entry, e.g. ACME or NORTHSTAR. What the time is billed to.',
    '- title: the rest of the entry\'s one line, after the category, e.g. "drawings" in "ACME drawings". Short; says what the work was. Only change it when they ask to rename or retitle, or to fix what the entry says it was.',
    '- notes: extra lines kept under an entry ("> " lines in tymlee), e.g. "client asked for a recut of reel 2". When someone says note, add a note, jot down, remember that, or mention, it goes in notes, never in title. Notes are added, never replaced.',
    '- wo: a work order number on the entry. eq: equipment on it. Either can also be linked to a category for a day (link_wo / link_eq), which gives every entry in that category that day the work order or equipment.',
    '- to-do: a task for later (add_todo), not an entry.',
    '',
    'Actions:',
    '- add_entry: date, time, category, title (and notes, wo, eq if given).',
    '- edit_entry: id of an existing entry; fill only the fields that change (time, category, title, wo, eq) or notes to add; leave the rest "". "Add a note to my current entry" is edit_entry with only notes filled.',
    '- delete_entry: id.',
    '- break: date, time, kind ("paid" unless they say unpaid or lunch).',
    '- off: date, time.',
    '- link_wo / link_eq: date, category, wo / eq. Use these for work orders from a schedule.',
    '- add_todo: category, title, due ("" if none).',
    '- add_name: category, name. When a schedule or the person uses a full name (e.g. "Northstar Pictures") that you matched to a category (NORTHSTAR), suggest it so it is known next time. Never repeat a name already listed.',
    '',
    'Attachments: the person may attach files (schedules, emails, spreadsheets, notes, photos). Read them for what the request asks; if they asked for nothing in particular, use them as below.',
    'Handwritten notes and photos of lists: read them as written. When asked for to-dos, each line or bullet is one add_todo. Skip items that are ticked, checked or crossed out (they are done). Do not guess at a word you cannot read: leave that item out and quote what you could read in the message. Pick each to-do\'s category from what it mentions, as for entries; a date written next to an item is its due day.',
    'Schedules: an attached schedule (e.g. an operator schedule) lists bookings like "WO#4410027 - Northstar Pictures LLC Project: Northstar Final Mix" with a date, start, end, status (Confirmed, Second Hold, ...) and room. Bookings are plans, often overlapping, not time worked, so unless asked otherwise:',
    '- Link each booking\'s work order to its category for that date (link_wo). The work order is the digits after "WO#" (4410027).',
    '- Match the category by the project name first, then the client, using the categories and full names listed below.',
    '- Do not add entries for bookings unless asked.',
    '- Include holds (e.g. "Second Hold") but name them in the message, since they may not happen.',
    '- tymlee links one work order per category per day. If two bookings fall on the same category and day, link the first and name the other in the message.',
    '- When no category fits, make one in the style of the existing ones: upper case, one word, from the project\'s main title; initials for a title of three or more words ("The Long Way Home" -> TLWH, "Out of Bounds" -> OOB), the words run together for shorter ones ("Blue Harbor" -> BLUEHARBOR, "Mo-Jo" -> MOJO, "Northstar" -> NORTHSTAR). Say in the message which categories are new.',
    '- For every booking you matched or made, suggest add_name with the project title as written (e.g. "Blue Harbor") unless it is listed already.',
    '',
    'Rules:',
    '- Use existing categories and their full names to match. Only invent a category when nothing fits, and say so in the message.',
    '- Times are 24-hour HH:MM. "Lunch" is an unpaid break. "Until 3" means the next thing (or off) starts at 15:00.',
    '- There are no end times: something ends when the next thing starts. Never add or move anything to a time later than now (given at the top); tymlee refuses it.',
    '- An interruption to what is running now: add the interruption at its start time. If it has already ended, also add an entry that resumes what was running (same category and title) at the time it ended. If it is still going, add only the interruption.',
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
    lines.push('', 'Recent entries (ID, date, start-end, category and title, then any notes as "> " lines):');
    if (!spans.length) lines.push('  (none)');
    for (const s of spans) {
      const end = s.running ? 'now' : T.clockAs('24', s.end);
      const tags = `${s.wo ? ` wo:${s.wo}` : ''}${s.eq ? ` eq:${s.eq}` : ''}`;
      lines.push(`  ${s.n}  ${T.ymd(s.ts)} ${T.clockAs('24', s.ts)}-${end}  ${s.category}${s.note ? ` ${s.note}` : ''}${tags}`);
      // Enough of the notes to know they're there, not all of them.
      const notes = String(s.notes || '').split('\n').filter(Boolean);
      for (const l of notes.slice(0, 3)) lines.push(`        > ${l.length > 120 ? `${l.slice(0, 120)}…` : l}`);
      if (notes.length > 3) lines.push(`        > (${notes.length - 3} more)`);
    }
    if (todos && todos.length) {
      lines.push('', 'Open to-dos:');
      for (const t of todos) lines.push(`  ${t.tag}  ${t.text}${t.due ? ` (due ${t.due})` : ''}`);
    }
    return lines.join('\n');
  }

  // ---- attachments ---------------------------------------------------------
  // Claude reads PDFs, images and text directly. Word, Excel and PowerPoint
  // files are zips of XML: their text is pulled out here. Anything else is
  // refused with a reason.
  const IMAGE_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
  const TEXT_EXT = ['txt', 'text', 'csv', 'tsv', 'md', 'markdown', 'json', 'xml', 'html', 'htm', 'ics', 'eml', 'log', 'rtf', 'yaml', 'yml', 'ini', 'srt', 'vtt', 'edl', 'ale'];
  const OFFICE_EXT = ['docx', 'xlsx', 'pptx'];
  const MAX_BYTES = { pdf: 20 * 1024 * 1024, image: 5 * 1024 * 1024, text: 2 * 1024 * 1024, office: 20 * 1024 * 1024 };
  const MAX_FILES = 5;

  const extOf = (name) => (String(name).match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || '';
  const kindOf = (name, type) => {
    const ext = extOf(name);
    if (ext === 'pdf' || type === 'application/pdf') return 'pdf';
    if (IMAGE_TYPES[ext] || /^image\/(jpeg|png|gif|webp)$/.test(type || '')) return 'image';
    if (OFFICE_EXT.includes(ext)) return 'office';
    if (TEXT_EXT.includes(ext) || /^text\//.test(type || '') || /json|xml|calendar/.test(type || '')) return 'text';
    return '';
  };

  // Plain text out of an XML string: paragraph and row ends become line
  // breaks; tags go; entities are decoded.
  function xmlText(xml, { para = /<\/(w:p|a:p)>/g, tab = /<w:tab\/>/g } = {}) {
    return xml.replace(para, '\n').replace(tab, '\t').replace(/<[^>]+>/g, '')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  // The files inside a zip: { name -> bytes }, for names matching `want`.
  // inflateRaw(bytes) -> Promise<Uint8Array> (each place has its own).
  async function unzip(bytes, want, inflateRaw) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (v.getUint32(i, true) === 0x06054b50) { end = i; break; }
    }
    if (end < 0) throw new Error('not a valid file');
    const count = v.getUint16(end + 10, true);
    let p = v.getUint32(end + 16, true);
    const out = {};
    const dec = new TextDecoder();
    for (let n = 0; n < count && v.getUint32(p, true) === 0x02014b50; n++) {
      const method = v.getUint16(p + 10, true);
      const size = v.getUint32(p + 20, true);
      const nameLen = v.getUint16(p + 28, true);
      const skip = nameLen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
      const local = v.getUint32(p + 42, true);
      const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + skip;
      if (!want.test(name)) continue;
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const raw = bytes.subarray(start, start + size);
      if (method === 0) out[name] = raw;
      else if (method === 8) out[name] = await inflateRaw(raw);
    }
    return out;
  }

  const byNumber = (a, b) => (+(a.match(/(\d+)\.xml$/) || [0, 0])[1]) - (+(b.match(/(\d+)\.xml$/) || [0, 0])[1]);

  // Text out of a Word, Excel or PowerPoint file.
  async function officeText(bytes, ext, inflateRaw) {
    const dec = new TextDecoder();
    if (ext === 'docx') {
      const f = await unzip(bytes, /^word\/document\.xml$/, inflateRaw);
      return xmlText(dec.decode(f['word/document.xml'] || new Uint8Array()));
    }
    if (ext === 'pptx') {
      const f = await unzip(bytes, /^ppt\/slides\/slide\d+\.xml$/, inflateRaw);
      return Object.keys(f).sort(byNumber).map((k, i) => `Slide ${i + 1}\n${xmlText(dec.decode(f[k]))}`).join('\n\n');
    }
    // xlsx: each sheet as rows of tab-separated cells.
    const f = await unzip(bytes, /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/, inflateRaw);
    const shared = [];
    const ss = f['xl/sharedStrings.xml'] ? dec.decode(f['xl/sharedStrings.xml']) : '';
    for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlText(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
    const sheets = Object.keys(f).filter((k) => k.includes('worksheets/')).sort(byNumber);
    return sheets.map((k, i) => {
      const xml = dec.decode(f[k]);
      const rows = [];
      for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        const cells = [];
        for (const c of r[1].matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1] || '';
          const body = c[2] || '';
          const v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          let val = '';
          if (/t="s"/.test(attrs) && v != null) val = shared[+v] || '';
          else if (/t="inlineStr"/.test(attrs)) val = xmlText(body);
          else if (v != null) val = xmlText(v);
          cells.push(val);
        }
        if (cells.some(Boolean)) rows.push(cells.join('\t'));
      }
      return `Sheet ${i + 1}\n${rows.join('\n')}`;
    }).join('\n\n');
  }

  // A file -> what to send: { name, kind, media_type, data (base64) | text },
  // or { name, error }. `tools`: { toBase64(bytes), inflateRaw(bytes) }.
  // '' if a file ({ name, type, size }) can be sent, else why not.
  function checkFile({ name, type, size }) {
    const kind = kindOf(name, type);
    if (!kind) return `${name}: tymlee can't read this kind of file (PDFs, images, text, Word, Excel and PowerPoint work)`;
    if (size > MAX_BYTES[kind]) return `${name} is too large (${Math.round(MAX_BYTES[kind] / 1048576)} MB at most for this kind)`;
    return '';
  }

  async function readAttachment({ name, type, bytes }, tools) {
    const kind = kindOf(name, type);
    const why = checkFile({ name, type, size: bytes.length });
    if (why) return { name, error: why };
    if (kind === 'pdf') return { name, kind, media_type: 'application/pdf', data: tools.toBase64(bytes) };
    if (kind === 'image') return { name, kind, media_type: IMAGE_TYPES[extOf(name)] || type, data: tools.toBase64(bytes) };
    if (kind === 'text') return { name, kind, text: new TextDecoder().decode(bytes) };
    try {
      const text = await officeText(bytes, extOf(name), tools.inflateRaw);
      if (!text.trim()) return { name, error: `${name} has no text in it` };
      return { name, kind: 'text', text };
    } catch (_) {
      return { name, error: `couldn't read ${name}` };
    }
  }

  // A file to send, as a content block.
  function fileBlock(f) {
    if (f.kind === 'pdf') return { type: 'document', title: f.name, source: { type: 'base64', media_type: 'application/pdf', data: f.data } };
    if (f.kind === 'image') return { type: 'image', source: { type: 'base64', media_type: f.media_type, data: f.data } };
    return { type: 'document', title: f.name, source: { type: 'text', media_type: 'text/plain', data: f.text } };
  }

  // The request for the Messages API. `files` from readAttachment.
  function buildRequest({ model, context, text, files = [] }) {
    const m = MODELS[model] || MODELS[DEFAULT_MODEL];
    const content = files.flatMap((f) => (f.kind === 'image' ? [fileBlock(f), { type: 'text', text: `(The image above is ${f.name}.)` }] : [fileBlock(f)]));
    content.push({ type: 'text', text: `${context}\n\nRequest: ${text || (files.length ? 'Link the work orders in the attached schedule to my categories.' : '')}` });
    const req = {
      model: m.id,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content }],
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    };
    // Thinking depth: a sentence needs little; a schedule a bit more.
    if (m.effort) req.output_config.effort = files.length ? 'medium' : 'low';
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

  const api = { MODELS, DEFAULT_MODEL, ACTIONS, SCHEMA, SYSTEM, MAX_FILES, kindOf, checkFile, readAttachment, officeText, contextText, buildRequest, readReply, send };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TymleeAi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
