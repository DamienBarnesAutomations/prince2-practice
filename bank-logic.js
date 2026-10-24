/**
 * Pure session logic. No DOM, no storage, no fetch — so it can be tested
 * directly with `node --test tests/`.
 *
 * The question model is deliberately a pool rather than four fixed options:
 * one correct answer plus five to seven hand-written distractors. A draw takes
 * three of them, so the same question presents a different option set on
 * different attempts.
 */

export const OPTIONS_SHOWN = 4;

/** Fisher-Yates over a copy. Takes an rng so tests are deterministic. */
export function shuffle(items, rng = Math.random) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export function drawQuestions(pool, count, rng = Math.random) {
  if (!Array.isArray(pool)) throw new Error('drawQuestions: pool must be an array');
  const wanted = Math.max(1, Math.min(count, pool.length));
  return shuffle(pool, rng).slice(0, wanted);
}

/**
 * Builds the four options a candidate sees, and records where the correct one
 * landed. Throws rather than degrading: a question that cannot fill four
 * options is a bank bug, and silently showing three would score a guess.
 */
export function buildOptions(question, rng = Math.random) {
  const { id, answer, distractors } = question;
  if (typeof answer !== 'string' || !answer.trim()) {
    throw new Error(`question ${id}: no answer`);
  }
  if (!Array.isArray(distractors)) {
    throw new Error(`question ${id}: distractors missing`);
  }

  const needed = OPTIONS_SHOWN - 1;
  const pool = question.exhaustive ? distractors : shuffle(distractors, rng).slice(0, needed);
  if (pool.length !== needed) {
    throw new Error(
      `question ${id}: needs ${needed} distractors to show ${OPTIONS_SHOWN} options, has ${pool.length}`,
    );
  }

  const options = shuffle([answer, ...pool], rng);
  return { options, correctIndex: options.indexOf(answer) };
}

/** Builds a ready-to-answer session. Question order and option order both shuffled. */
export function buildSession(pool, count, rng = Math.random) {
  return drawQuestions(pool, count, rng).map((question) => {
    const { options, correctIndex } = buildOptions(question, rng);
    return { question, options, correctIndex, selected: null, flagged: false };
  });
}

/** Reshuffles the options of an already-built session, keeping the answers chosen. */
export function reshuffleOptions(session, rng = Math.random) {
  return session.map((entry) => {
    const chosenText = entry.selected === null ? null : entry.options[entry.selected];
    const { options, correctIndex } = buildOptions(entry.question, rng);
    return { ...entry, options, correctIndex, selected: chosenText === null ? null : options.indexOf(chosenText) };
  });
}

export function scoreSession(session) {
  const bySection = new Map();
  const byTopic = new Map();
  let correct = 0;

  for (const entry of session) {
    const isCorrect = entry.selected === entry.correctIndex;
    if (isCorrect) correct += 1;

    const section = entry.question.section ?? 'unknown';
    const sectionTally = bySection.get(section) ?? { section, correct: 0, total: 0 };
    sectionTally.total += 1;
    if (isCorrect) sectionTally.correct += 1;
    bySection.set(section, sectionTally);

    const topic = entry.question.topic ?? 'unknown';
    const topicTally = byTopic.get(topic) ?? { topic, correct: 0, total: 0 };
    topicTally.total += 1;
    if (isCorrect) topicTally.correct += 1;
    byTopic.set(topic, topicTally);
  }

  const total = session.length;
  return {
    total,
    answered: session.filter((entry) => entry.selected !== null).length,
    correct,
    percent: total === 0 ? 0 : Math.round((correct / total) * 100),
    bySection: [...bySection.values()].sort((a, b) => a.section.localeCompare(b.section)),
    byTopic: [...byTopic.values()].sort((a, b) => b.total - a.total),
    missed: session.filter((entry) => entry.selected !== entry.correctIndex).map((entry) => entry.question.id),
  };
}
