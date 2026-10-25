import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildOptions } from '../bank-logic.js';

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readJson = async (relative) => JSON.parse(await readFile(path.join(repo, relative), 'utf8'));

test('every question in the shipped bank can be presented as four options', async () => {
  const index = await readJson('bank/index.json');
  assert.ok(index.sets.length > 0, 'index lists no sets');

  let total = 0;
  for (const meta of index.sets) {
    const questions = await readJson(meta.file);
    assert.equal(questions.length, meta.count, `${meta.id}: index count does not match the file`);

    for (const question of questions) {
      assert.equal(question.set, meta.id, `${question.id}: set does not match its file`);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { options, correctIndex } = buildOptions(question);
        assert.equal(options.length, 4, `${question.id}: expected 4 options`);
        assert.equal(options[correctIndex], question.answer, `${question.id}: correctIndex is not the answer`);
        assert.equal(new Set(options).size, 4, `${question.id}: duplicate option in a draw`);
      }
      total += 1;
    }
  }
  assert.ok(total > 0);
});

test('the shipped bank has no duplicate question ids', async () => {
  const index = await readJson('bank/index.json');
  const ids = [];
  for (const meta of index.sets) {
    for (const question of await readJson(meta.file)) ids.push(question.id);
  }
  assert.equal(new Set(ids).size, ids.length);
});

test('the bank passes the validator: answer shape, duplicate stems and spelling', (t) => {
  // The shape rules live in tools/validate_bank.py so the same check runs from the
  // command line when questions are written. Skip where Python is not installed.
  const script = path.join(repo, 'tools', 'validate_bank.py');
  // Windows ships a `python3` stub that exits non-zero without raising, so a
  // status of 9009 or a "not found" message means try the next interpreter.
  let result = { error: new Error('no python') };
  for (const python of ['python3', 'python', 'py']) {
    const attempt = spawnSync(python, [script], { encoding: 'utf8' });
    if (attempt.error || /was not found/i.test(attempt.stderr ?? '')) continue;
    result = attempt;
    break;
  }
  if (result.error) {
    t.skip('python is not available');
    return;
  }
  assert.equal(result.status, 0, `${result.stdout}
${result.stderr}`);
});
