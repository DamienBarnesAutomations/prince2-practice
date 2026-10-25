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

const listeners = { app: null, document: null, popstate: null };
const appEl = {
  innerHTML: '',
  id: 'app',
  focus() {},
  addEventListener(type, handler) {
    if (type === 'click') listeners.app = handler;
  },
};
const clockEl = { textContent: '' };

// Unreadable saved progress must be set aside, not overwritten by the first answer.
const storage = new Map([['prince2Practice.v1', '{not json']]);

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

globalThis.window = {
  addEventListener(type, handler) {
    if (type === 'popstate') listeners.popstate = handler;
  },
};

// A real stack, because the bugs worth catching live in what pushState truncates
// and in entries that outlive the state behind them.
const stack = [null];
let at = 0;
globalThis.history = {
  get state() {
    return stack[at];
  },
  replaceState(entry) {
    stack[at] = entry;
  },
  pushState(entry) {
    stack.splice(at + 1);
    stack.push(entry);
    at += 1;
  },
};

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

async function press(key, target = {}) {
  listeners.document({ key, preventDefault() {}, target });
  await flush();
}

async function travel(delta) {
  at += delta;
  listeners.popstate({ state: stack[at] });
  await flush();
}

const optionCount = () => (appEl.innerHTML.match(/data-action="answer"/g) ?? []).length;

const index = JSON.parse(await readFile(path.join(repo, 'bank/index.json'), 'utf8'));
const ch02Count = index.sets.find((entry) => entry.id === 'ch02').count;

await import('../app.js');

for (let attempt = 0; attempt < 500; attempt += 1) {
  if (/Practice by chapter/.test(appEl.innerHTML)) break;
  await flush();
}
assert.match(appEl.innerHTML, /Practice by chapter/, 'app never rendered its home screen');

test('unreadable saved progress is kept aside and the user is told', () => {
  assert.match(appEl.innerHTML, /Saved progress could not be read/);
  assert.equal(storage.get('prince2Practice.v1.corrupt'), '{not json');
});

test('home offers the four modes and a progress summary', () => {
  assert.match(appEl.innerHTML, /Mixed chapters/);
  assert.match(appEl.innerHTML, /Exam mode/);
  assert.match(appEl.innerHTML, /Missed questions/);
  assert.match(appEl.innerHTML, new RegExp(`of ${index.total} questions seen`));
  assert.match(appEl.innerHTML, /Progress by chapter/);
  assert.match(appEl.innerHTML, new RegExp(`${index.sets.length} of 21 sets`));
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
  assert.match(appEl.innerHTML, new RegExp(`of ${index.total} questions seen`));
  assert.match(appEl.innerHTML, new RegExp(`1/${ch02Count} seen`));
  assert.match(appEl.innerHTML, /Missed questions/);
  const recorded = JSON.parse(storage.get('prince2Practice.v1')).attempts;
  if (recorded.some((entry) => !entry.correct)) {
    assert.match(appEl.innerHTML, /Missed questions \(\d+\)/);
  }
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

test('leaving a practice session returns home without losing marked answers', async () => {
  const before = JSON.parse(storage.get('prince2Practice.v1')).attempts.length;
  await click('leave');
  assert.match(appEl.innerHTML, /Practice by chapter/);
  const after = JSON.parse(storage.get('prince2Practice.v1')).attempts.length;
  assert.equal(after, before, 'leaving must not add or remove attempts');
});

test('browser back leaves the session instead of the site', async () => {
  await click('mode', { mode: 'chapter' });
  await click('pick-set', { set: 'ch02' });
  await click('start');
  assert.match(appEl.innerHTML, /Question 1 of/);

  await travel(-1);
  assert.match(appEl.innerHTML, /How many questions/);
});

async function finishPracticeSet() {
  await click('mode', { mode: 'chapter' });
  await click('pick-set', { set: 'ch02' });
  await click('set-count', { count: '10' });
  await click('start');
  await click('submit');
  await click('submit');
  assert.match(appEl.innerHTML, /class="review"/);
}

test('back from a restarted quiz lands on a usable screen, not a dead results entry', async () => {
  await click('home');
  await finishPracticeSet();
  await click('restart');
  assert.match(appEl.innerHTML, /Question 1 of/);

  await travel(-1);
  assert.match(appEl.innerHTML, /Practice by chapter/);
  assert.equal(history.state.view, 'home', 'the dead entry is corrected');
});

test('forward onto a results entry whose paper is gone falls back to home', async () => {
  await click('home');
  await finishPracticeSet();
  await click('restart');
  await click('leave');
  await travel(-1);
  assert.match(appEl.innerHTML, /Practice by chapter/);
});

test('a history entry for a screen with no state behind it shows home', async () => {
  await click('home');
  history.replaceState({ view: 'results' }, '');
  await travel(0);
  assert.match(appEl.innerHTML, /Practice by chapter/);
});

test('an exam needs a second press before it can be abandoned', async () => {
  await click('mode', { mode: 'exam' });
  await click('start-exam');
  assert.match(appEl.innerHTML, /Question 1 of 60/);

  await click('leave');
  assert.match(appEl.innerHTML, /will not be marked/);
  assert.match(appEl.innerHTML, /Question 1 of 60/);

  await click('leave');
  assert.match(appEl.innerHTML, /Practice by chapter/);
});

test('Enter on a focused button activates it instead of advancing the question', async () => {
  await click('mode', { mode: 'chapter' });
  await click('pick-set', { set: 'ch02' });
  await click('start');
  assert.match(appEl.innerHTML, /Question 1 of/);

  await press('Enter', { closest: () => ({}) });
  assert.match(appEl.innerHTML, /Question 1 of/);

  await press('Enter');
  assert.match(appEl.innerHTML, /Question 2 of/);
});

test('hard-only does not carry over into the next pool', async () => {
  await click('leave');
  await click('open-chapter', { set: 'ch02' });
  await click('toggle-hard');
  assert.match(appEl.innerHTML, /toggle-hard" checked/);

  await click('home');
  await click('open-chapter', { set: 'ch03' });
  assert.doesNotMatch(appEl.innerHTML, /toggle-hard" checked/);
});
