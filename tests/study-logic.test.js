import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { cardStats, dueCards, findSectionIndex, summariseReviews } from '../study-logic.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = async (file) => JSON.parse(await readFile(path.join(repo, file), 'utf8'));

const DAY = 24 * 60 * 60 * 1000;
const cards = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

test('unseen cards are all due', () => {
  assert.deepEqual(dueCards(cards, [], 0).map((card) => card.id), ['a', 'b', 'c']);
});

test('a known card waits for its interval, then comes back', () => {
  const reviews = [{ id: 'a', known: true, ts: 0 }];
  assert.deepEqual(dueCards(cards, reviews, 0.5 * DAY).map((card) => card.id), ['b', 'c']);
  assert.ok(dueCards(cards, reviews, 1 * DAY).some((card) => card.id === 'a'));
});

test('a lapsed card is due immediately and ranks ahead of unseen cards', () => {
  const reviews = [
    { id: 'c', known: true, ts: 0 },
    { id: 'c', known: false, ts: 10 },
  ];
  assert.equal(dueCards(cards, reviews, 20)[0].id, 'c');
});

test('streak counts consecutive known reviews and resets on a miss', () => {
  const rows = summariseReviews([
    { id: 'a', known: true, ts: 1 },
    { id: 'a', known: true, ts: 2 },
    { id: 'a', known: false, ts: 3 },
    { id: 'a', known: true, ts: 4 },
  ]);
  assert.equal(rows.get('a').streak, 1);
  assert.equal(rows.get('a').reviewed, 4);
});

test('reviews of cards that no longer exist are ignored', () => {
  const stats = cardStats(cards, [{ id: 'gone', known: true, ts: 1 }], 0);
  assert.equal(stats.seen, 0);
  assert.equal(stats.total, 3);
});

test('known means two in a row', () => {
  const reviews = [
    { id: 'a', known: true, ts: 0 },
    { id: 'a', known: true, ts: 1 },
    { id: 'b', known: true, ts: 2 },
  ];
  const stats = cardStats(cards, reviews, 3);
  assert.equal(stats.known, 1);
  assert.equal(stats.seen, 2);
});

test('findSectionIndex uses the source page to split a repeated section id', async () => {
  const chapter = await readJson('study/ch02.json');
  const intro = chapter.sections.findIndex((section) => section.heading.startsWith('What the principles'));
  const apply = chapter.sections.findIndex((section) => section.heading.startsWith('Applying'));

  assert.equal(findSectionIndex(chapter, { section: '2', source: 'p.20' }), intro);
  assert.equal(findSectionIndex(chapter, { section: '2', source: 'p.21' }), apply);
  assert.equal(findSectionIndex(chapter, { section: '2', source: 'p.19' }), intro);
});

test('every question in every set maps to a section with its exact id', async () => {
  const index = await readJson('study/index.json');
  const bank = await readJson('bank/index.json');
  assert.deepEqual(
    index.chapters.map((entry) => entry.set).sort(),
    bank.sets.map((meta) => meta.id).sort(),
    'study notes do not cover the same sets as the bank',
  );

  for (const entry of index.chapters) {
    const chapter = await readJson(entry.file);
    const questions = await readJson(`bank/${entry.set}.json`);
    const ids = new Set(chapter.sections.map((section) => section.id));
    for (const question of questions) {
      assert.ok(ids.has(question.section), `${question.id}: no section "${question.section}" in ${entry.file}`);
      assert.ok(findSectionIndex(chapter, question) >= 0, `${question.id}: no section found`);
    }
  }
});

test('study content is well formed and cites real pages', async () => {
  const index = await readJson('study/index.json');
  for (const entry of index.chapters) {
    const chapter = await readJson(entry.file);
    assert.equal(chapter.set, entry.set);
    assert.ok(chapter.sections.length > 0);
    const [first, last] = chapter.pages.match(/\d+/g).map(Number);

    const ids = new Set();
    for (const card of chapter.cards) {
      assert.ok(card.id && card.front && card.back, `${entry.set}: incomplete card`);
      assert.ok(!ids.has(card.id), `${entry.set}: duplicate card id ${card.id}`);
      ids.add(card.id);
      assert.ok(Number.isInteger(card.page), `${card.id}: page missing`);
      assert.ok(card.id.startsWith(`${entry.set}-c`), `${card.id}: id does not belong to ${entry.set}`);
    }
    for (const section of chapter.sections) {
      assert.ok(Number.isInteger(section.page) && section.points.length > 0, `${section.heading}: bad section`);
      assert.ok(section.page >= first && section.page <= last, `${entry.set}: "${section.heading}" is outside ${chapter.pages}`);
    }
  }
});
