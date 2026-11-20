#!/usr/bin/env python3
"""Build the dependency inventory on CI from the exact archive being published.

No dependency install, filesystem extraction or mutable developer tree is used.
The bounded JSONL output is included in outputs.tar.gz and bound by release.json.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import sys
import tarfile


def module(name):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def build(archive, output):
    layer = module('release-layer')
    # Runs inside the dedicated 4090 release container, whose own cgroup is
    # the resource boundary; the service-side pacing does not apply here.
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_suffix('.partial')
    seen, links = set(), set()
    total = count = size = 0
    digest = hashlib.sha256()
    with open(partial, 'wb') as out, tarfile.open(archive, 'r|gz') as tar:
        for entry in tar:
            relative = layer.member_path(entry.name, 'dependencies')
            name = str(relative)
            if name in seen or any(str(parent) in links for parent in relative.parents) \
                    or entry.islnk() or not (entry.isfile() or entry.isdir() or entry.issym()):
                raise ValueError('unsafe dependency archive entry')
            seen.add(name)
            count += 1
            total += entry.size
            if count > 200000 or total > 8 * 1024 ** 3:
                raise ValueError('dependency archive exceeds budget')
            row = dict(path=name)
            if entry.isdir():
                row['type'] = 'directory'
            elif entry.issym():
                target = os.path.normpath(str(relative.parent / entry.linkname))
                if os.path.isabs(entry.linkname) or target == '..' or target.startswith('../'):
                    raise ValueError('dependency symlink leaves release')
                links.add(name)
                row.update(type='symlink', target=entry.linkname)
            else:
                h = hashlib.sha256()
                with tar.extractfile(entry) as source:
                    for data in iter(lambda: source.read(256 * 1024), b''):
                        h.update(data)
                # Match tarfile.data_filter: regular executability follows owner-x.
                row.update(type='file', size=entry.size, mode=0o555 if entry.mode & 0o100 else 0o444,
                           sha256=h.hexdigest())
            line = (json.dumps(row, separators=(',', ':')) + '\n').encode('utf8')
            size += len(line)
            if len(line) > 65536 or size > 64 * 1024 ** 2:
                raise ValueError('dependency inventory exceeds budget')
            digest.update(line)
            out.write(line)
            tar.members.clear()
        out.flush()
        os.fsync(out.fileno())
    if not count:
        raise ValueError('empty dependency archive')
    os.replace(partial, output)
    return dict(version=1, entries=count, payloadBytes=total, bytes=size, sha256=digest.hexdigest())


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit('usage: release-index.py DEPENDENCIES_ARCHIVE OUTPUT')
    print(json.dumps(build(*sys.argv[1:])))
