"""Seed the problems bank with 10 starter problems and their test cases."""

import os

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

load_dotenv()

from db.models import Base, Difficulty, Problem, TestCase  # noqa: E402

PROBLEMS = [
    {
        "title": "Pair Sum",
        "difficulty": Difficulty.Easy,
        "patterns": ["hashing"],
        "prompt": (
            "Given a list of integers and a target value, find two numbers in the list that "
            "add up to the target and return their indices. Assume exactly one valid pair "
            "exists, and you can't use the same element twice."
        ),
        "starter_code": "def pair_sum(nums, target):\n    pass",
        "test_cases": [
            {"input": {"nums": [2, 7, 11, 15], "target": 9}, "expected_output": [0, 1], "is_hidden": False},
            {"input": {"nums": [3, 2, 4], "target": 6}, "expected_output": [1, 2], "is_hidden": False},
            {"input": {"nums": [3, 3], "target": 6}, "expected_output": [0, 1], "is_hidden": True},
        ],
    },
    {
        "title": "Anagram Check",
        "difficulty": Difficulty.Easy,
        "patterns": ["hashing"],
        "prompt": (
            "Given two strings, determine whether the second is an anagram of the first "
            "(uses exactly the same letters, rearranged)."
        ),
        "starter_code": "def is_anagram(s, t):\n    pass",
        "test_cases": [
            {"input": {"s": "listen", "t": "silent"}, "expected_output": True, "is_hidden": False},
            {"input": {"s": "hello", "t": "world"}, "expected_output": False, "is_hidden": False},
            {"input": {"s": "a", "t": "ab"}, "expected_output": False, "is_hidden": True},
        ],
    },
    {
        "title": "Has Duplicate",
        "difficulty": Difficulty.Easy,
        "patterns": ["hashing"],
        "prompt": (
            "Given a list of integers, return true if any value appears more than once, "
            "otherwise false."
        ),
        "starter_code": "def has_duplicate(nums):\n    pass",
        "test_cases": [
            {"input": {"nums": [1, 2, 3, 1]}, "expected_output": True, "is_hidden": False},
            {"input": {"nums": [1, 2, 3, 4]}, "expected_output": False, "is_hidden": False},
            {"input": {"nums": [1]}, "expected_output": False, "is_hidden": True},
        ],
    },
    {
        "title": "Balanced Brackets",
        "difficulty": Difficulty.Easy,
        "patterns": ["stack"],
        "prompt": (
            "Given a string containing only ()[]{}, determine if the brackets are balanced — "
            "every opening bracket closed by the same type, in the correct order."
        ),
        "starter_code": "def is_balanced(s):\n    pass",
        "test_cases": [
            {"input": {"s": "()[]{}"}, "expected_output": True, "is_hidden": False},
            {"input": {"s": "(]"}, "expected_output": False, "is_hidden": False},
            {"input": {"s": "([)]"}, "expected_output": False, "is_hidden": True},
        ],
    },
    {
        "title": "Best Trade",
        "difficulty": Difficulty.Easy,
        "patterns": ["arrays", "sliding-window"],
        "prompt": (
            "Given a list of daily stock prices, find the maximum profit achievable by buying "
            "on one day and selling on a later day. Return 0 if no profit is possible."
        ),
        "starter_code": "def best_trade(prices):\n    pass",
        "test_cases": [
            {"input": {"prices": [7, 1, 5, 3, 6, 4]}, "expected_output": 5, "is_hidden": False},
            {"input": {"prices": [7, 6, 4, 3, 1]}, "expected_output": 0, "is_hidden": False},
            {"input": {"prices": [2, 2]}, "expected_output": 0, "is_hidden": True},
        ],
    },
    {
        "title": "Find the Gap",
        "difficulty": Difficulty.Easy,
        "patterns": ["bit-manipulation", "math"],
        "prompt": (
            "Given a list of n distinct numbers taken from the range 0 to n, find the one "
            "number missing from the range."
        ),
        "starter_code": "def find_missing(nums):\n    pass",
        "test_cases": [
            {"input": {"nums": [3, 0, 1]}, "expected_output": 2, "is_hidden": False},
            {"input": {"nums": [0, 1]}, "expected_output": 2, "is_hidden": False},
            {"input": {"nums": [9, 6, 4, 2, 3, 5, 7, 0, 1]}, "expected_output": 8, "is_hidden": True},
        ],
    },
    {
        "title": "Count the Ones",
        "difficulty": Difficulty.Easy,
        "patterns": ["bit-manipulation"],
        "prompt": (
            "Given an unsigned integer, return how many 1 bits appear in its binary "
            "representation."
        ),
        "starter_code": "def count_ones(n):\n    pass",
        "test_cases": [
            {"input": {"n": 11}, "expected_output": 3, "is_hidden": False},
            {"input": {"n": 128}, "expected_output": 1, "is_hidden": False},
            {"input": {"n": 0}, "expected_output": 0, "is_hidden": True},
        ],
    },
    {
        "title": "Flip the Tree",
        "difficulty": Difficulty.Easy,
        "patterns": ["trees", "dfs"],
        "prompt": (
            "Given the root of a binary tree (as a list in level order, null for missing nodes), "
            "invert it — swap every node's left and right children — and return the new root as "
            "a level-order list."
        ),
        "starter_code": "def flip_tree(root):\n    pass",
        "test_cases": [
            {"input": {"root": [4, 2, 7, 1, 3, 6, 9]}, "expected_output": [4, 7, 2, 9, 6, 3, 1], "is_hidden": False},
            {"input": {"root": []}, "expected_output": [], "is_hidden": False},
            {"input": {"root": [1]}, "expected_output": [1], "is_hidden": True},
        ],
    },
    {
        "title": "Loop Detector",
        "difficulty": Difficulty.Easy,
        "patterns": ["linked-list", "two-pointers"],
        "prompt": (
            "Given a linked list represented as a list of values plus a 'pos' index indicating "
            "where the tail connects back to (or -1 for no cycle), determine whether the list "
            "contains a cycle."
        ),
        "starter_code": "def has_cycle(values, pos):\n    pass",
        "test_cases": [
            {"input": {"values": [3, 2, 0, -4], "pos": 1}, "expected_output": True, "is_hidden": False},
            {"input": {"values": [1, 2, 3], "pos": -1}, "expected_output": False, "is_hidden": False},
            {"input": {"values": [1], "pos": 0}, "expected_output": True, "is_hidden": True},
        ],
    },
    {
        "title": "Stair Ways",
        "difficulty": Difficulty.Easy,
        "patterns": ["dynamic-programming"],
        "prompt": (
            "You're climbing a staircase of n steps. Each move you take either 1 or 2 steps. "
            "Return how many distinct ways there are to reach the top."
        ),
        "starter_code": "def climb_stairs(n):\n    pass",
        "test_cases": [
            {"input": {"n": 2}, "expected_output": 2, "is_hidden": False},
            {"input": {"n": 3}, "expected_output": 3, "is_hidden": False},
            {"input": {"n": 1}, "expected_output": 1, "is_hidden": True},
        ],
    },
]


def seed() -> None:
    engine = create_engine(os.environ["DATABASE_URL"], pool_pre_ping=True)
    with Session(engine) as session:
        existing = session.query(Problem).count()
        if existing > 0:
            print(f"Skipping seed: {existing} problems already in DB.")
            return

        for data in PROBLEMS:
            test_cases_data = data.pop("test_cases")
            problem = Problem(**data)
            session.add(problem)
            session.flush()

            for tc in test_cases_data:
                session.add(TestCase(problem_id=problem.id, **tc))

        session.commit()
        print(f"Seeded {len(PROBLEMS)} problems.")


if __name__ == "__main__":
    seed()
