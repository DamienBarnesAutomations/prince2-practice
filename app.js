import { buildSession, scoreSession } from './bank-logic.js';
import { chapterProgress, missedIds, passMark } from './progress.js';
import { cardStats, dueCards, findSectionIndex } from './study-logic.js';

const STORAGE_KEY = 'prince2Practice.v1';
const CORRUPT_BACKUP_KEY = `${STORAGE_KEY}.corrupt`;
const COUNT_CHOICES = [10, 20, 30];
const EXAM_QUESTIONS = 60;
const EXAM_MINUTES = 60;
const LEAVE_EXAM_NOTICE =
  'Leaving abandons this paper and it will not be marked. Press Leave exam again to abandon, or carry on.';

const appEl = document.getElementById('app');

const state = {
  index: null,
  cache: new Map(),
  view: 'home',
  mode: null,
  selection: [],
  pool: [],
  poolLabel: '',
  config: { count: 20, hardOnly: false },
  session: null,
  position: 0,
  results: null,
  notice: '',
  pendingSubmit: false,
  pendingLeave: false,
  paletteOpen: true,
  loadError: '',
  knownIds: null,
  studyIndex: new Map(),
  studyCache: new Map(),
  studySet: null,
  studyFocus: null,
  studyData: null,
  studyReturn: null,
  deck: null,
  busy: false,
  storageOk: true,
  exam: { totalMs: EXAM_MINUTES * 60 * 1000, deadline: 0, remainingMs: 0 },
  timer: null,
};

const store = loadStore();

/* ------------------------------------------------------------------ storage */

function loadStore() {
  const empty = { version: 2, attempts: [], exams: [], read: {}, reviews: [] };

  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    state.storageOk = false;
    return empty;
  }
  if (!raw) return empty;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.attempts)) {
    return setAsideUnreadable(raw, empty);
  }

  // v1 stored nothing but attempts; the shape is still valid, so migrate in place.
  const attempts = Array.isArray(parsed?.attempts)
    ? parsed.attempts.filter((entry) => entry && typeof entry.id === 'string')
    : [];
  const exams = Array.isArray(parsed?.exams)
    ? parsed.exams.filter((entry) => entry && typeof entry.total === 'number')
    : [];

  // Study state is optional: stores written before the study side existed lack it.
  const read = parsed.read && typeof parsed.read === 'object' && !Array.isArray(parsed.read)
    ? Object.fromEntries(Object.entries(parsed.read).filter(([, ts]) => typeof ts === 'number'))
    : {};
  const reviews = Array.isArray(parsed.reviews)
    ? parsed.reviews.filter((entry) => entry && typeof entry.id === 'string')
    : [];

  return { version: 2, attempts, exams, read, reviews };
}

// Unreadable data must not be trusted, must not take the app down, and must not
// be overwritten by the next answer. It is copied aside first; if even that
// fails, saving is switched off so the original survives.
function setAsideUnreadable(raw, empty) {
  let keptAs = '';
  try {
    localStorage.setItem(CORRUPT_BACKUP_KEY, raw);
    keptAs = CORRUPT_BACKUP_KEY;
  } catch {
    state.storageOk = false;
  }
  return { ...empty, corrupt: true, keptAs };
}

function saveStore() {
  if (!state.storageOk) return false;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        version: 2,
        attempts: store.attempts,
        exams: store.exams,
        read: store.read,
        reviews: store.reviews,
      }),
    );
    return true;
  } catch {
    state.storageOk = false;
    return false;
  }
}

function recordAttempt(entry, mode) {
  store.attempts.push({
    id: entry.question.id,
    set: entry.question.set,
    section: entry.question.section,
    topic: entry.question.topic,
    correct: entry.selected === entry.correctIndex,
    mode,
    ts: Date.now(),
  });
  saveStore();
}

/* -------------------------------------------------------------------- assets */

async function fetchSet(meta) {
  const response = await fetch(`./${meta.file}`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Could not load ${meta.file} (HTTP ${response.status})`);

  const questions = await response.json();
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error(`${meta.file} contained no questions`);
  }
  return questions;
}

// The cache holds promises, so overlapping requests for a set share one fetch;
// a failed fetch is dropped so a retry actually retries.
function loadSet(setId) {
  if (!state.cache.has(setId)) {
    const meta = state.index.sets.find((entry) => entry.id === setId);
    if (!meta) return Promise.reject(new Error(`Unknown set "${setId}"`));
    state.cache.set(setId, fetchSet(meta).catch((error) => {
      state.cache.delete(setId);
      throw error;
    }));
  }
  return state.cache.get(setId);
}

// Ids that exist in the bank now. Until every set has loaded this stays null and
// progress counts everything stored, which is only wrong after a bank edit.
function learnKnownIds() {
  Promise.all(state.index.sets.map((meta) => loadSet(meta.id)))
    .then((sets) => {
      state.knownIds = new Set(sets.flat().map((question) => question.id));
      if (state.view === 'home') render();
    })
    .catch(() => {}); // offline or a bad file: the screens that need a set report it themselves
}

// The study notes are optional: a chapter without an entry in study/index.json simply
// has none, and a failed fetch of one chapter leaves the rest of the app working.
function loadStudy(setId) {
  const file = state.studyIndex.get(setId);
  if (!file) return Promise.reject(new Error(`No study notes for "${setId}"`));
  if (!state.studyCache.has(setId)) {
    state.studyCache.set(setId, fetch(`./${file}`, { cache: 'no-cache' })
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load ${file} (HTTP ${response.status})`);
        return response.json();
      })
      .catch((error) => {
        state.studyCache.delete(setId);
        throw error;
      }));
  }
  return state.studyCache.get(setId);
}

