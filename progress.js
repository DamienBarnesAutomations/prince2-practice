/**
 * Derived progress. Nothing here is stored — every number is recomputed from the
 * append-only attempts array, so a counter can never drift from the history.
 *
 * The attempts array is in answering order, which is what makes "consecutive
 * correct answers" meaningful without storing a streak.
 */

export const MASTERY_STREAK = 2;

/**
 * One row per question ever answered.
 *
 * streak is the count of consecutive correct answers ending at the most recent
 * attempt. mastered means the streak has reached MASTERY_STREAK. missed means
 * the question has been answered wrong at least once and is not yet mastered —
 * getting it right twice in a row is what clears it.
 */
export function summariseAttempts(attempts, knownIds = null) {
  const rows = new Map();

  for (const attempt of attempts) {
    if (!attempt || typeof attempt.id !== 'string' || !attempt.id) continue;
    // A question removed or renumbered in the bank must not keep counting.
    if (knownIds && !knownIds.has(attempt.id)) continue;

    let row = rows.get(attempt.id);
    if (!row) {
      row = {
        id: attempt.id,
        set: attempt.set,
        section: attempt.section,
        topic: attempt.topic,
        answered: 0,
        right: 0,
        wrong: 0,
        streak: 0,
        lastCorrect: false,
      };
      rows.set(attempt.id, row);
    }

    row.set = row.set ?? attempt.set;
    row.answered += 1;
    row.lastCorrect = attempt.correct === true;
    if (row.lastCorrect) {
      row.right += 1;
      row.streak += 1;
    } else {
      row.wrong += 1;
      row.streak = 0;
    }
  }

  for (const row of rows.values()) {
    row.mastered = row.streak >= MASTERY_STREAK;
    row.missed = row.wrong > 0 && !row.mastered;
  }

  return rows;
}

export function missedIds(attempts, knownIds = null) {
  return [...summariseAttempts(attempts, knownIds).values()]
    .filter((row) => row.missed)
    .map((row) => row.id);
}

/**
 * Per-chapter tallies plus an overall row.
 *
 * right/wrong describe the most recent answer to each question, so they always
 * sum to exposed. mastered is counted separately because a question can be
 * right now and not yet mastered.
 */
export function chapterProgress(attempts, sets, knownIds = null) {
  const summaries = summariseAttempts(attempts, knownIds);
  const bySet = new Map();

  for (const row of summaries.values()) {
    const key = row.set;
    if (!key) continue;
    if (!bySet.has(key)) bySet.set(key, { exposed: 0, right: 0, wrong: 0, mastered: 0 });
    const tally = bySet.get(key);
    tally.exposed += 1;
    if (row.lastCorrect) tally.right += 1;
    else tally.wrong += 1;
    if (row.mastered) tally.mastered += 1;
  }

  const empty = () => ({ exposed: 0, right: 0, wrong: 0, mastered: 0 });

  const rows = sets.map((set) => {
    const tally = bySet.get(set.id) ?? empty();
    return {
      setId: set.id,
      title: set.title,
      order: set.order,
      total: set.count,
      exposed: Math.min(tally.exposed, set.count),
      right: tally.right,
      wrong: tally.wrong,
      mastered: Math.min(tally.mastered, set.count),
    };
  });

  const overall = rows.reduce(
    (acc, row) => ({
      exposed: acc.exposed + row.exposed,
      right: acc.right + row.right,
      wrong: acc.wrong + row.wrong,
      mastered: acc.mastered + row.mastered,
      total: acc.total + row.total,
    }),
    { exposed: 0, right: 0, wrong: 0, mastered: 0, total: 0 },
  );

  return { rows, overall };
}

/** Pass mark for a run of this length, at the real Foundation threshold of 60%. */
export function passMark(total) {
  return Math.ceil(total * 0.6);
}
