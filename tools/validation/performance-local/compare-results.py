#!/usr/bin/env python3
"""Compare independent, serial before/after captures. Python 3; no dependencies.
Usage: python3 compare-results.py <evidence-directory> [output.json]
Raises rather than accepting missing cases, changed outputs or mixed sources.
"""
import gzip
import hashlib
import json
from pathlib import Path
import statistics
import sys


def require(condition, message):
    if not condition:
        raise ValueError(message)


def main():
    if len(sys.argv) not in (2, 3):
        raise SystemExit(__doc__)
    root = Path(sys.argv[1]).resolve()
    destination = Path(sys.argv[2]) if len(sys.argv) == 3 else root / 'comparison.json'
    read = lambda name: json.loads((root / name).read_text(encoding='utf-8'))
    before = read('baseline-canonical.json')
    after = read('candidate-canonical.json')
    require(before['profile'] == after['profile'], 'measurement profile changed')
    for key in ('corpusSha256', 'profileSha256', 'node', 'v8', 'platform', 'arch', 'cpu', 'canonicalApi'):
        require(before['metadata'][key] == after['metadata'][key], f'metadata mismatch: {key}')
    for key in ('procedureVersion', 'repetitions', 'aggregate', 'publishedLedgers', 'runs'):
        require(before['result'][key] == after['result'][key], f'canonical mismatch: {key}')
    require(before['summaries'] == after['summaries'], 'case summaries changed')
    runs = before['result']['runs']
    require(len(runs) == before['result']['repetitions'], 'missing repetition')
    require(bool(runs) and all(run for run in runs), 'empty canonical run')
    canonical_count = sum(len(run) for run in runs)

    def metrics(b, a):
        return {'baselineMs': b, 'candidateMs': a, 'speedup': b / a,
                'reductionPercent': (1 - a / b) * 100, 'deltaMs': a - b}

    sources = {label: doc['metadata']['sourceManifest']['sha256']
               for label, doc in [('baseline', before), ('candidate', after)]}
    micro_docs = {}
    for label in sources:
        micro_docs[label] = [read(f'{label}-micro-round{round_no}.json') for round_no in (1, 2)]
        for doc in micro_docs[label]:
            require(doc['sourceManifest']['sha256'] == sources[label], 'micro source changed')
            for key in ('node', 'platform', 'arch', 'cpu'):
                require(doc[key] == before['metadata'][key], f'micro environment changed: {key}')
    names = [row['name'] for row in micro_docs['baseline'][0]['results']]
    require(len(names) == len(set(names)) and names, 'missing or duplicate micro cases')
    for docs in micro_docs.values():
        for doc in docs:
            require([row['name'] for row in doc['results']] == names, 'micro case set changed')
    micro = []
    for index, name in enumerate(names):
        rows = [doc['results'][index] for docs in micro_docs.values() for doc in docs]
        for key in ('iterations', 'warmupIterations', 'repetitions', 'outputSha256'):
            require(all(row[key] == rows[0][key] for row in rows), f'micro mismatch: {name}/{key}')
        samples = {label: [sample for doc in docs for sample in doc['results'][index]['samplesMs']]
                   for label, docs in micro_docs.items()}
        require(all(len(values) == 2 * rows[0]['repetitions'] for values in samples.values()),
                f'missing micro sample: {name}')
        micro.append({'name': name,
                      **metrics(statistics.median(samples['baseline']), statistics.median(samples['candidate'])),
                      'samplesPerVariant': len(samples['baseline']), 'outputSha256': rows[0]['outputSha256']})

    captures = {}
    captures_hashes = {}
    for label in sources:
        doc = read(f'{label}-capture-hashes.json')
        require(doc['metadata']['sourceManifest']['sha256'] == sources[label], 'capture source changed')
        with gzip.open(root / f'{label}-capture.jsonl.gz', 'rt', encoding='utf-8') as stream:
            captures[label] = [json.loads(line) for line in stream]
        captures_hashes[label] = doc['records']
        require([{k: v for k, v in record.items() if k != 'values'} for record in captures[label]]
                == doc['records'], 'capture index differs from payload')
    require(captures['baseline'] == captures['candidate'], 'full captured output changed')
    require(captures_hashes['baseline'] == captures_hashes['candidate'], 'capture hash index changed')
    records = captures['baseline']
    expected_ids = {(item['id'], optimize) for item in runs[0] for optimize in (False, True)}
    actual_ids = [(item['id'], item['phase8Optimize']) for item in records]
    require(len(actual_ids) == len(expected_ids) and set(actual_ids) == expected_ids, 'missing or duplicate capture case')
    present = absent = successes = failures = 0
    per_field = {}
    for record in records:
        if record.get('failure'):
            failures += 1
            continue
        successes += 1
        for field, descriptor in record['fields'].items():
            counts = per_field.setdefault(field, {'present': 0, 'absent': 0})
            value = record['values'][field]
            if descriptor['present']:
                require(isinstance(value, str), f'invalid captured text: {field}')
                data = value.encode('utf-8')
                require(len(data) == descriptor['bytes'], f'byte size mismatch: {field}')
                require(hashlib.sha256(data).hexdigest() == descriptor['sha256'], f'bad capture hash: {field}')
                present += 1
                counts['present'] += 1
            else:
                require(value is None and descriptor['bytes'] == 0 and descriptor['sha256'] is None,
                        f'invalid absent field: {field}')
                absent += 1
                counts['absent'] += 1
    rss_b = before['metadata']['maxRssKiB'] / 1024
    rss_a = after['metadata']['maxRssKiB'] / 1024
    result = {
        'sourceManifests': sources,
        'profileSha256': before['metadata']['profileSha256'],
        'corpusSha256': before['metadata']['corpusSha256'],
        'canonical': {**metrics(before['result']['coldActiveFunctionMs']['medianMs'],
                               after['result']['coldActiveFunctionMs']['medianMs']),
                      'baselineSamplesMs': before['result']['coldActiveFunctionMs']['samples'],
                      'candidateSamplesMs': after['result']['coldActiveFunctionMs']['samples'],
                      'exactMatchingObservations': canonical_count,
                      'runs': [{'inputs': row['inputs'], 'successes': row['successful'],
                                'failures': len(row['failures']), 'semantic': row['semantic'],
                                'publishedLedgers': row['publishedLedgers']} for row in before['summaries']],
                      'includesExistingFailedInputsInDenominator': True,
                      'maxRss': {'baselineMiB': rss_b, 'candidateMiB': rss_a, 'deltaMiB': rss_a - rss_b,
                                 'increasePercent': (rss_a / rss_b - 1) * 100}},
        'capture': {'exactMatchingCases': len(records), 'successes': successes, 'unchangedFailures': failures,
                    'exactMatchingPresentFields': present, 'matchingAbsentFields': absent, 'perField': per_field},
        'microProcedure': 'Each variant: seven samples in each of two separate processes; AB then BA; median of 14 samples.',
        'micro': micro,
        'limitations': ['Synthetic micro workloads are not browser/UI frame-time measurements.',
                        'Equality is established for recorded outputs, not a proof for every possible input.',
                        'Baseline Phase 8 full test exceeded the 300-second test-runner limit.',
                        'Overall repository checks and userscript build are not green.']}
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f"PASS: {canonical_count} observations, {len(records)} full captures, {present} present fields; "
          f"{len(micro)} micro output hashes across four processes.")
    print(f"Canonical reduction: {result['canonical']['reductionPercent']:.3f}%; output: {destination}")


if __name__ == '__main__':
    main()
