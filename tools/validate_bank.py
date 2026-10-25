#!/usr/bin/env python3
"""Validate the PRINCE2 practice question bank and keep index.json in sync.

Run from the repo root:  python tools/validate_bank.py
Exit code 1 means the bank is not shippable — the app would present a question
it cannot draw four options for, or score an answer that is not the answer.

Rules enforced per question:
  - id is <set>-<nnn>, unique across the whole bank, and matches the file it is in
  - set matches the file name
  - section, topic, source and explanation are present
  - answer is a non-empty string
  - distractors are 5-7 in count, or exactly 3 when "exhaustive" is true
  - no duplicate options once trimmed and case-folded, and the answer is not
    repeated among the distractors
  - difficulty is 1, 2 or 3

Rules enforced across the bank (the answer must not be guessable from its shape):
  - the answer is within 0.7-1.3x the average distractor length (unless the gap is
    under 15 characters, which is too small to notice), and across the bank it
    is neither the longest nor the shortest of the four shown options in more
    than 35% of draws (a random answer is each 25% of the time)
  - the answer is not built from more clauses than the distractors: no question
    has an answer with two or more extra commas/"and"s than its busiest
    distractor, and the bank-wide ratio stays between 0.8 and 1.25 (the answer must
    not be the simplest option either)
  - no two questions share a stem once trimmed and case-folded; stems that are
    more than 90% alike are reported as warnings
  - spelling is US (the manual's), so an option can never stand out by spelling

With --write-index, bank/index.json is regenerated from the files present.
"""

from __future__ import annotations

import difflib
import itertools
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BANK_DIR = REPO / "bank"
INDEX_PATH = BANK_DIR / "index.json"

MIN_DISTRACTORS = 5
MAX_DISTRACTORS = 7
EXHAUSTIVE_DISTRACTORS = 3
MIN_EXPLANATION_CHARS = 40

# Answer-shape limits. See the module docstring.
LENGTH_RATIO_MIN = 0.7
LENGTH_RATIO_MAX = 1.3
LENGTH_GAP_MIN_CHARS = 15
LONGEST_SHARE_MAX = 0.35
SHORTEST_SHARE_MAX = 0.35
CONNECTOR_EXCESS_MAX = 1
CONNECTOR_RATIO_MAX = 1.25
CONNECTOR_RATIO_MIN = 0.8
NEAR_DUPLICATE_RATIO = 0.9
OPTIONS_SHOWN = 4

# UK spellings the bank must not use; the manual is written in US English.
UK_SPELLING = re.compile(
    r"\b\w*?(?:authoris|summaris|realis|characteris|penalis|materialis|personalis|prioritis|"
    r"minimis|recognis|organis|formalis|jeopardis|visualis|standardis|centralis|synchronis|"
    r"utilis|finalis|customis|optimis)(?:e|ed|es|ing|ation|ations)\b"
    r"|\banalys(?:e|ed|es|ing)\b|\b(?:behaviour|labour|rumour)s?\b|\bcentres?\b|\bjudgement\b",
    re.IGNORECASE,
)

# Every drillable set in PRINCE2 7. Only sets with a bank file appear in the app.
CATALOGUE: dict[str, tuple[int, str, str]] = {
    "ch01": (1, "chapter", "Introduction"),
    "ch02": (2, "chapter", "Principles"),
    "ch03": (3, "chapter", "People"),
    "ch04": (4, "chapter", "Introduction to practices"),
    "ch05": (5, "chapter", "Business case"),
    "ch06": (6, "chapter", "Organizing"),
    "ch07": (7, "chapter", "Plans"),
    "ch08": (8, "chapter", "Quality"),
    "ch09": (9, "chapter", "Risk"),
    "ch10": (10, "chapter", "Issues"),
    "ch11": (11, "chapter", "Progress"),
    "ch12": (12, "chapter", "Introduction to processes"),
    "ch13": (13, "chapter", "Starting up a project"),
    "ch14": (14, "chapter", "Directing a project"),
    "ch15": (15, "chapter", "Initiating a project"),
    "ch16": (16, "chapter", "Controlling a stage"),
    "ch17": (17, "chapter", "Managing product delivery"),
    "ch18": (18, "chapter", "Managing a stage boundary"),
    "ch19": (19, "chapter", "Closing a project"),
    "appa": (20, "appendix", "Appendix A — Management products"),
    "appb": (21, "appendix", "Appendix B — Role descriptions"),
}


def normalise(value: str) -> str:
    return " ".join(value.split()).casefold()


