import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageKind, createLogOnce } from '../src/service.mjs';

test('messages of one kind have one kind, whatever address or number is in them', () => {
  assert.equal(messageKind('[Porch] ffmpeg exited early: [mp4 @ 0x563000b941c0] dimensions not set'), messageKind('[Porch] ffmpeg exited early: [mp4 @ 0x55a1ccf641c0] dimensions not set'));
  assert.equal(messageKind('no data for 21s, restarting'), messageKind('no data for 37s, restarting'));
  assert.notEqual(messageKind('dimensions not set'), messageKind('connection refused'));
  assert.equal(messageKind('connect to 10.0.0.5:554 failed'), 'connect to #.#.#.#:# failed');
});

function rig(o = {}) {
  const lines = []; let t = 1_000_000;
  const once = createLogOnce((m) => lines.push(m), { now: () => t, ...o });
  return { once, lines, tick: (ms) => { t += ms; } };
}

test('a message that differs only in an address is said once a minute, not every time', () => {
  const r = rig();
  for (let i = 0; i < 20; i++) { r.once('porch', `[Porch] ffmpeg exited early: [mp4 @ 0x5630${i.toString(16).padStart(8, '0')}] dimensions not set`); r.tick(2000); }
  assert.equal(r.lines.length, 1, '20 failures in 40 s, one line');
  r.tick(60_000);
  r.once('porch', '[Porch] ffmpeg exited early: [mp4 @ 0x1] dimensions not set');
  assert.equal(r.lines.length, 2, 'said again after the window');
});

test('different kinds of message, and different devices, are each said', () => {
  const r = rig();
  r.once('porch', '[Porch] dimensions not set'); r.once('porch', '[Porch] no data for 20s, restarting'); r.once('garage', '[Garage] dimensions not set');
  assert.equal(r.lines.length, 3);
  r.once('porch', '[Porch] dimensions not set'); r.once('garage', '[Garage] dimensions not set');
  assert.equal(r.lines.length, 3, 'repeats are held back');
});

test('what it remembers stays bounded even when every message is new', () => {
  const r = rig({ maxKinds: 50, windowMs: 60_000 });
  const word = (n) => { let s = ''; do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); } while (n > 0); return s; };   // letters only, so each is a distinct kind
  for (let i = 0; i < 5000; i++) { r.once('cam', `failed in way ${word(i)}`); r.tick(1000); }
  assert.equal(r.lines.length, 5000, 'each really was new, so each was said');
  assert.ok(r.once.size <= 50 + 60, `kept ${r.once.size}: only what is still inside the window, plus a little`);
});
