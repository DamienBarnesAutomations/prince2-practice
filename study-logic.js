/**
 * Study-side logic: flashcard scheduling and mapping a question back to the
 * section of the manual that covers it.
 *
 * Like progress.js, nothing here is stored. Card reviews are an append-only
 * array in answering order; a card's box is the count of consecutive "known"
 * reviews ending at the latest one, and when it is next due follows from that.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

// Days to wait after a review, indexed by streak. A card answered "again" drops to
// streak 0 and is due straight away.
export const CARD_INTERVAL_DAYS = [0, 1, 3, 7, 14, 30];
export const CARD_KNOWN_STREAK = 2;

export function summariseReviews(reviews, knownIds = null) {
  const rows = new Map();

  for (const review of reviews) {
    if (!review || typeof review.id !== 'string' || !review.id) continue;
    if (knownIds && !knownIds.has(review.id)) continue;

    const row = rows.get(review.id) ?? { id: review.id, streak: 0, lastTs: 0, reviewed: 0 };
    row.reviewed += 1;
    row.lastTs = typeof review.ts === 'number' ? review.ts : row.lastTs;
    row.streak = review.known === true ? row.streak + 1 : 0;
    rows.set(review.id, row);
  }

  return rows;
}

function dueAt(row) {
  const days = CARD_INTERVAL_DAYS[Math.min(row.streak, CARD_INTERVAL_DAYS.length - 1)];
  return row.lastTs + days * DAY_MS;
}

/**
 * Cards to show now: lapsed first, then never-seen, then the longest overdue.
 * A card is due once its interval has passed since the last review.
 */
export function dueCards(cards, reviews, now = Date.now()) {
  const rows = summariseReviews(reviews, new Set(cards.map((card) => card.id)));

  const due = [];
  for (const card of cards) {
    const row = rows.get(card.id);
    if (!row) {
      due.push({ card, rank: 1, overdue: 0 });
    } else if (now >= dueAt(row)) {
      due.push({ card, rank: row.streak === 0 ? 0 : 2, overdue: now - dueAt(row) });
    }
  }

  return due
    .sort((a, b) => a.rank - b.rank || b.overdue - a.overdue)
    .map((entry) => entry.card);
}

export function cardStats(cards, reviews, now = Date.now()) {
  const rows = summariseReviews(reviews, new Set(cards.map((card) => card.id)));
  let known = 0;
  for (const row of rows.values()) if (row.streak >= CARD_KNOWN_STREAK) known += 1;

  return {
    total: cards.length,
    seen: rows.size,
    known,
    due: dueCards(cards, reviews, now).length,
  };
}

function pageOf(source) {
  const match = /\d+/.exec(String(source ?? ''));
  return match ? Number(match[0]) : null;
}

/**
 * Index of the section a question belongs to. Section ids can repeat (the chapter
 * opener and the applying/tailoring figure both sit under "2"), so the question's
 * source page breaks the tie: the latest candidate that starts on or before it.
 */
export function findSectionIndex(chapter, question) {
  const sections = chapter?.sections ?? [];
  if (!sections.length) return -1;

  let candidates = sections
    .map((section, index) => ({ section, index }))
    .filter((entry) => entry.section.id === question.section);
  if (!candidates.length) candidates = sections.map((section, index) => ({ section, index }));

  const page = pageOf(question.source);
  if (page === null) return candidates[0].index;

  const started = candidates.filter((entry) => entry.section.page <= page);
  return (started.length ? started[started.length - 1] : candidates[0]).index;
}
