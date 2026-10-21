"""Differential contract for the compiled fnmatch-compatible rule matcher."""
import itertools
import json
from pathlib import Path
import random

import pytest

from poly_tally.rules import 规则_类


@pytest.mark.parametrize('patterns', [
    [], [''], ['**'], ['**/vendor/**'], ['**/**/vendor/**'],
    ['**/*.py', '*.md'], ['src/[a-z]?.py', '**/[!a-c]*.py'],
    ['[[]x].py', 'src/a?b.py', '**/目录/**'], ['*.PY', '**/Ü*.py'],
    ['**/x\\y.py', '**/line\nname.py'], ['[', '[]', '[!]', '[a--z]'],
])
def test_compiled_matcher_is_identical_to_recursive_fnmatchcase(patterns):
    match = 规则_类._编译匹配(patterns).match
    parts = ['', 'src', 'vendor', '目录', 'Ü', 'ü', 'x\\y', 'line\nname']
    names = ['', 'x.py', 'X.PY', 'file.md', 'ab.py', 'az.py', '[x].py', '[', '[]', '[!]']
    paths = names + ['/'.join((*prefix, name)) for prefix in itertools.product(parts, repeat=2) for name in names]
    for path in paths:
        assert bool(match(path)) == any(规则_类.api_匹配(path, pattern) for pattern in patterns), (patterns, path)


def test_compiled_matcher_generated_paths_match_current_production_patterns():
    config = json.loads((Path(__file__).parents[1] / 'config.json').read_text())['rules']
    randomizer = random.Random(20261021)
    fragments = ['src', 'log', 'vendor', 'results', 'README', 'a', 'B', '目录', 'ü', '[x]', '\n', '**', '.py', '.PY', '.json', '/', '']
    paths = [''.join(randomizer.choices(fragments, k=randomizer.randrange(0, 10))) for _ in range(4000)]
    for field in ('exclude', 'include', 'artifact_exclude', 'source_preserve'):
        patterns = config.get(field, [])
        match = 规则_类._编译匹配(patterns).match
        for path in paths:
            assert bool(match(path)) == any(规则_类.api_匹配(path, pattern) for pattern in patterns), (field, path)


def test_language_uses_compiled_groups_not_per_pattern_python_loop(monkeypatch):
    config = json.loads((Path(__file__).parents[1] / 'config.json').read_text())['rules']
    rules = 规则_类(config)
    calls = []
    original = 规则_类.api_匹配
    def counted(path, pattern):
        calls.append((path, pattern))
        return original(path, pattern)
    monkeypatch.setattr(规则_类, 'api_匹配', staticmethod(counted))
    assert rules.api_语言('src/parser.py') == 'Python'
    assert rules.api_语言('vendor/parser.py') is None
    assert rules.api_语言('docs/log/format.md') == 'Markdown'
    assert calls == []
