"""Run worker/lib/claude_client._parse_post_json and post_validation.validate_post_shape over fixed inputs.

Usage: python -I post_parse.py <out-dir>
Writes <out-dir>/post-parse.json as [{fn, input, output | raises}]. structlog logs to stdout, so the
result goes to a file. JSON-number cases are limited to what JSON.parse also accepts (Python's json.loads
additionally takes NaN/Infinity, which JS rejects; no case here uses them).
"""

import copy
import json
import os
import sys

sys.path[:0] = [p for p in os.environ.get("PYTHONPATH", "").split(":") if p]

from lib import claude_client  # noqa: E402
from lib.post_validation import validate_post_shape  # noqa: E402

out = sys.argv[1]

PARSE = [
    '{"persona": "skeptic", "post_type": "post", "content": "Hello"}',
    '```json\n{"persona": "a", "post_type": "post", "content": "fenced"}\n```',
    '```\n{"content": "bare fence"}\n```',
    '<think>reasoning {with} braces</think>\n{"persona": "a", "post_type": "post", "content": "after think"}',
    '<think>\nmulti\nline\n</think>\n\nplain answer text',
    'Here: {"content": "has } and { inside", "post_type": "post"} done',
    'Here: {"content": "esc \\" quote }", "post_type": "post"} done',
    '{"a": {"b": {"c": 1}}, "content": "nested"}',
    'Sure! Here is the post you asked for: {"content": "wrapped", "post_type": "post"} Hope that helps.',
    'no braces at all, just prose about the paper',
    '"just a string"',
    '42',
    '[1, 2]',
    'null',
    '{"posts":[{"text":"x","type":"standalone"}]}',
    'Assistant: hello',
    '   \n\t  ',
    '',
    'x' * 4001,
    'x' * 4000,
    '\U0001F600' * 4001,
    '\U0001F600' * 4000,
    'unbalanced { brace and "quote',
    '{"content": "unterminated',
    'text before ```code``` and after',
    '```json\nnot json\n```\nreal words here',
    ' {"content": "nbsp lead"} ',
]

VALIDATE = [
    ({"post_type": "post", "content": "hi"}, "skeptic"),
    ({"persona": "a", "post_type": "post"}, "skeptic"),
    ({"persona": "a", "post_type": "post", "content": ""}, "skeptic"),
    ({"persona": "a", "post_type": "bogus", "content": "hi"}, "skeptic"),
    ({"persona": "a", "post_type": "thread", "content": "hi", "thread_posts": [], "thread_count": 0}, "skeptic"),
    ({"persona": "a", "post_type": "thread", "content": "hi", "thread_posts": [" "], "thread_count": 1}, "skeptic"),
    ({"persona": "a", "post_type": "thread", "content": "hi", "thread_posts": ["one", "two"], "thread_count": 2}, "skeptic"),
    ({"persona": "a", "post_type": "thread", "content": "hi", "thread_posts": ["one", 2]}, "skeptic"),
    ({"persona": "a", "post_type": "thread", "content": "hi", "thread_posts": "nope"}, "skeptic"),
    ({"persona": "a", "post_type": "post", "content": "y" * 2000}, "skeptic"),
    ({"persona": "a", "post_type": "post", "content": "y" * 1999 + "\U0001F600" + "tail"}, "skeptic"),
    ({"persona": "a", "post_type": "post", "content": "\U0001F600" * 2001}, "skeptic"),
]

cases = []
for text in PARSE:
    try:
        cases.append({"fn": "parse", "input": text, "output": claude_client._parse_post_json(text)})
    except Exception as e:  # noqa: BLE001
        cases.append({"fn": "parse", "input": text, "raises": str(e)})

for post, key in VALIDATE:
    inp = copy.deepcopy(post)
    try:
        cases.append({"fn": "validate", "input": {"post": inp, "personaKey": key},
                      "output": validate_post_shape(post, persona_key=key)})
    except Exception as e:  # noqa: BLE001
        cases.append({"fn": "validate", "input": {"post": inp, "personaKey": key}, "raises": str(e)})

with open(os.path.join(out, "post-parse.json"), "w", encoding="utf-8") as f:
    json.dump(cases, f, ensure_ascii=False, indent=1)
print(len(cases))
