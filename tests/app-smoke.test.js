/**
 * Drives app.js through the chapter-practice flow against a stub DOM.
 *
 * The published site loads its question files over HTTP, so the app cannot be
 * exercised from file:// in this environment. This test stands in for the
 * browser pass: it proves the render paths, click wiring, keyboard shortcuts,
 * instant feedback and persistence work end to end without throwing.
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
  id: 'app',
  focus() {},
  addEventListener(type, handler) {
    if (type === 'click') listeners.app = handler;
  },
};
const clockEl = { textContent: '' };

const storage = new Map();

globalThis.HTMLInputElement = class HTMLInputElement {};
globalThis.HTMLTextAreaElement = class HTMLTextAreaElement {};

globalThis.document = {
  getElementById: (id) => (id === 'app' ? appEl : clockEl),
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

const optionCount = () => (appEl.innerHTML.match(/data-action="answer"/g) ?? []).length;

await import('../app.js');

for (let attempt = 0; attempt < 500; attempt += 1) {
  if (/Practice by chapter/.test(appEl.innerHTML)) break;
  await flush();
}
assert.match(appEl.innerHTML, /Practice by chapter/, 'app never rendered its home screen');

test('home offers the four modes and a progress summary', () => {
  assert.match(appEl.innerHTML, /Mixed chapters/);
  assert.match(appEl.innerHTML, /Exam mode/);
  assert.match(appEl.innerHTML, /Missed questions/);
  assert.match(appEl.innerHTML, /of 57 questions seen/);
  assert.match(appEl.innerHTML, /Progress by chapter/);
});

test('practice by chapter lists chapters, then offers a question count', async () => {
  await click('mode', { mode: 'chapter' });
  assert.match(appEl.innerHTML, /Pick a chapter to drill/);
  await click('pick-set', { set: 'ch02' });
  assert.match(appEl.innerHTML, /How many questions/);
});

test('a practice question shows four options and no answer before answering', async () => {
  await click('set-count', { count: '10' });
  await click('start');
  assert.match(appEl.innerHTML, /Question 1 of 10/);
  assert.equal(optionCount(), 4);
  assert.doesNotMatch(appEl.innerHTML, /class="feedback/);
});

test('answering marks it immediately and shows the reason', async () => {
  await click('answer', { index: '0' });
  assert.match(appEl.innerHTML, /class="feedback/);
  assert.match(appEl.innerHTML, /(Correct|Not quite)/);
  assert.match(appEl.innerHTML, /Source: p\./);
});

test('an answered question cannot be re-answered', async () => {
  const before = appEl.innerHTML;
  await click('answer', { index: '2' });
  assert.equal(appEl.innerHTML, before);
});

test('an answer is recorded with the mode and result the screen showed', async () => {
  const saved = JSON.parse(storage.get('prince2Practice.v1'));
  const last = saved.attempts[saved.attempts.length - 1];

  assert.equal(saved.version, 2);
  assert.equal(last.mode, 'chapter');
  assert.equal(last.set, 'ch02');
  assert.equal(typeof last.correct, 'boolean');

  const showedCorrect = /class="feedback good"/.test(appEl.innerHTML);
  assert.equal(last.correct, showedCorrect);
});

test('advancing and submitting reaches the review screen', async () => {
  await click('next');
  assert.match(appEl.innerHTML, /Question 2 of 10/);

  for (let i = 0; i < 30; i += 1) {
    const forward = /data-action="next"/.test(appEl.innerHTML) ? 'next' : 'submit';
    if (forward === 'submit') break;
    await click('next');
  }

  await click('submit');
  if (/Submit anyway/.test(appEl.innerHTML) || /still unanswered/.test(appEl.innerHTML)) {
    await click('submit');
  }
  assert.match(appEl.innerHTML, /class="review"/);
  assert.match(appEl.innerHTML, /Review/);
});

test('home reflects the attempts that were recorded', async () => {
  await click('home');
  assert.match(appEl.innerHTML, /of 57 questions seen/);
  assert.match(appEl.innerHTML, /1\/57 seen/);
  assert.match(appEl.innerHTML, /Missed questions \(/);
});

test('keyboard answers and advances in practice mode', async () => {
  await click('mode', { mode: 'chapter' });
  await click('pick-set', { set: 'ch02' });
  await click('start');

  await press('2');
  assert.match(appEl.innerHTML, /class="feedback/);
  await press('ArrowRight');
  assert.match(appEl.innerHTML, /Question 2 of/);
});
