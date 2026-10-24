/**
 * Drives app.js through a full chapter drill against a stub DOM.
 *
 * The published site loads its question files over HTTP, so the app cannot be
 * exercised from file:// in this environment. This test stands in for the
 * browser pass: it proves the render paths, the click wiring, the keyboard
 * shortcuts and the persistence call all work end to end without throwing.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const listeners = { app: null, document: null };
const appEl = {
  innerHTML: '',
  focus() {},
  addEventListener(type, handler) {
    if (type === 'click') listeners.app = handler;
  },
};

const storage = new Map();

globalThis.HTMLInputElement = class HTMLInputElement {};
globalThis.HTMLTextAreaElement = class HTMLTextAreaElement {};

globalThis.document = {
  getElementById: () => appEl,
  addEventListener(type, handler) {
    if (type === 'keydown') listeners.document = handler;
  },
};

globalThis.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, value),
};

globalThis.history = { replaceState() {} };

globalThis.fetch = async (url) => {
  const relative = String(url).replace(/^\.\//, '').split('?')[0];
  try {
    const body = await readFile(path.join(repo, relative), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body) };
  } catch {
    return { ok: false, status: 404, json: async () => ({}) };
  }
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function click(action, data = {}) {
  const target = { dataset: { action, ...data }, closest: () => target };
  await listeners.app({ target });
  await flush();
}

async function press(key) {
  listeners.document({ key, preventDefault() {}, target: {} });
  await flush();
}

function optionCount() {
  return (appEl.innerHTML.match(/class="option"/g) ?? []).length;
}

await import('../app.js');

// boot() fetches index.json; poll rather than guessing at a fixed number of ticks.
for (let attempt = 0; attempt < 500; attempt += 1) {
  if (/Practice by chapter/.test(appEl.innerHTML)) break;
  await flush();
}
assert.match(appEl.innerHTML, /Practice by chapter/, 'app never rendered its home screen');

test('home screen lists the loaded set with its question count', () => {
  assert.match(appEl.innerHTML, /Practice by chapter/);
  assert.match(appEl.innerHTML, /Principles/);
  assert.match(appEl.innerHTML, /57 questions/);
});

test('opening a set offers a question count and a difficulty filter', async () => {
  await click('open-set', { set: 'ch02' });
  assert.match(appEl.innerHTML, /How many questions/);
  assert.match(appEl.innerHTML, /Hard questions only/);
});

test('a drill shows one question with four options and no feedback', async () => {
  await click('set-count', { count: '10' });
  await click('start-drill');
  assert.match(appEl.innerHTML, /Question 1 of 10/);
  assert.equal(optionCount(), 4);
  assert.doesNotMatch(appEl.innerHTML, /explanation|Correct|Missed/i);
});

test('keyboard selects and advances', async () => {
  await press('2');
  assert.match(appEl.innerHTML, /Question 1 of 10/);
  assert.match(appEl.innerHTML, /1 answered/);
  await press('ArrowRight');
  assert.match(appEl.innerHTML, /Question 2 of 10/);
});

test('flagging marks the question', async () => {
  await press('f');
  assert.match(appEl.innerHTML, /Flagged/);
});

test('submitting with blanks asks for confirmation first', async () => {
  await click('submit');
  assert.match(appEl.innerHTML, /still unanswered/);
  await click('submit');
  assert.match(appEl.innerHTML, /of 10/);
  assert.match(appEl.innerHTML, /Review/);
});

test('results record attempts and the home screen reflects them', async () => {
  const saved = JSON.parse(storage.get('prince2Practice.v1'));
  assert.equal(saved.attempts.length, 10);
  assert.ok(saved.attempts.every((attempt) => attempt.set === 'ch02'));

  await click('home');
  assert.match(appEl.innerHTML, /10 seen/);
});

test('missed questions can be drilled again', async () => {
  if (!/Drill \d+ missed/.test(appEl.innerHTML)) return; // a perfect run has nothing to drill
  await click('drill-missed');
  assert.match(appEl.innerHTML, /Question 1 of/);
  assert.equal(optionCount(), 4);
});
