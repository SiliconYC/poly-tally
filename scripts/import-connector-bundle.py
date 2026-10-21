#!/usr/bin/env python3
"""Import already authorized GitHub connector objects; never authenticate/fetch."""
import argparse
import json
from pathlib import Path
import sys

# Also works directly from an uninstalled source checkout.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from poly_tally.connector_bundle import ConnectorBundle, import_bundle
from poly_tally.export import 公开导出_类
from poly_tally.rules import 规则_类


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    parser.add_argument('--config', type=Path, default=Path('config.json'))
    parser.add_argument('--dataset-epoch')
    parser.add_argument('--state', type=Path, default=Path('.poly-tally'))
    parser.add_argument('--expected-inventory', type=Path)
    parser.add_argument('--output', type=Path, help='Optional sanitized public statistics output')
    parser.add_argument('--private-metrics-output', type=Path, help='Only sanitized day-level private metrics, never raw facts')
    parser.add_argument('--include-private-metrics', action='store_true')
    parser.add_argument('--validate-only', action='store_true', help='Validate available captured repositories without initializing state/exporting')
    parser.add_argument('--repository-id', action='append', help='Validate only these captured IDs (only with --validate-only)')
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument('--private-only', action='store_true')
    scope.add_argument('--public-only', action='store_true')
    args = parser.parse_args()
    config = json.loads(args.config.read_text(encoding='utf-8'))
    if args.private_metrics_output and not args.include_private_metrics:
        parser.error('--private-metrics-output requires --include-private-metrics')
    if args.repository_id and not args.validate_only:
        parser.error('--repository-id is only supported for --validate-only; partial import is forbidden')
    if args.validate_only:
        if args.output or args.private_metrics_output:
            parser.error('--validate-only does not publish data')
        audit = ConnectorBundle(args.bundle, 规则_类(config['rules'])).validate(args.repository_id)
        print(json.dumps({'validated': True, 'audit': audit}, ensure_ascii=False))
        return 0
    epoch = args.dataset_epoch or config.get('datasetEpoch')
    if not epoch:
        parser.error('a new --dataset-epoch or config.datasetEpoch is required')
    expected = json.loads(args.expected_inventory.read_text(encoding='utf-8')) if args.expected_inventory else None
    result = import_bundle(args.bundle, config, args.state / 'epochs' / epoch, epoch,
                           expected_inventory=expected, private_only=args.private_only, public_only=args.public_only,
                           include_private_metrics=args.include_private_metrics)
    if args.output:
        公开导出_类.api_原子写入(args.output, result['public'])
    if args.private_metrics_output:
        公开导出_类.api_原子写入(args.private_metrics_output, result['private'])
    # Only counts and verification descriptors; raw paths/SHA/source stay local.
    print(json.dumps({'complete': True, 'datasetEpoch': epoch, 'captureScope': result['audit']['captureScope'],
                      'run': result['run'], 'audit': result['audit']}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (ValueError, OSError, RuntimeError) as exc:
        print(f'Connector import refused: {exc}', file=sys.stderr)
        raise SystemExit(1)
