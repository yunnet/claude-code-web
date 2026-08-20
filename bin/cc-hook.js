#!/usr/bin/env node
'use strict';

// Claude Code hook relay. Claude invokes this (registered via claude-bridge's
// injected --settings) at a hook point — e.g. PreToolUse for ExitPlanMode — with
// the event JSON on stdin. We POST that JSON to the local cc-web server, which
// forwards it over WebSocket to the browser. It is strictly best-effort: any
// failure or missing stdin exits 0 with no stdout so a hook never blocks or
// alters Claude's own flow (empty stdout + exit 0 = "no decision, proceed").

const http = require('http');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const port = arg('--port');
const session = arg('--session');
const token = arg('--token');

let body = '';
let finished = false;

function done() {
  if (finished) return;
  finished = true;
  try { clearTimeout(timer); } catch (_) {}
  process.exit(0);
}

// Never hang: if Claude sends no stdin (or a slow pipe), bail after a moment.
const timer = setTimeout(done, 4000);

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  body += chunk;
  // Cap the relayed payload so a pathological plan can't buffer unbounded.
  if (body.length > 2 * 1024 * 1024) send();
});
process.stdin.on('end', send);
process.stdin.on('error', done);

function send() {
  if (finished) return;
  if (!port || !session || !token || !body) return done();

  const data = Buffer.from(body);
  const req = http.request({
    host: '127.0.0.1',
    port: Number(port),
    path: `/api/hooks/${encodeURIComponent(session)}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      'Authorization': `Bearer ${token}`
    }
  }, (res) => { res.resume(); res.on('end', done); });

  req.on('error', done);
  req.setTimeout(3000, done);
  req.write(data);
  req.end();
}