def validate_question(question: object, set_id: str, position: int, seen_ids: dict[str, str]) -> list[str]:
    where = f"{set_id}[{position}]"
    errors: list[str] = []

    if not isinstance(question, dict):
        return [f"{where}: not an object"]

    qid = question.get("id")
    if not isinstance(qid, str) or not qid:
        errors.append(f"{where}: missing id")
    else:
        where = f"{set_id}[{position}] {qid}"
        if qid in seen_ids:
            errors.append(f"{where}: duplicate id, already used in {seen_ids[qid]}")
        else:
            seen_ids[qid] = set_id
        if not qid.startswith(f"{set_id}-"):
            errors.append(f"{where}: id does not start with {set_id}-")

    if question.get("set") != set_id:
        errors.append(f"{where}: set is {question.get('set')!r}, expected {set_id!r}")

    for field in ("section", "topic", "source"):
        value = question.get(field)
        if not isinstance(value, str) or not value.strip():
            errors.append(f"{where}: {field} is missing or empty")

    difficulty = question.get("difficulty")
    if difficulty not in (1, 2, 3):
        errors.append(f"{where}: difficulty must be 1, 2 or 3, got {difficulty!r}")

    explanation = question.get("explanation")
    if not isinstance(explanation, str) or len(explanation.strip()) < MIN_EXPLANATION_CHARS:
        errors.append(f"{where}: explanation missing or shorter than {MIN_EXPLANATION_CHARS} chars")

    stem = question.get("stem")
    if not isinstance(stem, str) or not stem.strip():
        errors.append(f"{where}: stem is missing or empty")

    answer = question.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        errors.append(f"{where}: answer is missing or empty")
        return errors

    distractors = question.get("distractors")
    if not isinstance(distractors, list) or not all(isinstance(d, str) and d.strip() for d in distractors):
        errors.append(f"{where}: distractors must be a list of non-empty strings")
        return errors

    exhaustive = question.get("exhaustive", False)
    if not isinstance(exhaustive, bool):
        errors.append(f"{where}: exhaustive must be a boolean when present")
        exhaustive = False

    expected = (EXHAUSTIVE_DISTRACTORS,) if exhaustive else range(MIN_DISTRACTORS, MAX_DISTRACTORS + 1)
    if exhaustive:
        if len(distractors) != EXHAUSTIVE_DISTRACTORS:
            errors.append(
                f"{where}: exhaustive question needs exactly {EXHAUSTIVE_DISTRACTORS} distractors, has {len(distractors)}"
            )
    elif len(distractors) not in expected:
        errors.append(
            f"{where}: needs {MIN_DISTRACTORS}-{MAX_DISTRACTORS} distractors, has {len(distractors)}"
        )

    options = [normalise(answer)] + [normalise(d) for d in distractors]
    duplicates = {option for option in options if options.count(option) > 1}
    if duplicates:
        errors.append(f"{where}: duplicate option text: {sorted(duplicates)}")

    return errors


def connectors(text: str) -> int:
    """Clause joiners: commas and the word "and". A proxy for how compound an option is."""
    return text.count(",") + len(re.findall(r"\band\b", text, flags=re.IGNORECASE))


def extreme_share(question: dict, longest: bool) -> float:
    """Probability the answer is strictly the longest (or shortest) of the four shown options."""
    answer_len = len(question["answer"])
    distractors = question["distractors"]
    if question.get("exhaustive"):
        draws = [distractors]
    else:
        draws = list(itertools.combinations(distractors, OPTIONS_SHOWN - 1))
    if longest:
        return sum(answer_len > max(len(d) for d in draw) for draw in draws) / len(draws)
    return sum(answer_len < min(len(d) for d in draw) for draw in draws) / len(draws)


def check_answer_shape(questions: list[dict]) -> list[str]:
    errors: list[str] = []
    usable = [
        q for q in questions
        if isinstance(q.get("answer"), str) and isinstance(q.get("distractors"), list) and q["distractors"]
        and all(isinstance(d, str) for d in q["distractors"])
    ]

    for q in usable:
        mean_len = sum(len(d) for d in q["distractors"]) / len(q["distractors"])
        ratio = len(q["answer"]) / mean_len
        gap = abs(len(q["answer"]) - mean_len)
        if gap >= LENGTH_GAP_MIN_CHARS and not LENGTH_RATIO_MIN <= ratio <= LENGTH_RATIO_MAX:
            errors.append(
                f"{q['id']}: answer is {ratio:.2f}x the average distractor length "
                f"(allowed {LENGTH_RATIO_MIN}-{LENGTH_RATIO_MAX})"
            )
        excess = connectors(q["answer"]) - max(connectors(d) for d in q["distractors"])
        if excess > CONNECTOR_EXCESS_MAX:
            errors.append(
                f"{q['id']}: answer has {excess} more commas/'and's than its busiest distractor "
                f"(allowed {CONNECTOR_EXCESS_MAX})"
            )

    if usable:
        longest = sum(extreme_share(q, True) for q in usable) / len(usable)
        if longest > LONGEST_SHARE_MAX:
            errors.append(
                f"bank: the answer is the longest option in {longest:.0%} of draws "
                f"(allowed {LONGEST_SHARE_MAX:.0%}, chance is 25%)"
            )
        shortest = sum(extreme_share(q, False) for q in usable) / len(usable)
        if shortest > SHORTEST_SHARE_MAX:
            errors.append(
                f"bank: the answer is the shortest option in {shortest:.0%} of draws "
                f"(allowed {SHORTEST_SHARE_MAX:.0%}, chance is 25%)"
            )
        answer_conn = sum(connectors(q["answer"]) for q in usable) / len(usable)
        distractor_conn = (
            sum(connectors(d) for q in usable for d in q["distractors"])
            / sum(len(q["distractors"]) for q in usable)
        )
        ratio = answer_conn / distractor_conn if distractor_conn else 1.0
        if not CONNECTOR_RATIO_MIN <= ratio <= CONNECTOR_RATIO_MAX:
            errors.append(
                f"bank: answers carry {ratio:.2f}x the commas/'and's of distractors "
                f"(allowed {CONNECTOR_RATIO_MIN}-{CONNECTOR_RATIO_MAX})"
            )
    return errors


