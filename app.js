import { buildSession, scoreSession, deriveMissed } from './bank-logic.js';

const STORAGE_KEY = 'prince2Practice.v1';
const COUNT_CHOICES = [10, 20, 30];

const appEl = document.getElementById('app');

const state = {
  index: null,
  cache: new Map(),
  questionCount: 0,
  config: { setId: null, count: 20, hardOnly: false },
  session: null,
  results: null,
  view: 'home',
  position: 0,
  pendingSubmit: false,
  notice: '',
  storageOk: true,
  loadError: '',
  bank: null,
};

const store = loadStore();

/* ------------------------------------------------------------------ storage */

function loadStore() {
  const empty = { attempts: [] };
  let raw;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    state.storageOk = false;
    return empty;
  }
  if (!raw) return empty;
  try {
    const parsed = JSON.parse(raw);
    return { attempts: Array.isArray(parsed?.attempts) ? parsed.attempts : [] };
  } catch {
    // A corrupt key must not take the app down, but it must not be silently
    // trusted either: start clean and let the caller notice via storageNotice().
    return { ...empty, corrupt: true };
  }
}

function saveStore() {
  if (!state.storageOk) return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ attempts: store.attempts }));
    return true;
  } catch {
    state.storageOk = false;
    return false;
  }
}

/* -------------------------------------------------------------------- assets */

async function loadSet(setId) {
  if (state.cache.has(setId)) return state.cache.get(setId);
  const meta = state.index.sets.find((entry) => entry.id === setId);
  if (!meta) throw new Error(`Unknown set "${setId}"`);

  const response = await fetch(`./${meta.file}`, { cache: 'no-cache' });
  if (!response.ok) {
    throw new Error(`Could not load ${meta.file} (HTTP ${response.status})`);
  }
  const questions = await response.json();
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error(`${meta.file} contained no questions`);
  }
  state.cache.set(setId, questions);
  return questions;
}

