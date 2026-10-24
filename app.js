import { buildSession, scoreSession } from './bank-logic.js';
import { chapterProgress, missedIds, passMark } from './progress.js';

const STORAGE_KEY = 'prince2Practice.v1';
const COUNT_CHOICES = [10, 20, 30];
const EXAM_QUESTIONS = 60;
const EXAM_MINUTES = 60;

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
  paletteOpen: true,
  loadError: '',
  storageOk: true,
  exam: { totalMs: EXAM_MINUTES * 60 * 1000, deadline: 0, remainingMs: 0 },
  timer: null,
};

const store = loadStore();

/* ------------------------------------------------------------------ storage */

function loadStore() {
  const empty = { version: 2, attempts: [], exams: [] };

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
    // Corrupt data must not be silently trusted, and must not take the app down.
    return { ...empty, corrupt: true };
  }

  // v1 stored nothing but attempts; the shape is still valid, so migrate in place.
  const attempts = Array.isArray(parsed?.attempts)
    ? parsed.attempts.filter((entry) => entry && typeof entry.id === 'string')
    : [];
  const exams = Array.isArray(parsed?.exams)
    ? parsed.exams.filter((entry) => entry && typeof entry.total === 'number')
    : [];

  return { version: 2, attempts, exams };
}

function saveStore() {
  if (!state.storageOk) return false;
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ version: 2, attempts: store.attempts, exams: store.exams }),
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

async function loadSet(setId) {
  if (state.cache.has(setId)) return state.cache.get(setId);
  const meta = state.index.sets.find((entry) => entry.id === setId);
  if (!meta) throw new Error(`Unknown set "${setId}"`);

  const response = await fetch(`./${meta.file}`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Could not load ${meta.file} (HTTP ${response.status})`);

  const questions = await response.json();
  if (!Array.isArray(questions) || questions.length === 0) {
    throw new Error(`${meta.file} contained no questions`);
  }
  state.cache.set(setId, questions);
  return questions;
}

async function gatherPool() {
  if (state.mode === 'missed') {
    const wanted = new Set(missedIds(store.attempts));
    const pool = [];
    for (const meta of state.index.sets) {
      if (!wanted.size) break;
      const questions = await loadSet(meta.id);
      pool.push(...questions.filter((question) => wanted.has(question.id)));
    }
    return pool;
  }

  const pool = [];
  for (const setId of state.selection) {
    pool.push(...(await loadSet(setId)));
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
  }[mode] ?? 'Practice';
}

/* --------------------------------------------------------------------- clock */

function startClock() {
  stopClock();
  state.exam.deadline = Date.now() + state.exam.totalMs;
  state.timer = setInterval(tickClock, 250);
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
  };

  appEl.innerHTML = (views[state.view] ?? viewHome)();
  appEl.focus({ preventScroll: true });
}

function stopClockIfLeavingQuiz() {
  if (state.view !== 'quiz' && state.timer) stopClock();
}

/* ---------------------------------------------------------------------- home */

function viewHome() {
  const { index } = state;
  const progress = chapterProgress(store.attempts, index.sets);
  const missedCount = missedIds(store.attempts).length;
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
        </span>
      </button>`)
    .join('');

  return `
    <header class="masthead">
      <div>
        <p class="eyebrow">PRINCE2 7 Foundation</p>
        <h1>Practice</h1>
      </div>
      <p class="bankstat">${index.total} questions · ${index.sets.length} of 21 sets</p>
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

    ${index.sets.length < 21 ? `<p class="footnote">Bank in progress: ${21 - index.sets.length} sets not written yet.</p>` : ''}
    ${state.storageOk ? '' : '<p class="footnote">This browser blocked storage, so progress is not being saved.</p>'}
  `;
}

/* ---------------------------------------------------------------------- pick */

