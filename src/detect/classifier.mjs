// "Does this look like the thing I marked Yes?" A small logistic-regression model trained on the
// person's own Yes / No marks, over numbers that describe the cut-out picture of each detection
// (see detector/helper.py, embed). It is deliberately simple: with a few dozen examples a model
// with a few thousand moving parts would only memorise them. It runs in observing mode: it adds a
// score to an event and never decides whether the event happens.
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

/** The feature vector for one embed() answer. */
export const vectorOf = (emb) => [...emb.features, ...emb.colour.map((c) => c * 4)];

/** The logistic function, with its input limited so it cannot overflow. */
const sigmoid = (z) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/**
 * Train. X: array of feature arrays, y: 0/1. Features are standardised, then plain gradient descent
 * with an L2 penalty (`l2`) that keeps the weights small. Classes are weighted equally so a
 * handful of Yes marks are not drowned by many No marks.
 */
export function train(X, y, { l2 = 0.05, iters = 300, lr = 0.5 } = {}) {
  const n = X.length, d = X[0].length;
  const mean = new Array(d).fill(0), std = new Array(d).fill(0);
  for (const x of X) for (let j = 0; j < d; j++) mean[j] += x[j] / n;
  for (const x of X) for (let j = 0; j < d; j++) std[j] += (x[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) std[j] = Math.max(Math.sqrt(std[j]), 1e-2);
  const Z = X.map((x) => x.map((v, j) => (v - mean[j]) / std[j]));
  const pos = y.filter((v) => v === 1).length, neg = n - pos;
  const wt = y.map((v) => (v === 1 ? n / (2 * pos) : n / (2 * neg)));
  const w = new Array(d).fill(0);
  let b = 0;
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b;
      for (let j = 0; j < d; j++) z += w[j] * Z[i][j];
      const e = (sigmoid(z) - y[i]) * wt[i] / n;
      gb += e;
      for (let j = 0; j < d; j++) gw[j] += e * Z[i][j];
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] + l2 * w[j] / n * 10);
    b -= lr * gb;
  }
  return { mean, std, w, b };
}

/**
 * The model's score for one feature vector, from 0 to 1. @param {{w: number[], b: number, mean: number[], std: number[]}} model
 */
export function predict(model, x) {
  let z = model.b;
  for (let j = 0; j < model.w.length; j++) z += model.w[j] * ((x[j] - model.mean[j]) / model.std[j]);
  return sigmoid(z);
}

/**
 * Leave-one-out: every example is scored by a model that never saw it, which is the honest answer
 * to "would this have worked on something new?". Returns the scores and a summary at `threshold`.
 */
export function leaveOneOut(X, y, opts = {}, threshold = 0.5) {
  const scores = X.map((_, i) => predict(train(X.filter((__, k) => k !== i), y.filter((__, k) => k !== i), opts), X[i]));
  return { scores, ...summarise(scores, y, threshold) };
}

/**
 * Counts how the scores fall against the true marks at `threshold`. @returns {{threshold: number, tp: number, fp: number, tn: number, fn: number, yes: number, no: number}}
 */
export function summarise(scores, y, threshold) {
  let tp = 0, fp = 0, tn = 0, fn = 0;
  scores.forEach((s, i) => { const hit = s >= threshold; if (y[i] === 1) hit ? tp++ : fn++; else hit ? fp++ : tn++; });
  return { threshold, tp, fp, tn, fn, yes: tp + fn, no: tn + fp };
}

/** The lowest threshold that keeps every Yes (by leave-one-out), nudged down a little for safety; 0.5 if none. */
export function suggestThreshold(scores, y) {
  const yes = scores.filter((_, i) => y[i] === 1);
  if (!yes.length) return 0.5;
  return Math.max(0.05, Math.min(0.5, Math.min(...yes) * 0.9));
}

// ---- saved models, one per camera and rule ------------------------------------------------------

/** Where the trained model for one device and rule is kept. */
export const modelFile = (dir, camera, ruleId) => path.join(dir, 'classifiers', `${camera}__${ruleId}.json`);

/** Saves a trained model for a device and rule, replacing the file in one step so a reader never sees half of it. */
export async function saveModel(dir, camera, ruleId, model, meta) {
  const file = modelFile(dir, camera, ruleId);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify({ ...meta, camera, ruleId, model }), { mode: 0o600 });
  await rename(tmp, file);
}

/** Loads saved models and re-reads one when its file changes (training happens in another request). */
export class Classifiers {
  #dir; #cache = new Map();
  constructor(dir) { this.#dir = dir; }
  /** The saved model for a device and rule, or null. Read again only when its file has changed. */
  async get(camera, ruleId) {
    const file = modelFile(this.#dir, camera, ruleId);
    let st; try { st = await stat(file); } catch { this.#cache.delete(file); return null; }
    const hit = this.#cache.get(file);
    if (hit && hit.mtime === st.mtimeMs) return hit.saved;
    try { const saved = JSON.parse(await readFile(file, 'utf8')); this.#cache.set(file, { mtime: st.mtimeMs, saved }); return saved; } catch { return null; }
  }
  /** 0..1 for an embed() answer, or null when no model is trained for this rule. */
  async score(camera, ruleId, emb) {
    const saved = await this.get(camera, ruleId);
    return saved ? Math.round(predict(saved.model, vectorOf(emb)) * 1000) / 1000 : null;
  }
}
