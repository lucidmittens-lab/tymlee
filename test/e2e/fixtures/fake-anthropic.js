// A stand-in for api.anthropic.com for the terminal test: answers /v1/messages
// with a fixed set of changes and remembers the last request in a file.
const http = require('node:http');
const fs = require('node:fs');
const out = process.argv[2];
const blank = { id: '', date: '', time: '', category: '', title: '', notes: '', wo: '', eq: '', kind: '', name: '', due: '' };
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    fs.writeFileSync(out, JSON.stringify({ url: req.url, headers: req.headers, body: JSON.parse(body || '{}') }));
    const changes = [{ ...blank, action: 'add_entry', time: '09:00', category: 'NORTHSTAR', title: 'mix revisions' }, { ...blank, action: 'link_wo', category: 'NORTHSTAR', wo: '4471' }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ message: 'Added the morning.', changes }) }], usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}).listen(8199, () => console.log('fake anthropic on 8199'));
