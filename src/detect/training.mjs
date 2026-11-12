// Train the appearance check for one rule from the person's Yes / No marks, and score every event
// of that rule so the page can show what it would have said. Nothing here decides anything.
import { vectorOf, train, leaveOneOut, summarise, suggestThreshold, saveModel, Classifiers } from './classifier.mjs';

export const MIN_EACH = 3;

/**
 * events: the EventLog; detector: anything with embed(file, box); dir: where models live.
 * Returns a report with counts, the leave-one-out result and any example it got wrong.
 */
export async function trainRule({ events, detector, dir, camera, rule, now = () => new Date() }) {
  const all = (await events.list({ camera, limit: 5000 })).filter((e) => e.ruleId === rule && e.type !== 'left' && Array.isArray(e.box));
  const usable = all.filter((e) => events.snapshotPath(e));
  const labelled = usable.filter((e) => e.verdict === 'yes' || e.verdict === 'no');
  const yes = labelled.filter((e) => e.verdict === 'yes').length, no = labelled.length - yes;
  if (yes < MIN_EACH || no < MIN_EACH) {
    return { ok: false, error: `needs at least ${MIN_EACH} Yes and ${MIN_EACH} No marks that have a picture; there are ${yes} Yes and ${no} No`, yes, no };
  }
  const vec = new Map();
  for (const e of usable) {
    try { vec.set(e.id, vectorOf(await detector.embed(events.snapshotPath(e), e.box))); } catch { /* a picture that will not open is left out */ }
  }
  const lab = labelled.filter((e) => vec.has(e.id));
  const X = lab.map((e) => vec.get(e.id)), y = lab.map((e) => (e.verdict === 'yes' ? 1 : 0));
  if (y.filter((v) => v === 1).length < MIN_EACH || y.filter((v) => v === 0).length < MIN_EACH) return { ok: false, error: 'too few of the pictures could be read', yes, no };

  const loo = leaveOneOut(X, y);
  const threshold = Math.round(suggestThreshold(loo.scores, y) * 100) / 100;
  const model = train(X, y);
  const at = now().toISOString();
  await saveModel(dir, camera, rule, model, { trainedAt: at, yes: y.filter((v) => v === 1).length, no: y.filter((v) => v === 0).length,
    loo: summarise(loo.scores, y, 0.5), threshold, version: 1 });

  // what it would say about every event of the rule: the labelled ones as if unseen, the rest from the model
  const looById = new Map(lab.map((e, i) => [e.id, loo.scores[i]]));
  const { predict } = await import('./classifier.mjs');
  for (const e of usable) {
    const v = vec.get(e.id);
    if (!v) continue;
    const s = looById.has(e.id) ? looById.get(e.id) : predict(model, v);
    await events.setLook(e.id, Math.round(s * 1000) / 1000, looById.has(e.id) ? 'unseen' : 'model');
  }
  const wrong = lab.map((e, i) => ({ e, s: loo.scores[i] })).filter(({ e, s }) => (e.verdict === 'yes') !== (s >= 0.5))
    .map(({ e, s }) => ({ id: e.id, tag: e.tag, at: e.at, verdict: e.verdict, looksLike: Math.round(s * 100) / 100 }));
  return { ok: true, yes: loo.yes, no: loo.no, examples: lab.length, atHalf: summarise(loo.scores, y, 0.5), threshold,
    atThreshold: summarise(loo.scores, y, threshold), wrong, scored: usable.length, trainedAt: at };
}

export { Classifiers };