function viewPick() {
  const mixed = state.mode === 'mixed';
  const progress = chapterProgress(store.attempts, state.index.sets);

  const rows = progress.rows
    .map((row) => {
      const meta = state.index.sets.find((entry) => entry.id === row.setId);
      const checked = state.selection.includes(row.setId);
      return `
        <button class="pickrow${checked ? ' checked' : ''}" data-action="${mixed ? 'toggle-set' : 'pick-set'}" data-set="${escapeHtml(row.setId)}">
          <span class="pickbox" aria-hidden="true">${checked ? '✓' : ''}</span>
          <span class="pickbody">
            <span class="picktitle">${escapeHtml(setTitle(meta))}</span>
            <span class="pickmeta">${escapeHtml(setLabel(meta))} · ${row.total} questions · ${row.exposed} seen</span>
          </span>
        </button>`;
    })
    .join('');

  return `
    <p class="eyebrow"><button class="btn subtle" data-action="home" style="padding-left:0">← Practice</button></p>
    <h1>${mixed ? 'Mixed chapters' : 'Practice by chapter'}</h1>
    <p class="lede">${mixed
      ? 'Tick the chapters you want. Questions are drawn across all of them.'
      : 'Pick a chapter to drill.'}</p>

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
    <p class="eyebrow"><button class="btn subtle" data-action="back-from-setup" style="padding-left:0">← Back</button></p>
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
    <p class="eyebrow"><button class="btn subtle" data-action="home" style="padding-left:0">← Practice</button></p>
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

    <p class="footnote" style="margin-top:12px">Keys: 1–4 to answer${exam ? '' : ''}${exam ? ' · F to flag' : ''} · ← → to move · Enter to advance</p>
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

async function openPool(label) {
  state.poolLabel = label;
  state.pool = await gatherPool();

  if (state.pool.length === 0) {
    state.notice = 'No questions match that selection.';
    state.view = 'home';
    render();
    return;
  }

  state.config.count = Math.min(state.config.count, state.pool.length);
  state.view = 'setup';
  render();
}

function startSession(pool, count) {
  state.session = buildSession(pool, count);
  state.position = 0;
  state.pendingSubmit = false;
  state.notice = '';
  state.view = 'quiz';

  if (state.mode === 'exam') {
    startClock();
  }
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

  state.pendingSubmit = false;
  state.notice = '';
  state.view = 'results';
  render();
}

function answeredPool() {
  return state.config.hardOnly
    ? state.pool.filter((question) => question.difficulty === 3)
    : state.pool;
}

appEl.addEventListener('click', async (event) => {
  const trigger = event.target.closest('[data-action]');
  if (!trigger) return;
  const action = trigger.dataset.action;

  try {
    switch (action) {
      case 'home':
        state.view = 'home';
        state.notice = '';
        render();
        break;

      case 'mode':
        state.mode = trigger.dataset.mode;
        state.selection = [];
        state.notice = '';

        if (state.mode === 'chapter' || state.mode === 'mixed') {
          state.view = 'pick';
          render();
        } else if (state.mode === 'exam') {
          state.view = 'examIntro';
          render();
        } else {
          await openPool('Missed questions');
        }
        break;

      case 'pick-set':
        state.selection = [trigger.dataset.set];
        await openPool(setTitle(state.index.sets.find((entry) => entry.id === state.selection[0])));
        break;

      case 'open-chapter':
        state.mode = 'chapter';
        state.selection = [trigger.dataset.set];
        await openPool(setTitle(state.index.sets.find((entry) => entry.id === state.selection[0])));
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
        await openPool('Mixed chapters');
        break;

      case 'back-from-setup':
        state.view = state.mode === 'missed' ? 'home' : 'pick';
        render();
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
          break;
        }
        startSession(pool, Math.min(state.config.count, pool.length));
        break;
      }

      case 'start-exam': {
        state.selection = state.index.sets.map((entry) => entry.id);
        const pool = await gatherPool();
        const total = Math.min(EXAM_QUESTIONS, pool.length);
        state.pool = pool;
        state.notice = '';
        startSession(pool, total);
        break;
      }

      case 'answer': {
        const entry = state.session[state.position];
        if (state.mode !== 'exam' && entry.selected !== null) break; // locked once marked

        const index = Number(trigger.dataset.index);
        entry.selected = index;
        state.pendingSubmit = false;
        state.notice = '';

        if (state.mode !== 'exam') recordAttempt(entry, state.mode);
        render();
        break;
      }

      case 'flag': {
        const entry = state.session[state.position];
        entry.flagged = !entry.flagged;
        render();
        break;
      }

      case 'goto':
        state.position = Number(trigger.dataset.index);
        state.pendingSubmit = false;
        render();
        break;

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
  } catch (error) {
    state.loadError = error.message;
    render();
  }
});

document.addEventListener('keydown', (event) => {
  if (state.view !== 'quiz') return;
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;

  const entry = state.session[state.position];
  const exam = state.mode === 'exam';

  if (event.key >= '1' && event.key <= '4') {
    const index = Number(event.key) - 1;
    if (index >= entry.options.length) return;
    if (!exam && entry.selected !== null) return;
    event.preventDefault();
    entry.selected = index;
    state.pendingSubmit = false;
    state.notice = '';
    if (!exam) recordAttempt(entry, state.mode);
    render();
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

  render();
}

boot();
