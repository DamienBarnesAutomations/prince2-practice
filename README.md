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

- **No feedback until you submit.** No reassurance after each answer.
- **Near-miss distractors.** "Which level authorises the next stage" is answered against
  the project board, the project manager, the programme and the design authority — not
  against "the marketing department".
- **A difficulty rating.** Level 3 questions chain two facts or apply the method to a
  situation; you can filter to just those.
- **Wrong answers persist.** The home screen offers a drill of everything your most recent
  attempt got wrong, re-served with different distractors and a different order.

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

| Set | Questions |
|---|---|
| Ch 2 — Principles | 57 |
| Ch 1, 3–19, Appendix A, Appendix B | not written yet |

## Progress storage

One `localStorage` key, `prince2Practice.v1`:

```json
{ "attempts": [{ "id": "ch02-028", "set": "ch02", "section": "2.4", "topic": "Manage by exception", "correct": true, "ts": 1761300000000 }] }
```

Everything else — the missed list, per-chapter tallies — is derived at load. If the browser
blocks storage the app says so on the results screen rather than pretending it saved.

No accounts, no analytics, no third-party requests. The only network calls are for
`bank/index.json` and the question files it lists.

## Copyright

Unofficial study aid. Not affiliated with or endorsed by PeopleCert or AXELOS. PRINCE2® is
a registered trademark of PeopleCert.

All questions are original. The manual itself is not published here and no manual text is
reproduced. Answer source references point at page numbers so every claim can be checked
against a copy of *Managing Successful Projects with PRINCE2* (7th edition).