async function loadStudyIndex() {
  try {
    const response = await fetch('./study/index.json', { cache: 'no-cache' });
    if (!response.ok) return;
    const index = await response.json();
    for (const entry of index.chapters ?? []) state.studyIndex.set(entry.set, entry.file);
    if (state.view === 'home') render();
  } catch { /* no study notes available: the practice side is unaffected */ }
}

function recordReview(card, known) {
  store.reviews.push({ id: card.id, known, ts: Date.now() });
  saveStore();
}

async function gatherPool() {
  if (state.mode === 'missed') {
    const wanted = new Set(missedIds(store.attempts, state.knownIds));
    if (!wanted.size) return [];
    const sets = await Promise.all(state.index.sets.map((meta) => loadSet(meta.id)));
    return sets.flat().filter((question) => wanted.has(question.id));
  }

  const sets = await Promise.all(state.selection.map((setId) => loadSet(setId)));
  return sets.flat();
}

/* -------------------------------------------------------------------- helpers */

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setTitle(meta) {
  return meta.kind === 'appendix' ? meta.title.split(' — ')[1] : meta.title;
}

function setLabel(meta) {
  return meta.kind === 'appendix' ? meta.title.split(' — ')[0] : `Chapter ${meta.order}`;
}

function percentOf(part, whole) {
  if (!whole) return 0;
  return Math.round((part / whole) * 100);
}

