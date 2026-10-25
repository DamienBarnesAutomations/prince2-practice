# PRINCE2 7 Foundation — practice

Unofficial practice questions for the PRINCE2 7 Foundation exam, chapter by chapter.

Live at **https://damienbarnesautomations.github.io/prince2-practice/**

## What makes it different from a normal question bank

The real exam gives you four options and one right answer. Most practice apps give you the
same four options every time, so after two passes you are recognising the screen rather
than reading the question.

Here every question is authored as a **pool**: one correct answer plus five to seven
hand-written distractors, each a genuine PRINCE2 concept from a neighbouring section
rather than an obvious throwaway. A draw takes three of those distractors, shuffles them
with the answer, and shows four.

A six-option question therefore has ten distinct wrong-option triples and twenty-four
position orderings — **240 different presentations of the same question**. The question
order is reshuffled too, and no question repeats inside a session.

Other deliberate choices, all of them to keep it hard:

- **Marked as you go, in practice modes.** Chapter, mixed and missed practice lock the answer
  the moment you pick it, show whether it was right, and show the reason — before you move on.
  Exam mode stays silent until you submit.
- **Near-miss distractors.** "Which level authorises the next stage" is answered against
  the project board, the project manager, the programme and the design authority — not
  against "the marketing department".
- **A difficulty rating.** Level 3 questions chain two facts or apply the method to a
  situation; you can filter to just those.
- **Wrong answers persist.** They go into a missed list that only clears when you answer the
  same question correctly twice in a row.

## Modes

| Mode | What it does |
|---|---|
| **Practice by chapter** | One chapter, questions drawn at random, marked immediately with the reason. |
| **Mixed chapters** | Tick any number of chapters and draw across all of them. |
| **Exam mode** | 60 questions, 60-minute countdown, flag-for-review with a question palette, no feedback until submit, pass mark 60%. |
| **Missed questions** | Everything you have answered wrong and not yet cleared. A question leaves this list after two consecutive correct answers, and returns if you get it wrong again. |

Leaving a session: the `← Practice` control inside a quiz, and the browser's own back
control, both return to the previous screen. Practice answers already marked are kept;
unasked questions are dropped. Abandoning an exam needs a second press and does not save a
paper, because a half-finished paper is not a score.

## Progress

One append-only attempts array is the only stored truth. Everything on the home screen is
derived from it at load:

- **seen** — distinct questions answered, per chapter and overall.
- **right / wrong** — the most recent answer for each of those questions. These always sum
  to seen.
- **mastered** — questions with two consecutive correct answers.

Per-question mastery, the missed list and the exam history are all recomputed, never stored
as counters, so a stale counter cannot disagree with the history.

## Running it

The app fetches its question files over HTTP, so `file://` will not work. Either use the
live site, or serve the repo locally:

```sh
python -m http.server 8000
# then open http://localhost:8000/
```

No build step, no dependencies, no framework. Plain HTML, CSS and ES modules.

## Layout

```
index.html            one page
app.js                screens, wiring, localStorage
bank-logic.js         pure drawing and scoring logic (no DOM)
progress.js           pure derivation: mastery, missed list, chapter tallies
styles.css
bank/index.json       set metadata: title, file, question count
bank/ch02.json        one file per set
tools/validate_bank.py
tests/                node --test
```

## Adding a chapter

1. Write `bank/chNN.json` as an array of questions in the schema below.
2. Run `python tools/validate_bank.py --write-index`. It fails on anything that could make
   the app show three options or score the wrong answer, and regenerates `bank/index.json`.
   It also fails on questions whose answer can be guessed from its shape: an answer that is
   far longer or shorter than its distractors, or is the longest or shortest of the four
   shown more than 35% of the time across the bank, or is built from noticeably more (or
   fewer) clauses than the distractors. It rejects duplicate stems and UK spellings, because
   the manual is written in US English and an option that differs in spelling stands out.
