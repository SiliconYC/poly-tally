"""Keep the public synthetic benchmark reproducible and honest about its cache."""
import json
from pathlib import Path
import subprocess
import sys


def test_small_rebuild_benchmark_compares_fresh_and_incremental_states(tmp_path):
    repository = Path(__file__).parents[1]
    completed = subprocess.run([
        sys.executable, str(repository / 'scripts/benchmark-rebuild.py'),
        '--fixture', str(tmp_path / 'fixture'), '--commits', '5', '--files', '20',
        '--group-size', '5', '--blob-pool', '3', '--output', str(tmp_path / 'result.json'),
    ], check=True, capture_output=True, text=True)
    result = json.loads(completed.stdout)
    assert result == json.loads((tmp_path / 'result.json').read_text())
    measurements = {row['scenario']: row for row in result['measurements']}
    assert set(measurements) == {'local-cold-stage', 'raw-present-stats-empty', 'incremental'}
    assert len({row['outputSha256'] for row in measurements.values()}) == 1
    assert len({row['codeSha256'] for row in measurements.values()}) == 1
    assert all(row['snapshotCount'] == 5 for row in measurements.values())
    assert measurements['raw-present-stats-empty']['engineCounters']['parsedBlobs'] == 8
    assert measurements['raw-present-stats-empty']['engineCounters']['recomputedCommits'] == 5
    assert measurements['incremental']['engineCounters']['parsedBlobs'] == 1
    assert measurements['incremental']['engineCounters']['recomputedCommits'] == 1
    assert measurements['raw-present-stats-empty']['validationCounts']['pathChecks'] == 25
    assert 'No network transport measured' in ' '.join(result['caveats'])
