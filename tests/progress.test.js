import assert from 'node:assert/strict';
import test from 'node:test';

import { chapterProgress, missedIds, passMark, summariseAttempts } from '../progress.js';

const attempt = (id, correct, extra = {}) => ({
  id,
  set: 'ch02',
  section: '2.4',
  topic: 'Manage by exception',
  correct,
  ts: 0,
  ...extra,
});

test('a question answered wrong then right once is still missed', () => {
  assert.deepEqual(missedIds([attempt('q1', false), attempt('q1', true)]), ['q1']);
});

test('two consecutive correct answers clear a missed question', () => {
  assert.deepEqual(
    missedIds([attempt('q1', false), attempt('q1', true), attempt('q1', true)]),
    [],
  );
});

test('getting a cleared question wrong again puts it back on the list', () => {
  const history = [attempt('q1', false), attempt('q1', true), attempt('q1', true), attempt('q1', false)];
  assert.deepEqual(missedIds(history), ['q1']);
});

test('a question never answered wrong is not on the missed list', () => {
  assert.deepEqual(missedIds([attempt('q1', true), attempt('q1', true)]), []);
});

test('a streak broken by a wrong answer starts again from zero', () => {
  const rows = summariseAttempts([
    attempt('q1', true),
    attempt('q1', false),
    attempt('q1', true),
  ]);
  const row = rows.get('q1');
  assert.equal(row.streak, 1);
  assert.equal(row.mastered, false);
  assert.equal(row.right, 2);
  assert.equal(row.wrong, 1);
  assert.equal(row.answered, 3);
});

test('malformed attempts are ignored rather than counted', () => {
  const rows = summariseAttempts([null, { correct: true }, attempt('q1', true)]);
  assert.equal(rows.size, 1);
});

test('chapter progress counts exposure, right, wrong and mastery', () => {
  const sets = [
    { id: 'ch02', title: 'Principles', order: 2, count: 10 },
    { id: 'ch03', title: 'People', order: 3, count: 5 },
  ];
  const attempts = [
    attempt('a', false),
    attempt('a', true),
    attempt('a', true), // mastered
    attempt('b', true), // right, not mastered
    attempt('c', false), // wrong
    attempt('c', false),
    attempt('d', true, { set: 'ch03' }),
  ];

  const { rows, overall } = chapterProgress(attempts, sets);
  const [ch2, ch3] = rows;

  assert.equal(ch2.exposed, 3);
  assert.equal(ch2.right, 2);
  assert.equal(ch2.wrong, 1);
  assert.equal(ch2.mastered, 1);
  assert.equal(ch2.total, 10);

  assert.equal(ch3.exposed, 1);
  assert.equal(ch3.right, 1);

  assert.equal(overall.exposed, 4);
  assert.equal(overall.right, 3);
  assert.equal(overall.wrong, 1);
  assert.equal(overall.mastered, 1);
  assert.equal(overall.total, 15);
});

test('exposure never exceeds the questions in the chapter', () => {
  const sets = [{ id: 'ch02', title: 'Principles', order: 2, count: 1 }];
  const { rows } = chapterProgress([attempt('a', true), attempt('b', true)], sets);
  assert.equal(rows[0].exposed, 1);
});

test('pass mark is 60% of the questions drawn, rounded up', () => {
  assert.equal(passMark(60), 36);
  assert.equal(passMark(57), 35);
  assert.equal(passMark(10), 6);
});

test('attempts for questions no longer in the bank are not counted', () => {
  const known = new Set(['q1']);
  const attempts = [attempt('q1', false), attempt('gone', false)];

  assert.deepEqual(missedIds(attempts, known), ['q1']);
  assert.deepEqual(missedIds(attempts), ['q1', 'gone']);

  const sets = [{ id: 'ch02', title: 'Principles', order: 2, count: 10 }];
  const { rows } = chapterProgress(attempts, sets, known);
  assert.equal(rows[0].exposed, 1);
  assert.equal(rows[0].wrong, 1);
});