async function loadMissed() {
  const missedIds = new Set(deriveMissed(store.attempts));
  if (missedIds.size === 0) return [];

  const bySet = new Map();
  for (const attempt of store.attempts) {
    if (!missedIds.has(attempt.id) || !attempt.set) continue;
    if (!bySet.has(attempt.set)) bySet.set(attempt.set, new Set());
    bySet.get(attempt.set).add(attempt.id);
  }

  const pool = [];
  for (const [setId, ids] of bySet) {
    let questions;
    try {
      questions = await loadSet(setId);
    } catch {
      continue;
    }
    pool.push(...questions.filter((question) => ids.has(question.id)));
  }
  return pool;
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

function setLabel(meta) {
  return meta.kind === 'appendix' ? meta.title.split(' — ')[0] : `Chapter ${meta.order}`;
}

function setTitle(meta) {
  return meta.kind === 'appendix' ? meta.title.split(' — ')[1] : meta.title;
}

function attemptsFor(setId) {
  return store.attempts.filter((attempt) => attempt.set === setId);
}

function difficultyLabel(level) {
  return level === 3 ? 'Hard' : level === 2 ? 'Standard' : 'Recall';
}

function setHash(view, data) {
  const params = new URLSearchParams({ view, ...data });
  history.replaceState(null, '', `#${params.toString()}`);
}

/* --------------------------------------------------------------------- render */

function render() {
  if (state.loadError) {
    appEl.innerHTML = `
      <div class="banner"><strong>The question bank could not be loaded.</strong><br>${escapeHtml(state.loadError)}</div>
      <p class="footnote">This app needs to be served over HTTP — opening index.html directly from disk blocks the
      question files. Run <code>python -m http.server</code> in the repo root, or use the published site.</p>`;
    return;
  }

  switch (state.view) {
    case 'setup':
      appEl.innerHTML = viewSetup();
      break;
    case 'quiz':
      appEl.innerHTML = viewQuiz();
      break;
    case 'results':
      appEl.innerHTML = viewResults();
      break;
    default:
      appEl.innerHTML = viewHome();
  }
  appEl.focus({ preventScroll: true });
}

function viewHome() {
  const { index } = state;
  const missedCount = deriveMissed(store.attempts).length;
  const seen = new Set(store.attempts.map((attempt) => attempt.id)).size;

  const tiles = index.sets
    .map((meta) => {
      const latest = new Map();
      for (const attempt of attemptsFor(meta.id)) {
        const seen = latest.get(attempt.id);
        if (!seen || attempt.ts >= seen.ts) latest.set(attempt.id, attempt);
      }
      const right = [...latest.values()].filter((attempt) => attempt.correct).length;
      const stat = latest.size === 0
        ? `${meta.count} questions`
        : `${meta.count} questions · ${latest.size} seen · ${right} right`;
      return `
        <button class="settile" data-action="open-set" data-set="${escapeHtml(meta.id)}">
          <span class="setmeta">${escapeHtml(setLabel(meta))}</span>
          <span class="setname">${escapeHtml(setTitle(meta))}</span>
          <span class="setmeta">${escapeHtml(stat)}</span>
        </button>`;
    })
    .join('');

  return `
    <header class="masthead">
      <div>
        <p class="eyebrow">PRINCE2 7 Foundation</p>
        <h1>Practice by chapter</h1>
      </div>
      <p class="bankstat">${index.total} questions · ${index.sets.length} of 21 sets</p>
    </header>

    <p class="lede">Every question is drawn from a larger option pool, so the four answers you see change
    between attempts. Nothing is marked until you finish.</p>

    ${missedCount > 0 ? `
      <div class="btnrow">
        <button class="btn" data-action="drill-missed">Drill ${missedCount} missed question${missedCount === 1 ? '' : 's'}</button>
        <span class="footnote">${seen} of ${index.total} questions attempted so far.</span>
      </div>` : ''}

    <div class="setgrid">${tiles}</div>

    ${index.sets.length < 21 ? `<p class="footnote">Bank in progress: ${21 - index.sets.length} sets not written yet.
    The app stays usable as each chapter lands.</p>` : ''}
  `;
}

function viewSetup() {
  const meta = state.index.sets.find((entry) => entry.id === state.config.setId);
  const questions = state.bank;
  const hardAvailable = questions.filter((question) => question.difficulty === 3).length;

  const counts = COUNT_CHOICES.filter((count) => count < questions.length)
    .concat(questions.length)
    .map((count) => {
      const pressed = state.config.count === count ? 'aria-pressed="true"' : 'aria-pressed="false"';
      const label = count === questions.length ? `All ${count}` : String(count);
      return `<button data-action="set-count" data-count="${count}" ${pressed}>${label}</button>`;
    })
    .join('');

  return `
    <p class="eyebrow"><button class="btn subtle" data-action="home" style="padding-left:0">← All chapters</button></p>
    <h1>${escapeHtml(setTitle(meta))}</h1>
    <p class="lede">${escapeHtml(setLabel(meta))} · ${questions.length} questions in the bank.</p>

    <div class="card">
      <div class="field">
        <span class="label">How many questions</span>
        <div class="segmented">${counts}</div>
      </div>

      <div class="field">
        <span class="label">Difficulty</span>
        <label class="checkline">
          <input type="checkbox" data-action="toggle-hard" ${state.config.hardOnly ? 'checked' : ''}>
          <span>Hard questions only${hardAvailable > 0 ? ` (${hardAvailable} available)` : ' (none in this set)'}
            <span class="hint">Multi-step questions that chain two facts or ask you to apply the method to a situation.</span>
          </span>
        </label>
      </div>

      <div class="btnrow">
        <button class="btn" data-action="start-drill">Start</button>
        <span class="footnote">No feedback until you submit. Options are shuffled.</span>
      </div>
    </div>
  `;
}

function viewQuiz() {
  const { session, position, config } = state;
  const entry = session[position];
  const total = session.length;
  const answered = session.filter((item) => item.selected !== null).length;
  const isLast = position === total - 1;
  const question = entry.question;

  const options = entry.options
    .map((option, index) => `
      <li>
        <button class="option" data-action="answer" data-index="${index}"
                aria-pressed="${entry.selected === index}">
          <span class="key">${index + 1}</span>
          <span class="text">${escapeHtml(option)}</span>
        </button>
      </li>`)
    .join('');

  const unanswered = total - answered;

  return `
    <div class="quizbar">
      <span>Question ${position + 1} of ${total}</span>
      <div class="progress"><span style="width:${((position + 1) / total) * 100}%"></span></div>
      <span>${answered} answered</span>
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

      ${state.notice ? `<p class="banner" style="margin-top:18px">${escapeHtml(state.notice)}</p>` : ''}

      <div class="quizfoot">
        <button class="btn ghost tiny" data-action="flag">${entry.flagged ? 'Unflag' : 'Flag for review'}</button>
        <div class="nav">
          <button class="btn ghost tiny" data-action="prev" ${position === 0 ? 'disabled' : ''}>Back</button>
          <button class="btn" data-action="${isLast ? 'submit' : 'next'}">
            ${isLast ? (state.pendingSubmit ? 'Submit anyway' : 'Finish and mark') : 'Next'}
          </button>
        </div>
      </div>
      ${isLast && unanswered > 0 ? `<p class="unanswered-note">${unanswered} question${unanswered === 1 ? '' : 's'} unanswered — unanswered counts as wrong.</p>` : ''}
    </div>
    <p class="footnote" style="margin-top:12px">Keys: 1–4 to answer · F to flag · ← → to move · Enter to advance</p>
    <p class="footnote">${escapeHtml(config.label ?? '')}</p>
  `;
}

function viewResults() {
  const { results, session } = state;
  const verdict = results.percent >= 60
    ? 'At or above the real Foundation pass mark (60%).'
    : 'Below the real Foundation pass mark (60%).';

  const sections = results.bySection
    .map((row) => {
      const percent = Math.round((row.correct / row.total) * 100);
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
      const isRight = entry.selected === entry.correctIndex;
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
        <details class="reviewitem${isRight ? ' right' : ''}" ${isRight ? '' : 'open'}>
          <summary>
            <span class="rhead">
              <span class="tag">${index + 1}</span>
              <span class="tag">${escapeHtml(question.section)}</span>
              <span class="tag">${escapeHtml(question.topic)}</span>
              <span class="tag${isRight ? '' : ' hard'}">${isRight ? 'Correct' : 'Missed'}</span>
            </span>
            <span class="rstem">${escapeHtml(question.stem)}</span>
          </summary>
          ${lines}
          <p class="why"><b>${yourAnswer}</b><br>${escapeHtml(question.explanation)}</p>
          <p class="footnote">Source: ${escapeHtml(question.source)}</p>
        </details>`;
    })
    .join('');

  return `
    <div class="card">
      <div class="scorehead">
        <div class="scorecircle" style="--pct:${results.percent}"><b>${results.percent}%</b></div>
        <div>
          <h1>${results.correct} of ${results.total}</h1>
          <p class="verdict">${verdict}</p>
          ${state.storageOk ? '' : '<p class="verdict">This browser blocked storage, so this result was not saved.</p>'}
        </div>
      </div>
      <div class="tally">${sections}</div>
    </div>

    <div class="btnrow">
      <button class="btn" data-action="restart">Another set of questions</button>
      ${results.missed.length > 0 ? `<button class="btn ghost" data-action="drill-results-missed">Drill these ${results.missed.length} again</button>` : ''}
      <button class="btn ghost" data-action="home">All chapters</button>
    </div>

    <div class="review">
      <h2>Review</h2>
      <p class="footnote" style="margin-bottom:14px">Missed questions are open; correct ones are collapsed.</p>
      ${review}
    </div>
  `;
}

/* -------------------------------------------------------------------- actions */

function startSession(pool, count = pool.length) {
  state.session = buildSession(pool, count);
  state.position = 0;
  state.pendingSubmit = false;
  state.notice = '';
  state.view = 'quiz';
  setHash('quiz', { set: state.config.setId ?? '' });
  render();
}

function submitSession() {
  const unanswered = state.session.filter((entry) => entry.selected === null).length;
  if (unanswered > 0 && !state.pendingSubmit) {
    state.pendingSubmit = true;
    state.notice = `${unanswered} question${unanswered === 1 ? '' : 's'} still unanswered. Press submit again to mark anyway, or go back.`;
    render();
    return;
  }

  const results = scoreSession(state.session);
  const timestamp = Date.now();
  for (const entry of state.session) {
    store.attempts.push({
      id: entry.question.id,
      set: entry.question.set,
      section: entry.question.section,
      topic: entry.question.topic,
      correct: entry.selected === entry.correctIndex,
      ts: timestamp,
    });
  }
  saveStore();

  state.results = results;
  state.view = 'results';
  state.pendingSubmit = false;
  setHash('results', { set: state.config.setId ?? '' });
  render();
}

function answeredPool(questions) {
  return state.config.hardOnly ? questions.filter((question) => question.difficulty === 3) : questions;
}

async function openSet(setId) {
  try {
    const questions = await loadSet(setId);
    state.bank = questions;
    state.config.setId = setId;
    state.config.count = Math.min(state.config.count || 20, questions.length);
    state.view = 'setup';
    setHash('setup', { set: setId });
    render();
  } catch (error) {
    state.loadError = error.message;
    render();
  }
}

async function drillMissedSource() {
  const pool = await loadMissed();
  if (pool.length === 0) {
    state.notice = '';
    state.view = 'home';
    render();
    return;
  }
  state.bank = pool;
  state.config.setId = 'missed';
  state.config.count = pool.length;
  state.config.label = 'Missed questions from previous attempts';
  startSession(pool);
}

appEl.addEventListener('click', async (event) => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const action = trigger.dataset.action;

  switch (action) {
    case 'home':
      state.view = 'home';
      state.notice = '';
      setHash('home', {});
      render();
      break;

    case 'open-set':
      await openSet(trigger.dataset.set);
      break;

    case 'set-count':
      state.config.count = Number(trigger.dataset.count);
      render();
      break;

    case 'toggle-hard':
      state.config.hardOnly = !state.config.hardOnly;
      render();
      break;

    case 'start-drill': {
      const pool = answeredPool(state.bank);
      if (pool.length === 0) {
        state.notice = 'No questions match that filter.';
        break;
      }
      state.config.label = '';
      startSession(pool, Math.min(state.config.count, pool.length));
      break;
    }

    case 'answer': {
      const entry = state.session[state.position];
      const index = Number(trigger.dataset.index);
      entry.selected = entry.selected === index ? null : index;
      state.pendingSubmit = false;
      state.notice = '';
      render();
      break;
    }

    case 'flag': {
      const entry = state.session[state.position];
      entry.flagged = !entry.flagged;
      render();
      break;
    }

    case 'next':
      if (state.position < state.session.length - 1) {
        state.position += 1;
        state.pendingSubmit = false;
        state.notice = '';
        render();
      }
      break;

    case 'prev':
      if (state.position > 0) {
        state.position -= 1;
        state.pendingSubmit = false;
        state.notice = '';
        render();
      }
      break;

    case 'submit':
      submitSession();
      break;

    case 'restart': {
      const pool = answeredPool(state.bank);
      startSession(pool, Math.min(state.config.count, pool.length));
      break;
    }

    case 'drill-results-missed': {
      const missedIds = new Set(state.results.missed);
      const pool = state.session
        .filter((entry) => missedIds.has(entry.question.id))
        .map((entry) => entry.question);
      state.bank = pool;
      state.config.count = pool.length;
      state.config.label = 'Missed questions, reshuffled';
      startSession(pool, pool.length);
      break;
    }

    case 'drill-missed':
      await drillMissedSource();
      break;

    default:
      break;
  }
});

document.addEventListener('keydown', (event) => {
  if (state.view !== 'quiz') return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  const entry = state.session[state.position];

  if (event.key >= '1' && event.key <= '4') {
    const index = Number(event.key) - 1;
    if (index < entry.options.length) {
      event.preventDefault();
      entry.selected = entry.selected === index ? null : index;
      state.pendingSubmit = false;
      state.notice = '';
      render();
    }
    return;
  }

  if (event.key === 'f' || event.key === 'F') {
    event.preventDefault();
    entry.flagged = !entry.flagged;
    render();
    return;
  }

  if (event.key === 'ArrowRight' || event.key === 'Enter') {
    event.preventDefault();
    if (state.position < state.session.length - 1) {
      state.position += 1;
      state.pendingSubmit = false;
      state.notice = '';
      render();
    } else {
      submitSession();
    }
    return;
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (state.position > 0) {
      state.position -= 1;
      state.pendingSubmit = false;
      state.notice = '';
      render();
    }
  }
});

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

  state.view = 'home';
  render();
}

boot();