function formatClock(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m ${totalSeconds % 60}s`;
}

function difficultyLabel(level) {
  return level === 3 ? 'Hard' : level === 2 ? 'Standard' : 'Recall';
}

function modeLabel(mode) {
  return {
    chapter: 'Practice by chapter',
    mixed: 'Mixed chapters',
    missed: 'Missed questions',
    exam: 'Exam',
    study: 'Study notes',
  }[mode] ?? 'Practice';
}

/* ------------------------------------------------------------------ recovery */

// A runtime fault is not a failed bank load. Say what happened on the screen the
// user is already on; only if that screen cannot draw, fall back to home.
function recover(error) {
  console.error(error);
  const notice = `Something went wrong: ${error.message}`;
  try {
    state.notice = notice;
    render();
  } catch (again) {
    console.error(again);
    abandonSession();
    state.view = 'home';
    state.notice = notice;
    history.replaceState({ view: 'home' }, '');
    render();
  }
}

// Wraps an event entry point so a throw, sync or async, reaches recover().
function safely(handler) {
  return (...args) => {
    try {
      const result = handler(...args);
      return result && typeof result.then === 'function' ? result.catch(recover) : result;
    } catch (error) {
      recover(error);
    }
  };
}

// Actions that wait on the network run one at a time, and say whether the user
// has navigated elsewhere while they waited.
let navEpoch = 0;

async function exclusive(task) {
  if (state.busy) return;
  state.busy = true;
  try {
    await task(navEpoch);
  } finally {
    state.busy = false;
  }
}

/* --------------------------------------------------------------------- clock */

function startClock() {
  stopClock();
  state.exam.deadline = Date.now() + state.exam.totalMs;
  state.timer = setInterval(safely(tickClock), 250);
  tickClock();
}

function stopClock() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

function tickClock() {
  const remaining = state.exam.deadline - Date.now();
  state.exam.remainingMs = Math.max(0, remaining);

  const node = document.getElementById('clock');
  if (node) node.textContent = formatClock(state.exam.remainingMs);

  if (remaining <= 0) {
    stopClock();
    submitSession({ auto: true });
  }
}

/* --------------------------------------------------------------------- render */

function render() {
  stopClockIfLeavingQuiz();

  if (state.loadError) {
    appEl.innerHTML = `
      <div class="banner"><strong>The question bank could not be loaded.</strong><br>${escapeHtml(state.loadError)}</div>
      <p class="footnote">This app needs to be served over HTTP — opening index.html directly from disk blocks the
      question files. Run <code>python -m http.server</code> in the repo root, or use the published site.</p>`;
    return;
  }

  const views = {
    home: viewHome,
    pick: viewPick,
    setup: viewSetup,
    examIntro: viewExamIntro,
    quiz: viewQuiz,
    results: viewResults,
    study: viewStudy,
    cards: viewCards,
  };

  // History entries outlive the page (reload, restart, abandoned paper), so a
  // restored view may name state that no longer exists. Show home instead of
  // rendering against nulls, and correct the entry so Back/Forward stay sane.
  if (!viewHasState(state.view)) {
    state.view = 'home';
    history.replaceState({ view: 'home' }, '');
  }

  const banner = state.notice && state.view !== 'quiz'
    ? `<p class="banner" role="status">${escapeHtml(state.notice)}</p>`
    : '';

  appEl.innerHTML = banner + (views[state.view] ?? viewHome)();
  appEl.focus({ preventScroll: true });

  if (state.view === 'study' && state.studyFocus !== null) {
    document.getElementById(`sec-${state.studyFocus}`)?.scrollIntoView?.();
    state.studyFocus = null;
  }
}

function viewHasState(view) {
  if (view === 'setup') return state.pool.length > 0;
  if (view === 'quiz') return state.session !== null;
  if (view === 'results') return state.results !== null && state.session !== null;
  if (view === 'study') return state.studySet !== null;
  if (view === 'cards') return state.deck !== null && state.studySet !== null;
  return true;
}

function stopClockIfLeavingQuiz() {
  if (state.view !== 'quiz' && state.timer) stopClock();
}

/* --------------------------------------------------------------------- routing */

// Each screen is a history entry so the browser's back control behaves like the
// in-app one. Re-renders within a screen (answering, moving between questions)
// deliberately do not push: back leaves the session rather than stepping
// through it.
function navigate(view, { replace = false } = {}) {
  navEpoch += 1;
  state.view = view;
  const entry = { view };
  if (replace) history.replaceState(entry, '');
  else history.pushState(entry, '');
  render();
}

// Abandoning keeps practice attempts already recorded; only the unasked
// questions are lost. An exam paper is discarded without being marked.
function abandonSession() {
  stopClock();
  state.session = null;
  state.results = null;
  state.position = 0;
  clearTransient();
}

// Messages and armed confirmations belong to one moment; any real action ends them.
function clearTransient() {
  state.pendingSubmit = false;
  state.pendingLeave = false;
  state.notice = '';
}

function goToQuestion(position) {
  state.position = position;
  clearTransient();
  render();
}

// Returns whether the answer was taken: marked questions are locked in practice.
function selectOption(index) {
  const entry = state.session[state.position];
  const exam = state.mode === 'exam';
  if (index >= entry.options.length) return false;
  if (!exam && entry.selected !== null) return false;

  entry.selected = index;
  clearTransient();
  if (!exam) recordAttempt(entry, state.mode);
  render();
  return true;
}

function backButton(action, label) {
  return `<p class="eyebrow"><button class="btn subtle" data-action="${action}" style="padding-left:0">← ${label}</button></p>`;
}

/* ---------------------------------------------------------------------- home */

function viewHome() {
  const { index } = state;
  const progress = chapterProgress(store.attempts, index.sets, state.knownIds);
  const missedCount = missedIds(store.attempts, state.knownIds).length;
  const expectedSets = index.expectedSets ?? index.sets.length;
  const lastExam = [...store.exams].reverse()[0];
  const overall = progress.overall;

  const chapterRows = progress.rows
    .map((row) => `
      <button class="chaprow" data-action="open-chapter" data-set="${escapeHtml(row.setId)}">
        <span class="chapname">${escapeHtml(row.title)}</span>
        <span class="chapprog">
          <span class="tallybar"><span style="width:${percentOf(row.exposed, row.total)}%"></span></span>
          <span class="chapnum">${row.exposed}/${row.total} seen</span>
        </span>
        <span class="chapnums">
          <span class="ok">${row.right} right</span>
          <span class="bad">${row.wrong} wrong</span>
          <span class="muted">${row.mastered} mastered</span>
          ${store.read[row.setId] ? '<span class="ok">notes read</span>' : ''}
        </span>
      </button>`)
    .join('');

  return `
    <header class="masthead">
      <div>
        <p class="eyebrow">PRINCE2 7 Foundation</p>
        <h1>Practice</h1>
      </div>
      <p class="bankstat">${index.total} questions · ${index.sets.length} of ${expectedSets} sets</p>
    </header>

    <div class="overall">
      <div class="overallhead">
        <span><strong>${overall.exposed}</strong> of ${overall.total} questions seen</span>
        <span class="footnote">${overall.right} right · ${overall.wrong} wrong · ${overall.mastered} mastered</span>
      </div>
      <div class="tallybar tall"><span style="width:${percentOf(overall.exposed, overall.total)}%"></span></div>
      ${lastExam ? `<p class="footnote">Last exam: ${lastExam.correct}/${lastExam.total} · ${lastExam.percent}% · ${lastExam.passed ? 'pass' : 'fail'}</p>` : ''}
    </div>

    <div class="modegrid">
      ${state.studyIndex.size ? `<button class="modecard" data-action="mode" data-mode="study">
        <span class="modetitle">Study notes</span>
        <span class="modedesc">Read a chapter, then recall it with flashcards.</span>
      </button>` : ''}
      <button class="modecard" data-action="mode" data-mode="chapter">
        <span class="modetitle">Practice by chapter</span>
        <span class="modedesc">One chapter, marked as you go.</span>
      </button>
      <button class="modecard" data-action="mode" data-mode="mixed">
        <span class="modetitle">Mixed chapters</span>
        <span class="modedesc">Choose several chapters and draw across them.</span>
      </button>
      <button class="modecard" data-action="mode" data-mode="exam">
        <span class="modetitle">Exam mode</span>
        <span class="modedesc">${EXAM_QUESTIONS} questions, ${EXAM_MINUTES} minutes, no feedback until the end.</span>
      </button>
      <button class="modecard" data-action="mode" data-mode="missed" ${missedCount === 0 ? 'disabled' : ''}>
        <span class="modetitle">Missed questions${missedCount ? ` (${missedCount})` : ''}</span>
        <span class="modedesc">${missedCount ? 'Cleared after two correct answers in a row.' : 'Nothing missed yet.'}</span>
      </button>
    </div>

    <h2 class="sectionhead">Progress by chapter</h2>
    <div class="chaplist">${chapterRows}</div>

    ${index.sets.length < expectedSets ? `<p class="footnote">Bank in progress: ${expectedSets - index.sets.length} sets not written yet.</p>` : ''}
    ${state.storageOk ? '' : '<p class="footnote">This browser blocked storage, so progress is not being saved.</p>'}
    ${store.corrupt ? `<p class="footnote">${store.keptAs
      ? `Saved progress could not be read, so this session starts fresh. The original is kept in this browser under "${escapeHtml(store.keptAs)}".`
      : 'Saved progress could not be read and could not be set aside, so nothing will be saved this session.'}</p>` : ''}
  `;
}

/* --------------------------------------------------------------------- study */

function viewStudy() {
  const chapter = state.studyData;
  const meta = state.index.sets.find((entry) => entry.id === state.studySet);
  const stats = cardStats(chapter.cards, store.reviews);
  const isRead = Boolean(store.read[state.studySet]);

  const sections = chapter.sections
    .map((section, index) => `
      <section class="card studysec" id="sec-${index}">
        <div class="metaline">
          <span class="tag">${escapeHtml(section.id)}</span>
          <span class="tag">book p.${section.page}</span>
        </div>
        <h2 class="studyhead">${escapeHtml(section.heading)}</h2>
        ${section.keyMessage ? `<p class="keymsg">${escapeHtml(section.keyMessage)}</p>` : ''}
        <ul class="points">${section.points.map((point) => `<li>${escapeHtml(point)}</li>`).join('')}</ul>
      </section>`)
    .join('');

  const terms = chapter.terms?.length
    ? `<section class="card studysec">
        <h2 class="studyhead">Definitions to know</h2>
        <dl class="terms">${chapter.terms
          .map((entry) => `<dt>${escapeHtml(entry.term)} <span class="footnote">p.${entry.page}</span></dt><dd>${escapeHtml(entry.definition)}</dd>`)
          .join('')}</dl>
      </section>`
    : '';

  return `
    ${state.studyReturn === 'quiz' ? backButton('back-to-quiz', 'Back to questions') : backButton('study-pick', 'Study notes')}
    <p class="eyebrow">${escapeHtml(setLabel(meta))} · ${escapeHtml(chapter.pages)}</p>
    <h1>${escapeHtml(chapter.title)}</h1>
    <p class="lede">${escapeHtml(chapter.overview)}</p>

    <div class="btnrow">
      <button class="btn" data-action="start-cards">Flashcards${stats.due ? ` (${stats.due} due)` : ''}</button>
      <button class="btn ghost" data-action="practice-from-study">Practice questions</button>
      <button class="btn ghost" data-action="mark-read">${isRead ? 'Marked as read ✓' : 'Mark as read'}</button>
    </div>
    <p class="footnote">${stats.known} of ${stats.total} cards known · ${stats.seen} seen. Page numbers are as printed in the manual.</p>

    ${sections}
    ${terms}

    <div class="btnrow">
      <button class="btn" data-action="start-cards">Flashcards${stats.due ? ` (${stats.due} due)` : ''}</button>
      <button class="btn ghost" data-action="mark-read">${isRead ? 'Marked as read ✓' : 'Mark as read'}</button>
    </div>
  `;
}

function viewCards() {
  const deck = state.deck;
  const chapter = state.studyData;
  const total = deck.queue.length;
  const back = backButton('back-to-notes', 'Notes');

  if (deck.position >= total) {
    const stats = cardStats(chapter.cards, store.reviews);
    return `
      ${back}
      <h1>Round complete</h1>
      <p class="lede">${deck.known} known, ${deck.again} to see again. ${stats.known} of ${stats.total} cards in this chapter are known (two in a row).</p>
      <div class="btnrow">
        ${stats.due ? '<button class="btn" data-action="start-cards">Review what is due now</button>' : ''}
        <button class="btn ghost" data-action="practice-from-study">Practice questions</button>
        <button class="btn ghost" data-action="back-to-notes">Back to notes</button>
      </div>`;
  }

  const card = deck.queue[deck.position];
  return `
    ${back}
    <div class="quizbar">
      <span>Card ${deck.position + 1} of ${total}</span>
      <div class="progress"><span style="width:${((deck.position + 1) / total) * 100}%"></span></div>
      <span>${deck.known} known</span>
    </div>

    <div class="card flashcard">
      <p class="eyebrow">Question</p>
      <h2 class="stem">${escapeHtml(card.front)}</h2>
      ${deck.revealed
        ? `<div class="feedback good">
             <p class="fbhead">Answer</p>
             <p>${escapeHtml(card.back)}</p>
             <p class="footnote">Book p.${card.page}</p>
           </div>
           <div class="btnrow">
             <button class="btn ghost" data-action="card-again">Again <span class="footnote">(1)</span></button>
             <button class="btn" data-action="card-known">Got it <span class="footnote">(2)</span></button>
           </div>`
        : `<div class="btnrow"><button class="btn" data-action="reveal">Show answer</button></div>`}
    </div>
    <p class="footnote" style="margin-top:12px">Say the answer first, then check. Space to show · 1 again · 2 got it</p>
  `;
}

/* ---------------------------------------------------------------------- pick */

function viewPick() {
  const mixed = state.mode === 'mixed';
  const study = state.mode === 'study';
  const progress = chapterProgress(store.attempts, state.index.sets, state.knownIds);

  const rows = progress.rows
    .filter((row) => !study || state.studyIndex.has(row.setId))
    .map((row) => {
      const meta = state.index.sets.find((entry) => entry.id === row.setId);
      const checked = state.selection.includes(row.setId);
      return `
        <button class="pickrow${checked ? ' checked' : ''}" data-action="${mixed ? 'toggle-set' : study ? 'study-set' : 'pick-set'}" data-set="${escapeHtml(row.setId)}">
          <span class="pickbox" aria-hidden="true">${checked ? '✓' : ''}</span>
          <span class="pickbody">
            <span class="picktitle">${escapeHtml(setTitle(meta))}</span>
            <span class="pickmeta">${escapeHtml(setLabel(meta))} · ${study
              ? (store.read[row.setId] ? 'notes read' : 'not read yet')
              : `${row.total} questions · ${row.exposed} seen`}</span>
          </span>
        </button>`;
    })
    .join('');

  return `
    ${backButton('home', 'Practice')}
    <h1>${mixed ? 'Mixed chapters' : study ? 'Study notes' : 'Practice by chapter'}</h1>
    <p class="lede">${mixed
      ? 'Tick the chapters you want. Questions are drawn across all of them.'
      : study ? 'Pick a chapter to read. Page numbers are the ones printed in the manual.' : 'Pick a chapter to drill.'}</p>

    <div class="chaplist">${rows}</div>

    ${mixed ? `<div class="btnrow">
      <button class="btn" data-action="mixed-continue" ${state.selection.length === 0 ? 'disabled' : ''}>
        Continue${state.selection.length ? ` with ${state.selection.length} chapter${state.selection.length === 1 ? '' : 's'}` : ''}
      </button>
    </div>` : ''}
  `;
}

/* --------------------------------------------------------------------- setup */

function viewSetup() {
  const pool = state.pool;
  const hardAvailable = pool.filter((question) => question.difficulty === 3).length;

  const choices = COUNT_CHOICES.filter((count) => count < pool.length)
    .concat(pool.length)
    .map((count) => {
      const pressed = state.config.count === count ? 'aria-pressed="true"' : 'aria-pressed="false"';
      return `<button data-action="set-count" data-count="${count}" ${pressed}>${count === pool.length ? `All ${count}` : count}</button>`;
    })
    .join('');

  return `
    ${backButton('back-from-setup', 'Back')}
    <h1>${escapeHtml(state.poolLabel)}</h1>
    <p class="lede">${pool.length} question${pool.length === 1 ? '' : 's'} available.
      ${state.mode === 'missed' ? 'A question leaves this list once you answer it correctly twice in a row.' : 'Marked as you go, with the reason shown.'}</p>

    <div class="card">
      <div class="field">
        <span class="label">How many questions</span>
        <div class="segmented">${choices}</div>
      </div>

      <div class="field">
        <span class="label">Difficulty</span>
        <label class="checkline">
          <input type="checkbox" data-action="toggle-hard" ${state.config.hardOnly ? 'checked' : ''} ${hardAvailable === 0 ? 'disabled' : ''}>
          <span>Hard questions only${hardAvailable > 0 ? ` (${hardAvailable} available)` : ' (none in this selection)'}
            <span class="hint">Questions that chain two facts or ask you to apply the method to a situation.</span>
          </span>
        </label>
      </div>

      <div class="btnrow">
        <button class="btn" data-action="start">Start</button>
      </div>
    </div>
  `;
}

/* ---------------------------------------------------------------- exam intro */

function viewExamIntro() {
  const available = state.index.total;
  const total = Math.min(EXAM_QUESTIONS, available);
  const short = total < EXAM_QUESTIONS;

  return `
    ${backButton('home', 'Practice')}
    <h1>Exam mode</h1>
    <p class="lede">The real paper, as closely as the bank currently allows. No feedback of any kind until you submit.</p>

    <div class="card">
      <div class="facts">
        <div><span>Questions</span><b>${total}</b></div>
        <div><span>Time</span><b>${EXAM_MINUTES} minutes</b></div>
        <div><span>Pass mark</span><b>${passMark(total)} / ${total}</b></div>
        <div><span>Feedback</span><b>After submit only</b></div>
      </div>
      ${short ? `<p class="footnote" style="margin-top:14px">The bank holds ${available} questions, so this paper is ${total} long rather than ${EXAM_QUESTIONS}.
        It becomes a full ${EXAM_QUESTIONS}-question paper once more chapters are written.</p>` : ''}
      <div class="btnrow">
        <button class="btn" data-action="start-exam">Start exam</button>
      </div>
    </div>
  `;
}

/* ---------------------------------------------------------------------- quiz */

function viewQuiz() {
  const exam = state.mode === 'exam';
  const total = state.session.length;
  const entry = state.session[state.position];
  const question = entry.question;
  const answered = state.session.filter((item) => item.selected !== null).length;
  const isLast = state.position === total - 1;
  const revealed = !exam && entry.selected !== null;
  const isRight = entry.selected === entry.correctIndex;

  const options = entry.options
    .map((option, index) => {
      const classes = ['option'];
      let mark = '';
      if (revealed) {
        classes.push('locked');
        if (index === entry.correctIndex) {
          classes.push('correct');
          mark = '<span class="optmark">✓</span>';
        } else if (index === entry.selected) {
          classes.push('wrong');
          mark = '<span class="optmark">✗</span>';
        }
      } else if (entry.selected === index) {
        classes.push('selected');
      }
      return `
        <li>
          <button class="${classes.join(' ')}" data-action="answer" data-index="${index}"
                  aria-pressed="${entry.selected === index}">
            <span class="key">${index + 1}</span>
            <span class="text">${escapeHtml(option)}</span>
            ${mark}
          </button>
        </li>`;
    })
    .join('');

  const feedback = revealed
    ? `<div class="feedback ${isRight ? 'good' : 'bad'}">
         <p class="fbhead">${isRight ? 'Correct' : 'Not quite'}</p>
         <p>${escapeHtml(question.explanation)}</p>
         <p class="footnote">Source: ${escapeHtml(question.source)}</p>
         ${!isRight && state.studyIndex.has(question.set)
           ? `<p><button class="btn ghost tiny" data-action="open-study" data-set="${escapeHtml(question.set)}"
                data-section="${escapeHtml(question.section)}" data-source="${escapeHtml(question.source)}">Reread this in the notes (${escapeHtml(question.source)})</button></p>`
           : ''}
       </div>`
    : '';

  const palette = exam
    ? `<div class="palette">
        ${state.session
          .map((item, index) => {
            const classes = ['pal'];
            if (index === state.position) classes.push('current');
            if (item.selected !== null) classes.push('done');
            if (item.flagged) classes.push('flagged');
            return `<button class="${classes.join(' ')}" data-action="goto" data-index="${index}">${index + 1}</button>`;
          })
          .join('')}
      </div>`
    : '';

  const timer = exam
    ? `<span class="clock" id="clock">${formatClock(state.exam.remainingMs || state.exam.totalMs)}</span>`
    : `<span>${answered} answered</span>`;

  return `
    ${backButton('leave', exam ? 'Leave exam' : 'Practice')}

    <div class="quizbar">
      <span>Question ${state.position + 1} of ${total}</span>
      <div class="progress"><span style="width:${((state.position + 1) / total) * 100}%"></span></div>
      ${timer}
    </div>

    <div class="card">
      <div class="metaline">
        <span class="tag">${escapeHtml(question.section)}</span>
        <span class="tag">${escapeHtml(question.topic)}</span>
        <span class="tag${question.difficulty === 3 ? ' hard' : ''}">${difficultyLabel(question.difficulty)}</span>
        ${entry.flagged ? '<span class="tag flagged">Flagged</span>' : ''}
      </div>

      <h2 class="stem">${escapeHtml(question.stem)}</h2>

      <ul class="options">${options}</ul>

      ${feedback}

      ${state.notice ? `<p class="banner" style="margin-top:18px">${escapeHtml(state.notice)}</p>` : ''}

      <div class="quizfoot">
        ${exam
          ? `<div class="footleft">
               <button class="btn ghost tiny" data-action="flag">${entry.flagged ? 'Unflag' : 'Flag for review'}</button>
               <button class="btn ghost tiny" data-action="submit">Submit paper</button>
             </div>`
          : `<span class="footnote">${answered} of ${total} answered</span>`}
        <div class="nav">
          <button class="btn ghost tiny" data-action="prev" ${state.position === 0 ? 'disabled' : ''}>Back</button>
          <button class="btn" data-action="${isLast ? 'submit' : 'next'}">
            ${isLast ? (state.pendingSubmit ? 'Submit anyway' : exam ? 'Submit paper' : 'See results') : 'Next'}
          </button>
        </div>
      </div>
      ${isLast && total - answered > 0 ? `<p class="unanswered-note">${total - answered} unanswered — unanswered counts as wrong.</p>` : ''}
    </div>

    ${palette}

    <p class="footnote" style="margin-top:12px">Keys: 1–4 to answer${exam ? ' · F to flag' : ''} · ← → to move · Enter to advance</p>
  `;
}

/* ------------------------------------------------------------------- results */

function viewResults() {
  const exam = state.mode === 'exam';
  const { results, session } = state;
  const target = passMark(results.total);
  const passed = results.correct >= target;

  const sections = results.bySection
    .map((row) => {
      const percent = percentOf(row.correct, row.total);
      return `
        <div class="tallyrow${percent < 60 ? ' weak' : ''}">
          <span class="tlabel">${escapeHtml(row.section)}</span>
          <span class="tallybar"><span style="width:${percent}%"></span></span>
          <span class="tnum">${row.correct}/${row.total}</span>
        </div>`;
    })
    .join('');

  const review = session
    .map((entry, index) => {
      const question = entry.question;
      const right = entry.selected === entry.correctIndex;
      const lines = entry.options
        .map((option, optionIndex) => {
          const classes = ['rline'];
          let mark = '';
          if (optionIndex === entry.correctIndex) {
            classes.push('correct');
            mark = '✓';
          } else if (optionIndex === entry.selected) {
            classes.push('chosen-wrong');
            mark = '✗';
          }
          return `<div class="${classes.join(' ')}"><span class="mark">${mark}</span><span>${escapeHtml(option)}</span></div>`;
        })
        .join('');

      const yourAnswer = entry.selected === null
        ? 'Not answered.'
        : `You chose: ${escapeHtml(entry.options[entry.selected])}`;

      return `
        <details class="reviewitem${right ? ' right' : ''}" ${right ? '' : 'open'}>
          <summary>
            <span class="rhead">
              <span class="tag">${index + 1}</span>
              <span class="tag">${escapeHtml(question.section)}</span>
              <span class="tag">${escapeHtml(question.topic)}</span>
              <span class="tag${right ? '' : ' hard'}">${right ? 'Correct' : 'Missed'}</span>
            </span>
            <span class="rstem">${escapeHtml(question.stem)}</span>
          </summary>
          ${lines}
          <p class="why"><b>${yourAnswer}</b><br>${escapeHtml(question.explanation)}</p>
          <p class="footnote">Source: ${escapeHtml(question.source)}</p>
        </details>`;
    })
    .join('');

  const headline = exam
    ? `<h1 class="${passed ? 'pass' : 'fail'}">${passed ? 'Pass' : 'Fail'} — ${results.correct}/${results.total}</h1>
       <p class="verdict">Pass mark ${target}. You answered ${results.correct} correctly in ${formatDuration(state.exam.usedMs ?? 0)}.</p>`
    : `<h1>${results.correct} of ${results.total}</h1>
       <p class="verdict">${results.percent >= 60 ? 'At or above the real Foundation pass mark (60%).' : 'Below the real Foundation pass mark (60%).'}</p>`;

  return `
    <div class="card">
      <div class="scorehead">
        <div class="scorecircle" style="--pct:${results.percent}"><b>${results.percent}%</b></div>
        <div>${headline}${state.storageOk ? '' : '<p class="verdict">This browser blocked storage, so this result was not saved.</p>'}</div>
      </div>
      <div class="tally">${sections}</div>
    </div>

    <div class="btnrow">
      ${exam
        ? '<button class="btn" data-action="home">Done</button>'
        : `<button class="btn" data-action="restart">Another set of questions</button>
           ${results.missed.length > 0 ? `<button class="btn ghost" data-action="drill-results-missed">Drill these ${results.missed.length} again</button>` : ''}
           <button class="btn ghost" data-action="home">Practice</button>`}
    </div>

    <div class="review">
      <h2>Review</h2>
      <p class="footnote" style="margin-bottom:14px">Missed questions are open; correct ones are collapsed.</p>
      ${review}
    </div>
  `;
}

/* ------------------------------------------------------------------- actions */

async function openPool(label, epoch) {
  state.notice = '';
  const pool = await gatherPool();
  if (epoch !== navEpoch) return; // the user moved on while the files loaded

  state.poolLabel = label;
  state.pool = pool;
  state.config.hardOnly = false;

  if (state.pool.length === 0) {
    state.notice = 'No questions match that selection.';
    navigate('home');
    return;
  }

  state.config.count = Math.min(state.config.count, state.pool.length);
  navigate('setup');
}

function startSession(pool, count) {
  state.session = buildSession(pool, count);
  state.position = 0;
  clearTransient();

  if (state.mode === 'exam') {
    startClock();
  }
  navigate('quiz');
}

function gradeCard(known) {
  const deck = state.deck;
  if (!deck.revealed || deck.position >= deck.queue.length) return;

  recordReview(deck.queue[deck.position], known);
  if (known) deck.known += 1;
  else deck.again += 1;
  deck.position += 1;
  deck.revealed = false;
  render();
}

function submitSession({ auto = false } = {}) {
  const unanswered = state.session.filter((entry) => entry.selected === null).length;

  if (!auto && unanswered > 0 && !state.pendingSubmit) {
    state.pendingSubmit = true;
    state.notice = `${unanswered} question${unanswered === 1 ? '' : 's'} still unanswered. Press submit again to mark anyway, or go back.`;
    render();
    return;
  }

  if (state.mode === 'exam') {
    stopClock();
    const usedMs = Math.max(0, state.exam.totalMs - state.exam.remainingMs);
    for (const entry of state.session) recordAttempt(entry, 'exam');

    const results = scoreSession(state.session);
    store.exams.push({
      ts: Date.now(),
      total: results.total,
      correct: results.correct,
      percent: results.percent,
      passed: results.correct >= passMark(results.total),
      durationMs: usedMs,
    });
    saveStore();

    state.exam.usedMs = usedMs;
    state.results = results;
  } else {
    state.results = scoreSession(state.session);
  }

  clearTransient();
  // A finished paper must not be reachable by pressing back, so the results
  // screen takes the place of the quiz entry rather than stacking on top of it.
  navigate('results', { replace: true });
}

function answeredPool() {
  return state.config.hardOnly
    ? state.pool.filter((question) => question.difficulty === 3)
    : state.pool;
}

appEl.addEventListener('click', safely(async (event) => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const action = trigger.dataset.action;

  switch (action) {
    case 'home':
      state.notice = '';
      navigate('home');
      break;

    case 'leave':
      if (state.mode === 'exam' && !state.pendingLeave) {
        state.pendingLeave = true;
        state.notice = LEAVE_EXAM_NOTICE;
        render();
        break;
      }
      abandonSession();
      navigate('home', { replace: true });
      break;

    case 'study-set':
    case 'open-study':
      await exclusive(async (epoch) => {
        const setId = trigger.dataset.set;
        const chapter = await loadStudy(setId);
        if (epoch !== navEpoch) return;

        state.studySet = setId;
        state.studyData = chapter;
        state.deck = null;
        state.notice = '';

        if (action === 'open-study') {
          state.studyReturn = 'quiz';
          const focus = findSectionIndex(chapter, {
            section: trigger.dataset.section,
            source: trigger.dataset.source,
          });
          state.studyFocus = focus < 0 ? null : focus;
        } else {
          state.studyReturn = null;
          state.studyFocus = null;
        }
        navigate('study');
      });
      break;

    case 'study-pick':
      navigate('pick');
      break;

    case 'back-to-quiz':
      state.studyReturn = null;
      navigate('quiz');
      break;

    case 'back-to-notes':
      navigate('study');
      break;

    case 'mark-read':
      if (store.read[state.studySet]) delete store.read[state.studySet];
      else store.read[state.studySet] = Date.now();
      saveStore();
      render();
      break;

    case 'practice-from-study':
      await exclusive((epoch) => {
        state.mode = 'chapter';
        state.studyReturn = null;
        state.selection = [state.studySet];
        return openPool(setTitle(state.index.sets.find((entry) => entry.id === state.studySet)), epoch);
      });
      break;

    case 'start-cards': {
      const queue = dueCards(state.studyData.cards, store.reviews);
      if (queue.length === 0) {
        state.notice = 'No cards are due right now. They come back as their review intervals pass.';
        render();
        break;
      }
      state.deck = { queue, position: 0, revealed: false, known: 0, again: 0 };
      state.notice = '';
      navigate('cards');
      break;
    }

    case 'reveal':
      state.deck.revealed = true;
      render();
      break;

    case 'card-known':
    case 'card-again':
      gradeCard(action === 'card-known');
      break;

    case 'mode':
      state.mode = trigger.dataset.mode;
      state.selection = [];
      state.notice = '';

      if (state.mode === 'chapter' || state.mode === 'mixed' || state.mode === 'study') {
        navigate('pick');
      } else if (state.mode === 'exam') {
        navigate('examIntro');
      } else {
        await exclusive((epoch) => openPool('Missed questions', epoch));
      }
      break;

    case 'pick-set':
    case 'open-chapter':
      await exclusive((epoch) => {
        if (action === 'open-chapter') state.mode = 'chapter';
        state.selection = [trigger.dataset.set];
        return openPool(setTitle(state.index.sets.find((entry) => entry.id === trigger.dataset.set)), epoch);
      });
      break;

    case 'toggle-set': {
      const setId = trigger.dataset.set;
      state.selection = state.selection.includes(setId)
        ? state.selection.filter((id) => id !== setId)
        : [...state.selection, setId];
      render();
      break;
    }

    case 'mixed-continue':
      await exclusive((epoch) => openPool('Mixed chapters', epoch));
      break;

    case 'back-from-setup':
      navigate(state.mode === 'missed' ? 'home' : 'pick');
      break;

    case 'set-count':
      state.config.count = Number(trigger.dataset.count);
      render();
      break;

    case 'toggle-hard':
      state.config.hardOnly = !state.config.hardOnly;
      render();
      break;

    case 'start': {
      const pool = answeredPool();
      if (pool.length === 0) {
        state.notice = 'No questions match that filter.';
        render();
        break;
      }
      startSession(pool, Math.min(state.config.count, pool.length));
      break;
    }

    case 'start-exam':
      await exclusive(async (epoch) => {
        state.selection = state.index.sets.map((entry) => entry.id);
        const pool = await gatherPool();
        if (epoch !== navEpoch) return;
        state.pool = pool;
        state.notice = '';
        startSession(pool, Math.min(EXAM_QUESTIONS, pool.length));
      });
      break;

    case 'answer':
      selectOption(Number(trigger.dataset.index));
      break;

    case 'flag': {
      const entry = state.session[state.position];
      entry.flagged = !entry.flagged;
      render();
      break;
    }

    case 'goto':
      goToQuestion(Number(trigger.dataset.index));
      break;

    case 'next':
      if (state.position < state.session.length - 1) goToQuestion(state.position + 1);
      break;

    case 'prev':
      if (state.position > 0) goToQuestion(state.position - 1);
      break;

    case 'submit':
      submitSession();
      break;

    case 'restart': {
      const pool = answeredPool();
      startSession(pool, Math.min(state.config.count, pool.length));
      break;
    }

    case 'drill-results-missed': {
      const wanted = new Set(state.results.missed);
      const pool = state.session
        .filter((entry) => wanted.has(entry.question.id))
        .map((entry) => entry.question);
      state.mode = 'missed';
      state.pool = pool;
      state.poolLabel = 'Missed questions';
      state.config.count = pool.length;
      startSession(pool, pool.length);
      break;
    }

    default:
      break;
  }
}));

document.addEventListener('keydown', safely((event) => {
  if (state.view !== 'quiz' && state.view !== 'cards') return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  if (state.view === 'cards') {
    const deck = state.deck;
    if (!deck || deck.position >= deck.queue.length) return;
    if (event.key === ' ' || event.key === 'Enter') {
      if (event.target.closest?.('button, a, summary, select')) return;
      event.preventDefault();
      if (!deck.revealed) {
        deck.revealed = true;
        render();
      }
    } else if (deck.revealed && (event.key === '1' || event.key === '2')) {
      event.preventDefault();
      gradeCard(event.key === '2');
    }
    return;
  }

  // Enter on a focused control activates that control; it is not 'next question'.
  if (event.key === 'Enter' && event.target.closest?.('button, a, summary, select')) return;

  const entry = state.session[state.position];
  const exam = state.mode === 'exam';

  if (event.key >= '1' && event.key <= '4') {
    if (selectOption(Number(event.key) - 1)) event.preventDefault();
    return;
  }

  if (event.key === 'f' || event.key === 'F') {
    if (!exam) return;
    event.preventDefault();
    entry.flagged = !entry.flagged;
    render();
    return;
  }

  if (event.key === 'ArrowRight' || event.key === 'Enter') {
    event.preventDefault();
    if (state.position < state.session.length - 1) goToQuestion(state.position + 1);
    else submitSession();
    return;
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (state.position > 0) goToQuestion(state.position - 1);
  }
}));

window.addEventListener('popstate', safely((event) => {
  if (!state.index) return; // still booting; boot() renders once the bank is in
  const target = event.state?.view ?? 'home';

  // Back would discard a live exam paper, so it asks once rather than obeying.
  // Pushing the entry back restores the position the browser just left.
  if (state.view === 'quiz' && state.mode === 'exam' && !state.pendingLeave) {
    state.pendingLeave = true;
    state.notice = LEAVE_EXAM_NOTICE;
    history.pushState({ view: 'quiz' }, '');
    render();
    return;
  }

  if (state.view === 'quiz' && target !== 'quiz') abandonSession();

  navEpoch += 1;
  state.notice = '';
  state.view = target;
  render();
}));

/* ----------------------------------------------------------------- bootstrap */

async function boot() {
  try {
    const response = await fetch('./bank/index.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not load bank/index.json (HTTP ${response.status})`);
    state.index = await response.json();
    if (!Array.isArray(state.index.sets) || state.index.sets.length === 0) {
      throw new Error('bank/index.json lists no sets');
    }
  } catch (error) {
    state.loadError = error.message;
    render();
    return;
  }

  // history.state survives a reload but the session behind it does not, so the
  // page always starts as a fresh home entry.
  history.replaceState({ view: 'home' }, '');
  render();
  learnKnownIds();
  loadStudyIndex();
}

boot();
