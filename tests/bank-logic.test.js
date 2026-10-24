import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOptions,
  buildSession,
  deriveMissed,
  drawQuestions,
  reshuffleOptions,
  scoreSession,
  shuffle,
} from '../bank-logic.js';

const question = (overrides = {}) => ({
  id: 'ch99-001',
  section: '9.1',
  topic: 'test',
  difficulty: 2,
  stem: 'stem',
  answer: 'the right one',
  distractors: ['a', 'b', 'c', 'd', 'e', 'f'],
  explanation: 'because',
  ...overrides,
});

test('shuffle keeps every item and leaves the input untouched', () => {
  const input = [1, 2, 3, 4, 5];
  const output = shuffle(input);
  assert.deepEqual([...output].sort(), [1, 2, 3, 4, 5]);
  assert.deepEqual(input, [1, 2, 3, 4, 5]);
});

test('drawQuestions never repeats a question and clamps to the pool size', () => {
  const pool = Array.from({ length: 10 }, (_, i) => question({ id: `ch99-${i}` }));
  const drawn = drawQuestions(pool, 6);
  assert.equal(drawn.length, 6);
  assert.equal(new Set(drawn.map((q) => q.id)).size, 6);
  assert.equal(drawQuestions(pool, 99).length, 10);
});

test('buildOptions shows four options with the answer present exactly once', () => {
  for (let i = 0; i < 50; i += 1) {
    const { options, correctIndex } = buildOptions(question());
    assert.equal(options.length, 4);
    assert.equal(options.filter((option) => option === 'the right one').length, 1);
    assert.equal(options[correctIndex], 'the right one');
    assert.equal(new Set(options).size, 4);
  }
});

test('buildOptions varies which distractors appear', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const { options } = buildOptions(question());
    seen.add(options.filter((option) => option !== 'the right one').sort().join('|'));
  }
  assert.ok(seen.size > 1, 'expected more than one distractor triple across 200 draws');
});

test('an exhaustive question always shows every distractor', () => {
  const q = question({ distractors: ['x', 'y', 'z'], exhaustive: true });
  for (let i = 0; i < 20; i += 1) {
    const { options } = buildOptions(q);
    assert.deepEqual([...options].sort(), ['the right one', 'x', 'y', 'z']);
  }
});

test('buildOptions throws rather than showing three options', () => {
  assert.throws(() => buildOptions(question({ distractors: ['a', 'b'] })), /needs 3 distractors/);
  assert.throws(() => buildOptions(question({ distractors: ['x', 'y'], exhaustive: true })), /needs 3 distractors/);
  assert.throws(() => buildOptions(question({ answer: '' })), /no answer/);
});

test('buildSession shuffles question order and option order', () => {
  const pool = Array.from({ length: 8 }, (_, i) => question({ id: `ch99-${i}` }));
  const first = buildSession(pool, 8).map((entry) => entry.question.id);
  const second = buildSession(pool, 8).map((entry) => entry.question.id);
  assert.equal(first.length, 8);
  assert.notDeepEqual(first, second);
});

test('scoreSession tallies overall and per-section results', () => {
  const session = [
    { question: { id: 'a', section: '1', topic: 'alpha' }, options: ['x'], correctIndex: 0, selected: 0 },
    { question: { id: 'b', section: '1', topic: 'alpha' }, options: ['x'], correctIndex: 0, selected: null },
    { question: { id: 'c', section: '2', topic: 'beta' }, options: ['x'], correctIndex: 1, selected: 0 },
  ];
  const result = scoreSession(session);
  assert.equal(result.total, 3);
  assert.equal(result.answered, 2);
  assert.equal(result.correct, 1);
  assert.equal(result.percent, 33);
  assert.deepEqual(result.missed, ['b', 'c']);
  assert.deepEqual(
    result.bySection.map((s) => [s.section, s.correct, s.total]),
    [['1', 1, 2], ['2', 0, 1]],
  );
});

test('deriveMissed uses the most recent attempt per question', () => {
  const attempts = [
    { id: 'a', correct: false, ts: 100 },
    { id: 'a', correct: true, ts: 200 },
    { id: 'b', correct: true, ts: 100 },
    { id: 'b', correct: false, ts: 200 },
    { id: 'c', correct: false, ts: 50 },
  ];
  assert.deepEqual(deriveMissed(attempts), ['b', 'c']);
});

test('reshuffleOptions keeps the chosen answer on the same option text', () => {
  const session = buildSession([question({ id: 'ch99-009' })], 1, () => 0.4);
  const answered = session.map((entry) => ({ ...entry, selected: entry.correctIndex }));
  const chosenText = answered[0].options[answered[0].selected];

  const rebuilt = reshuffleOptions(answered);
  assert.equal(rebuilt[0].options[rebuilt[0].selected], chosenText);
  assert.equal(rebuilt[0].selected, rebuilt[0].correctIndex);
});
