import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { train, predict, leaveOneOut, summarise, suggestThreshold, vectorOf, Classifiers, saveModel } from '../src/detect/classifier.mjs';
import { trainRule, MIN_EACH } from '../src/detect/training.mjs';
import { EventLog } from '../src/detect/events.mjs';
import { DetectionService } from '../src/detect/service.mjs';
import { normalizeDetection } from '../src/detect/config.mjs';

// a tiny deterministic "picture": Yes ones are bright in the first features, No ones in the last, plus noise
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296 - 0.5; };
const sample = (yes, d = 40) => Array.from({ length: d }, (_, j) => (yes ? (j < d / 2 ? 2 : 0) : (j < d / 2 ? 0 : 2)) + rnd());
const data = (n) => { const X = [], y = []; for (let i = 0; i < n; i++) { const yes = i % 2 === 0; X.push(sample(yes)); y.push(yes ? 1 : 0); } return { X, y }; };

test('a model trained on marks separates the two kinds and scores something new sensibly', () => {
  const { X, y } = data(20);
  const m = train(X, y);
  assert.ok(predict(m, sample(true)) > 0.9);
  assert.ok(predict(m, sample(false)) < 0.1);
});

test('leave-one-out scores every example with a model that never saw it', () => {
  const { X, y } = data(16);
  const r = leaveOneOut(X, y);
  assert.equal(r.scores.length, 16);
  assert.deepEqual([r.tp, r.fn, r.tn, r.fp], [8, 0, 8, 0]);
  // an unlearnable set is not reported as good
  const noise = Array.from({ length: 16 }, () => sample(true).map(() => rnd() * 4));
  const bad = leaveOneOut(noise, y);
  assert.ok(bad.fp + bad.fn >= 3, 'noise should not look separable');
});

test('the suggested cut-off keeps the Yes marks, and counts are right', () => {
  const scores = [0.99, 0.95, 0.9, 0.05, 0.1], y = [1, 1, 1, 0, 0];
  assert.ok(suggestThreshold(scores, y) <= 0.81 && suggestThreshold(scores, y) > 0.1);
  assert.deepEqual(summarise(scores, y, 0.5), { threshold: 0.5, tp: 3, fp: 0, tn: 2, fn: 0, yes: 3, no: 2 });
  assert.equal(vectorOf({ features: [1, 2], colour: [0.5, 0, 0, 0, 1] }).length, 7);
});

test('saved models are found again, re-read when replaced, and score an embedding', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clf-'));
  const { X, y } = data(12);
  const reg = new Classifiers(dir);
  assert.equal(await reg.get('cam', 'r1'), null);
  assert.equal(await reg.score('cam', 'r1', { features: sample(true, 35), colour: [0, 0, 0, 0, 0] }), null, 'no model, no score');
  await saveModel(dir, 'cam', 'r1', train(X, y), { trainedAt: 'now', yes: 6, no: 6 });
  const s = await reg.score('cam', 'r1', { features: sample(true, 35), colour: [1, 0, 0, 0, 1] });
  assert.ok(s > 0.5 && s <= 1);
  rmSync(dir, { recursive: true, force: true });
});

/** Events with pictures and marks, and a detector whose "embedding" is looked up from the picture's contents. */
async function world(marks) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trn-'));
  const events = new EventLog({ file: path.join(dir, 'e.jsonl'), dir: path.join(dir, 'pics') });
  const kind = new Map();
  for (let i = 0; i < marks.length; i++) {
    const e = await events.add({ type: 'appeared', camera: 'cam', cameraName: 'Cam', rule: 'mail truck', ruleId: 'r1', vehicle: 'truck', score: 0.9,
      box: [0.1, 0.1, 0.5, 0.5], at: new Date(Date.UTC(2026, 9, 1 + i)).toISOString(), tag: `mail truck ${i}` }, Buffer.from(`kind:${marks[i] ?? 'unmarked-yes'}`));
    if (marks[i] === 'yes' || marks[i] === 'no') await events.setVerdict(e.id, marks[i]);
    kind.set(events.snapshotPath(e), marks[i] === 'no' ? false : true);
  }
  const detector = { embed: async (file) => { const f = sample(kind.get(file)); return { features: f, colour: [0, 0, 0, 0, 0] }; } };
  return { dir, events, detector, models: path.join(dir, 'models') };
}

test('training needs enough of each kind, then scores every event of the rule', async () => {
  const w = await world(['yes', 'yes', 'no', 'no']);
  const few = await trainRule({ ...w, dir: w.models, camera: 'cam', rule: 'r1' });
  assert.equal(few.ok, false); assert.match(few.error, new RegExp(`at least ${MIN_EACH} Yes`));
  rmSync(w.dir, { recursive: true, force: true });

  const marks = ['yes', 'no', 'yes', 'no', 'yes', 'no', 'yes', 'no', 'yes', 'no', null, null];
  const v = await world(marks);
  const r = await trainRule({ ...v, dir: v.models, camera: 'cam', rule: 'r1' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual([r.atHalf.tp, r.atHalf.tn, r.atHalf.fp, r.atHalf.fn], [5, 5, 0, 0]);
  assert.equal(r.wrong.length, 0);
  const all = await v.events.list({ camera: 'cam' });
  assert.equal(all.length, 12);
  assert.ok(all.every((e) => typeof e.look === 'number'));
  assert.ok(all.filter((e) => e.verdict).every((e) => e.lookKind === 'unseen'), 'marked ones carry the honest, held-out score');
  assert.ok(all.filter((e) => !e.verdict).every((e) => e.lookKind === 'model' && e.look > 0.5), 'unmarked ones are scored by the final model');
  rmSync(v.dir, { recursive: true, force: true });
});

test('the appearance check adds a score to a new event and cannot stop or start one', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'lk-'));
  const ZONE = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
  const run = async (looks) => {
    const cfg = normalizeDetection({ enabled: true, cameras: { cam: { rules: [{ id: 'r1', enabled: true, mode: 'appears', label: 'mail truck', classes: ['truck'], zone: ZONE, minPresenceSec: 2 }] } } });
    const events = new EventLog({ file: path.join(dir, `e${Math.random()}.jsonl`), dir: path.join(dir, 'p') });
    let t = Date.parse('2026-10-12T14:00:00');
    const svc = new DetectionService({ config: cfg, cameras: [{ id: 'cam', name: 'Cam', channel: 0 }],
      clients: () => ({ motionState: async () => true, snapshot: async () => Buffer.from('J') }),
      detector: { detect: async () => ({ width: 10, height: 10, ms: 1, detections: [{ label: 'truck', score: 0.9, box: [0.3, 0.3, 0.6, 0.6] }] }) },
      events, now: () => t, autoLoop: false, looks });
    await svc.start();
    for (let i = 0; i < 6; i++) { await svc.step(); t += 1500; }
    await svc.stop();
    return (await events.list()).filter((e) => e.type === 'appeared');
  };
  const withScore = await run(async () => 0.12);                 // it thinks this is NOT the mail truck
  assert.equal(withScore.length, 1, 'the event still happens: the check only watches');
  assert.equal(withScore[0].look, 0.12); assert.equal(withScore[0].lookKind, 'live');
  const broken = await run(async () => { throw new Error('model gone'); });
  assert.equal(broken.length, 1); assert.equal(broken[0].look, undefined);
  const none = await run(null);
  assert.equal(none.length, 1);
  rmSync(dir, { recursive: true, force: true });
});