3. Run `node --test`. The integrity test draws four options from every question in the bank.

### Question schema

```json
{
  "id": "ch02-028",
  "set": "ch02",
  "section": "2.4",
  "topic": "Manage by exception",
  "difficulty": 2,
  "stem": "Which statement defines a tolerance in PRINCE2?",
  "answer": "The permissible deviation above and below the plan's target ...",
  "distractors": ["...", "...", "...", "...", "...", "..."],
  "explanation": "Why that is the answer, in the manual's terms.",
  "source": "p.25"
}
```

Rules the validator enforces:

- `distractors` is 5–7 items, or exactly 3 when `"exhaustive": true`.
- `exhaustive` means the app shows all four options instead of sampling. It exists for
  negative questions ("which of the following is NOT..."), where sampling four from a
  larger pool would make the answer ambiguous. Write those with three true statements and
  one false one.
- `answer` never appears among the distractors, and no two options are textually identical.
- `difficulty` is 1 (recall), 2 (discrimination) or 3 (application or multi-step).
- `source` cites the page of the manual the question is defensible from.
- `explanation` is at least 40 characters and says why, not just what.

Questions are written from the manual, not transcribed from it or from any commercial
question bank.

## Bank status

All 21 sets are written: 873 questions.

| Set | Questions | Set | Questions |
|---|---|---|---|
| Ch 1 — Introduction | 20 | Ch 12 — Introduction to processes | 15 |
| Ch 2 — Principles | 57 | Ch 13 — Starting up a project | 30 |
| Ch 3 — People | 50 | Ch 14 — Directing a project | 30 |
| Ch 4 — Introduction to practices | 15 | Ch 15 — Initiating a project | 50 |
| Ch 5 — Business case | 50 | Ch 16 — Controlling a stage | 35 |
| Ch 6 — Organizing | 52 | Ch 17 — Managing product delivery | 25 |
| Ch 7 — Plans | 86 | Ch 18 — Managing a stage boundary | 25 |
| Ch 8 — Quality | 52 | Ch 19 — Closing a project | 25 |
| Ch 9 — Risk | 66 | Appendix A — Management products | 50 |
| Ch 10 — Issues | 50 | Appendix B — Role descriptions | 30 |
| Ch 11 — Progress | 60 | | |

## Progress storage

One `localStorage` key, `prince2Practice.v1`, now at version 2:

```json
{
  "version": 2,
  "attempts": [
    { "id": "ch02-028", "set": "ch02", "section": "2.4", "topic": "Manage by exception",
      "correct": true, "mode": "chapter", "ts": 1761300000000 }
  ],
  "exams": [
    { "ts": 1761300000000, "total": 60, "correct": 41, "percent": 68, "passed": true, "durationMs": 2440000 }
  ]
}
```

Version 1 stored attempts only; those still load and are treated as version 2 with no exam
history. If the browser blocks storage the app says so rather than pretending it saved.

No accounts, no analytics, no third-party requests. The only network calls are for
`bank/index.json` and the question files it lists.

## Copyright

Unofficial study aid. Not affiliated with or endorsed by PeopleCert or AXELOS. PRINCE2® is
a registered trademark of PeopleCert.

All questions are original. The manual itself is not published here and no manual text is
reproduced. Answer source references point at page numbers so every claim can be checked
against a copy of *Managing Successful Projects with PRINCE2* (7th edition).

## Installing on a phone

The app is an installable web app. Open the published site on the phone, then use
"Install app" / "Add to Home screen" in the browser menu (on iPhone: Share, then Add to
Home Screen). Once opened online, it also works offline.

There is only ever one version: the deployed files. The service worker (`sw.js`) fetches
every file from the network first and revalidates past the browser cache, so a push to
`main` shows up on the next load. Its stored copy is used only when the phone is offline.
Regenerate the icons with `python tools/make_icons.py`.
