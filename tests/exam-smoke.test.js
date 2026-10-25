/**
 * Exam mode against a synthetic 75-question bank, because the real bank is not
 * yet long enough to fill a 60-question paper. Proves the draw, the clock, the
 * palette, flagging, the pass mark and the saved exam record.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

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

const pushed = [];
globalThis.history = { replaceState() {}, pushState: (entry) => pushed.push(entry.view) };

globalThis.window = {
  addEventListener(type, handler) {
    if (type === 'popstate') listeners.popstate = handler;
  },
};

function makeQuestions(setId, count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${setId}-${String(i + 1).padStart(3, '0')}`,
    set: setId,
    section: `${setId}.1`,
    topic: `${setId} topic`,
    difficulty: 2,
    stem: `${setId} question ${i + 1}`,
    answer: `${setId} right ${i}`,
    distractors: [`${setId} wrong ${i}a`, `${setId} wrong ${i}b`, `${setId} wrong ${i}c`, `${setId} wrong ${i}d`, `${setId} wrong ${i}e`],
    explanation: 'Because the manual says so, at some length to satisfy the validator minimum.',
    source: 'p.1',
  }));
}

const bank = {
  'bank/index.json': {
    version: 1,
    edition: 'PRINCE2 7',
    total: 75,
    sets: [
      { id: 'ch02', order: 2, kind: 'chapter', title: 'Principles', file: 'bank/ch02.json', count: 25 },
      { id: 'ch03', order: 3, kind: 'chapter', title: 'People', file: 'bank/ch03.json', count: 25 },
      { id: 'ch05', order: 5, kind: 'chapter', title: 'Business case', file: 'bank/ch05.json', count: 25 },
    ],
  },
  'bank/ch02.json': makeQuestions('ch02', 25),
  'bank/ch03.json': makeQuestions('ch03', 25),
  'bank/ch05.json': makeQuestions('ch05', 25),
};

globalThis.fetch = async (url) => {
  const key = String(url).replace(/^\.\//, '').split('?')[0];
  if (bank[key]) return { ok: true, status: 200, json: async () => bank[key] };
  return { ok: false, status: 404, json: async () => ({}) };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function click(action, data = {}) {
  const target = { dataset: { action, ...data }, closest: () => target };
  await listeners.app({ target });
  await flush();
}

await import('../app.js');
for (let attempt = 0; attempt < 500; attempt += 1) {
  if (/Exam mode/.test(appEl.innerHTML)) break;
  await flush();
}

test('a failed file load is reported on the current screen and can be retried', async () => {
  await click('mode', { mode: 'chapter' });
  const held = bank['bank/ch05.json'];
  delete bank['bank/ch05.json'];

  await click('pick-set', { set: 'ch05' });
  assert.match(appEl.innerHTML, /Something went wrong: Could not load bank\/ch05\.json/);
  assert.doesNotMatch(appEl.innerHTML, /question bank could not be loaded/);
  assert.match(appEl.innerHTML, /Pick a chapter to drill/);

  bank['bank/ch05.json'] = held;
  await click('pick-set', { set: 'ch05' });
  assert.match(appEl.innerHTML, /How many questions/);
  assert.doesNotMatch(appEl.innerHTML, /Something went wrong/);
});

test('a filter that matches nothing says so instead of doing nothing', async () => {
  // The synthetic bank has no hard questions.
  await click('toggle-hard');
  await click('start');
  assert.match(appEl.innerHTML, /No questions match that filter/);
  assert.match(appEl.innerHTML, /How many questions/);
  await click('toggle-hard');
});

test('exam intro states the real exam rules', async () => {
  await click('mode', { mode: 'exam' });
  assert.match(appEl.innerHTML, /60 minutes/);
  assert.match(appEl.innerHTML, /36 \/ 60/);
  assert.match(appEl.innerHTML, /After submit only/);
});

test('starting an exam draws 60 unique questions and starts the clock', async () => {
  await click('start-exam');
  assert.match(appEl.innerHTML, /Question 1 of 60/);
  assert.equal((appEl.innerHTML.match(/data-action="goto"/g) ?? []).length, 60);
  assert.match(clockEl.textContent, /^\d+:\d\d$/);
});

test('exam mode gives no feedback when answering', async () => {
  await click('answer', { index: '0' });
  assert.doesNotMatch(appEl.innerHTML, /class="feedback/);
  assert.equal((appEl.innerHTML.match(/class="pal[^"]*done/g) ?? []).length, 1);
});

test('flagging and the palette jump work', async () => {
  await click('flag');
  assert.match(appEl.innerHTML, /Flagged/);
  await click('goto', { index: '42' });
  assert.match(appEl.innerHTML, /Question 43 of 60/);

  const storageAfter = JSON.parse(storage.get('prince2Practice.v1') || '{}');
  assert.equal(storageAfter.attempts, undefined, 'exam answers must not be recorded before submit');
});

test('submitting an exam records the paper and scores it against the pass mark', async () => {
  await click('submit');
  if (/still unanswered/.test(appEl.innerHTML)) await click('submit');

  assert.match(appEl.innerHTML, /(Pass|Fail) — \d+\/60/);
  assert.match(appEl.innerHTML, /Pass mark 36/);
  assert.equal((appEl.innerHTML.match(/class="reviewitem/g) ?? []).length, 60);

  const saved = JSON.parse(storage.get('prince2Practice.v1'));
  assert.equal(saved.version, 2);
  assert.equal(saved.attempts.length, 60);
  assert.equal(saved.exams.length, 1);
  assert.equal(saved.exams[0].total, 60);
  assert.equal(typeof saved.exams[0].durationMs, 'number');
});

test('browser back asks once before discarding a live exam paper', async () => {
  await click('mode', { mode: 'exam' });
  await click('start-exam');
  assert.match(appEl.innerHTML, /Question 1 of 60/);

  listeners.popstate({ state: { view: 'examIntro' } });
  await flush();
  assert.match(appEl.innerHTML, /will not be marked/);
  assert.match(appEl.innerHTML, /Question 1 of 60/);

  listeners.popstate({ state: { view: 'home' } });
  await flush();
  assert.match(appEl.innerHTML, /Practice by chapter/);
  assert.match(appEl.innerHTML, /Missed questions/);
});

test('a double-click on Start exam starts one paper and one history entry', async () => {
  await click('home');
  await click('mode', { mode: 'exam' });
  const before = pushed.filter((view) => view === 'quiz').length;

  await Promise.all([click('start-exam'), click('start-exam')]);
  assert.match(appEl.innerHTML, /Question 1 of 60/);
  assert.equal(pushed.filter((view) => view === 'quiz').length - before, 1);

  // Abandon, so the exam clock does not keep the test process alive.
  await click('leave');
  await click('leave');
});
