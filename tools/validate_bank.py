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

With --write-index, bank/index.json is regenerated from the files present.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BANK_DIR = REPO / "bank"
INDEX_PATH = BANK_DIR / "index.json"

MIN_DISTRACTORS = 5
MAX_DISTRACTORS = 7
EXHAUSTIVE_DISTRACTORS = 3
MIN_EXPLANATION_CHARS = 40

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


def load_sets() -> tuple[list[dict], list[str]]:
    errors: list[str] = []
    sets: list[dict] = []
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

        order, kind, title = CATALOGUE[set_id]
        sets.append({"id": set_id, "order": order, "kind": kind, "title": title, "count": len(questions)})

    sets.sort(key=lambda entry: entry["order"])
    return sets, errors


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
    write_index_requested = "--write-index" in sys.argv[1:]
    if not BANK_DIR.is_dir():
        print(f"error: {BANK_DIR} does not exist")
        return 1

    sets, errors = load_sets()

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
