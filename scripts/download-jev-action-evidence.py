"""Download Actions evidence without merging artifacts whose names collide.

Usage: python scripts/download-jev-action-evidence.py RUN_ID PERSISTENT_DEST
Names are display labels; run and artifact IDs are the storage identity.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import zipfile


def artifact_destination(root, run_id, artifact_id):
    if type(run_id) is not int or type(artifact_id) is not int or min(run_id, artifact_id) <= 0:
        raise ValueError('positive exact run/artifact IDs required')
    root = Path(root).resolve()
    if not root.is_relative_to(Path('/mnt/workspace/.dev-state/agent-work/evidence')):
        raise ValueError('persistent evidence root required')
    destination = root / f'artifacts-{run_id}' / f'artifact-{artifact_id}'
    if not destination.resolve().is_relative_to(root):
        raise ValueError('artifact destination escapes persistent evidence')
    return destination


def validate_archive(archive, destination):
    entries = archive.infolist()
    if len(entries) > 100_000 or sum(entry.file_size for entry in entries) > 2 * 1024**3:
        raise ValueError('artifact exceeds extraction budget')
    seen = set()
    for entry in entries:
        name = PurePosixPath(entry.filename)
        if name.is_absolute() or '..' in name.parts or not name.parts or '\\' in entry.filename:
            raise ValueError('unsafe archive path')
        if str(name) in seen or stat.S_ISLNK(entry.external_attr >> 16):
            raise ValueError('duplicate archive identity or symlink')
        seen.add(str(name))
        if not (destination / str(name)).resolve().is_relative_to(destination.resolve()):
            raise ValueError('archive target escapes artifact')


def atomic_json(path, value):
    pending = path.with_name(path.name + '.pending')
    pending.write_text(json.dumps(value, indent=2) + '\n')
    os.replace(pending, path)


def main(run_id, root):
    root = Path(root).resolve()
    # Validate before any directory or evidence write.
    artifact_destination(root, run_id, 1)
    root.mkdir(parents=True, exist_ok=True)
    listing = json.loads(subprocess.check_output([
        'gh', 'api', f'repos/rhgrive3/actions/actions/runs/{run_id}/artifacts']))
    if listing.get('total_count') != len(listing.get('artifacts', [])):
        raise ValueError('partial artifact listing; pagination required')
    atomic_json(root / f'artifacts-{run_id}-list.json', listing)
    for artifact in listing['artifacts']:
        artifact_id = artifact['id']
        if artifact.get('expired'):
            raise ValueError('expired artifact is not evidence')
        destination = artifact_destination(root, run_id, artifact_id)
        destination.parent.mkdir(parents=True, exist_ok=True)
        archive_file = destination.with_suffix('.zip')
        receipt_file = destination / 'download-receipt.json'
        if destination.exists():
            if not receipt_file.is_file() or not archive_file.is_file():
                raise ValueError('partial prior download retained; use a separate evidence root')
            receipt = json.loads(receipt_file.read_text())
            if receipt.get('runId') != run_id or receipt.get('artifact', {}).get('id') != artifact_id \
                    or receipt.get('zipSha256') != hashlib.sha256(archive_file.read_bytes()).hexdigest():
                raise ValueError('prior artifact receipt does not bind downloaded bytes')
            continue
        pending_archive = archive_file.with_name(archive_file.name + '.pending')
        with pending_archive.open('wb') as output:
            subprocess.run(['gh', 'api', '--allow-escape-sequences',
                            f'repos/rhgrive3/actions/actions/artifacts/{artifact_id}/zip'],
                           stdout=output, check=True)
        pending_destination = destination.with_name(destination.name + '.pending')
        pending_destination.mkdir(exist_ok=False)
        with zipfile.ZipFile(pending_archive) as archive:
            validate_archive(archive, pending_destination)
            archive.extractall(pending_destination)
        atomic_json(pending_destination / 'download-receipt.json', {
            'runId': run_id, 'artifact': artifact,
            'zipSha256': hashlib.sha256(pending_archive.read_bytes()).hexdigest()})
        os.replace(pending_archive, archive_file)
        os.replace(pending_destination, destination)
        print(artifact_id, artifact['name'], flush=True)


if __name__ == '__main__':
    main(int(sys.argv[1]), sys.argv[2])