def check_stems(questions: list[dict]) -> tuple[list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    stems = [(q["id"], normalise(q["stem"])) for q in questions if isinstance(q.get("stem"), str)]

    first_seen: dict[str, str] = {}
    for qid, stem in stems:
        if stem in first_seen:
            errors.append(f"{qid}: stem duplicates {first_seen[stem]}")
        else:
            first_seen[stem] = qid

    unique = list(first_seen.items())
    for i, (stem_a, id_a) in enumerate(unique):
        for stem_b, id_b in unique[i + 1:]:
            matcher = difflib.SequenceMatcher(None, stem_a, stem_b)
            if matcher.real_quick_ratio() < NEAR_DUPLICATE_RATIO or matcher.quick_ratio() < NEAR_DUPLICATE_RATIO:
                continue
            ratio = matcher.ratio()
            if ratio >= NEAR_DUPLICATE_RATIO:
                warnings.append(f"{id_a} and {id_b}: stems are {ratio:.0%} alike")
    return errors, warnings


def check_spelling(questions: list[dict]) -> list[str]:
    errors: list[str] = []
    for q in questions:
        parts = [q.get("stem"), q.get("answer"), q.get("explanation")]
        parts += q.get("distractors") if isinstance(q.get("distractors"), list) else []
        found = sorted({m.group(0).lower() for part in parts if isinstance(part, str) for m in UK_SPELLING.finditer(part)})
        if found:
            errors.append(f"{q.get('id')}: UK spelling {found}; the bank uses US spelling")
    return errors


def load_sets() -> tuple[list[dict], list[dict], list[str]]:
    errors: list[str] = []
    sets: list[dict] = []
    questions_all: list[dict] = []
    seen_ids: dict[str, str] = {}

    for path in sorted(BANK_DIR.glob("*.json")):
        if path.name == "index.json":
            continue
        set_id = path.stem
        if set_id not in CATALOGUE:
            errors.append(f"{path.name}: no such set in the catalogue")
            continue

        try:
            questions = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            errors.append(f"{path.name}: invalid JSON — {exc}")
            continue

        if not isinstance(questions, list):
            errors.append(f"{path.name}: top level must be an array")
            continue

        for position, question in enumerate(questions):
            errors.extend(validate_question(question, set_id, position, seen_ids))
            if isinstance(question, dict):
                questions_all.append(question)

        order, kind, title = CATALOGUE[set_id]
        sets.append({"id": set_id, "order": order, "kind": kind, "title": title, "count": len(questions)})

    sets.sort(key=lambda entry: entry["order"])
    return sets, questions_all, errors


def write_index(sets: list[dict]) -> None:
    index = {
        "version": 1,
        "edition": "PRINCE2 7",
        "total": sum(entry["count"] for entry in sets),
        "sets": [
            {
                "id": entry["id"],
                "order": entry["order"],
                "kind": entry["kind"],
                "title": entry["title"],
                "file": f"bank/{entry['id']}.json",
                "count": entry["count"],
            }
            for entry in sets
        ],
    }
    INDEX_PATH.write_text(json.dumps(index, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    # Windows consoles default to a legacy code page; set titles and stems print the same everywhere.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    write_index_requested = "--write-index" in sys.argv[1:]
    if not BANK_DIR.is_dir():
        print(f"error: {BANK_DIR} does not exist")
        return 1

    sets, questions, errors = load_sets()
    stem_errors, warnings = check_stems(questions)
    errors += stem_errors
    errors += check_spelling(questions)
    errors += check_answer_shape(questions)

    for warning in warnings:
        print(f"warn {warning}")

    if errors:
        for error in errors:
            print(f"FAIL {error}")
        print(f"\n{len(errors)} error(s) across {len(sets)} set(s).")
        return 1

    if write_index_requested:
        write_index(sets)

    total = sum(entry["count"] for entry in sets)
    for entry in sets:
        print(f"ok   {entry['id']:<6} {entry['count']:>3} questions  {entry['title']}")
    print(f"\n{total} questions across {len(sets)} set(s), 0 errors.")
    if not write_index_requested:
        print("index.json not rewritten (pass --write-index).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
