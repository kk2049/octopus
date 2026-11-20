"""Content-addressed release dependencies, with private directories and links.

Only regular read-only files are hard-linked. pnpm/workspace symlinks are
recreated in each checkout, so their relative targets remain release-local.
Each reused file is checked against the verified layer inventory before linking.
This is an integrity/cache boundary, not isolation from a malicious same-UID
operator capable of chmod'ing the shared files.
"""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import tarfile
import uuid


def identity(manifest):
    part = next(p for p in manifest['parts'] if p['name'] == 'dependencies')
    return dict(version=1, archive=part['sha256'], lock=manifest['lockSha256'],
                **{k: manifest[k] for k in ('node', 'nodeAbi', 'platform', 'arch')})


def key_for(manifest):
    return hashlib.sha256(json.dumps(identity(manifest), sort_keys=True,
                                    separators=(',', ':')).encode()).hexdigest()


def digest(file, budget):
    h = hashlib.sha256()
    with open(file, 'rb') as f:
        for data in iter(lambda: f.read(256 * 1024), b''):
            budget.step(len(data))
            h.update(data)
        if hasattr(os, 'posix_fadvise'):
            os.posix_fadvise(f.fileno(), 0, 0, os.POSIX_FADV_DONTNEED)
    return h.hexdigest()


def member_path(name, kind):
    p = PurePosixPath(name)
    if p.is_absolute() or '..' in p.parts or not p.parts:
        raise ValueError('unsafe release archive path')
    parts = p.parts
    root = 0 if parts[0] == 'node_modules' else 2
    if root == 2 and (len(parts) < 3 or parts[0] not in ('packages', 'plugins', 'tools')):
        raise ValueError('unexpected release archive root')
    expected = 'node_modules' if kind == 'dependencies' else 'dist'
    if len(parts) <= root or parts[root] != expected:
        raise ValueError('release archive contains non-output files')
    return p


def extract(archive, destination, kind, budget, index=None, max_bytes=8 * 1024 ** 3,
            expected=None, materialize_to=None):
    total = count = files = 0
    seen, links = set(), set()
    private_dirs = set()
    destination = Path(destination)
    with tarfile.open(archive, 'r|gz') as tar:
        for entry in tar:
            relative = member_path(entry.name, kind)
            name = str(relative)
            if name in seen or any(str(p) in links for p in relative.parents):
                raise ValueError('duplicate archive entry or symlink parent')
            seen.add(name)
            if entry.islnk() or not (entry.isfile() or entry.isdir() or entry.issym()):
                raise ValueError('unsupported release archive entry')
            total += entry.size
            count += 1
            if total > max_bytes or count > 200000:
                raise ValueError('release exceeds unpacked size or entry budget')
            filtered = tarfile.data_filter(entry, str(destination))
            budget.step(entries=1)
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            row = dict(path=name)
            if entry.isdir():
                if target.is_symlink():
                    raise ValueError('release directory is a symlink')
                target.mkdir(exist_ok=True)
                row['type'] = 'directory'
            elif entry.issym():
                link = PurePosixPath(entry.linkname)
                resolved = os.path.normpath(str(relative.parent / link))
                if link.is_absolute() or resolved == '..' or resolved.startswith('../'):
                    raise ValueError('release symlink leaves checkout')
                if target.is_symlink() or target.exists():
                    target.unlink()
                target.symlink_to(entry.linkname)
                links.add(name)
                row.update(type='symlink', target=entry.linkname)
            else:
                # A resumed install must never truncate a previously linked cache file.
                if target.exists() or target.is_symlink():
                    target.unlink()
                h = hashlib.sha256()
                with tar.extractfile(entry) as source, open(target, 'xb') as out:
                    for data in iter(lambda: source.read(256 * 1024), b''):
                        budget.step(len(data))
                        out.write(data)
                        h.update(data)
                mode = (0o555 if filtered.mode & 0o111 else 0o444) if index else filtered.mode
                target.chmod(mode)
                row.update(type='file', size=entry.size, mode=mode, sha256=h.hexdigest())
                files += 1
            line = None
            if expected is not None:
                line = expected.readline(65537)
                if len(line) > 65536 or not line.endswith('\n') or json.loads(line) != row:
                    raise ValueError('dependency archive differs from CI inventory: ' + name)
            if index:
                # CI owns inventory construction. On Head copy the verified row,
                # checking bytes as they are written, without a second file read.
                index.write(line if line is not None else json.dumps(row, separators=(',', ':')) + '\n')
            if materialize_to is not None:
                budget.step(entries=1)
                fresh_link(target, Path(materialize_to), relative, row, private_dirs)
            tar.members.clear()
        if expected is not None and expected.read(1):
            raise ValueError('CI inventory contains entries absent from dependency archive')
    return dict(bytes=total, entries=count, files=files)


def fresh_link(source, destination, relative, row, checked_dirs):
    """Only for a file verified in this same extraction, under the install lock.

    Interrupted first installs may reference another owned partial layer; replace
    the private directory entry, never truncate or chmod its shared inode.
    """
    target = destination / relative
    parent = target.parent
    if parent not in checked_dirs:
        if not parent.resolve().is_relative_to(destination.resolve()):
            raise ValueError('release dependency parent leaves checkout')
        parent.mkdir(parents=True, exist_ok=True)
        checked_dirs.add(parent)
    if row['type'] == 'directory':
        if target.is_symlink():
            raise ValueError('release dependency directory is a symlink')
        target.mkdir(exist_ok=True)
    else:
        if target.exists() or target.is_symlink():
            target.unlink()
        if row['type'] == 'symlink':
            target.symlink_to(row['target'])
        else:
            os.link(source, target, follow_symlinks=False)


def load(cache, manifest, budget):
    layer = Path(cache) / key_for(manifest)
    if not layer.exists():
        return None
    if layer.is_symlink():
        raise ValueError('dependency layer must not be a symlink')
    receipt = json.loads((layer / 'verified.json').read_text())
    if receipt.get('identity') != identity(manifest):
        raise ValueError('dependency layer identity mismatch')
    index = layer / 'files.jsonl'
    if index.stat().st_size > 64 * 1024 ** 2 or digest(index, budget) != receipt['inventorySha256']:
        raise ValueError('dependency layer inventory mismatch')
    return layer


def build(cache, manifest, archive, budget, atomic, destination=None, inventory=None,
          max_bytes=8 * 1024 ** 3):
    cache = Path(cache)
    cache.mkdir(parents=True, exist_ok=True)
    target = cache / key_for(manifest)
    partial = cache / (target.name + '.partial-' + uuid.uuid4().hex)
    payload = partial / 'payload'
    payload.mkdir(parents=True)
    atomic(partial / 'claim.json', identity(manifest))
    index = partial / 'files.jsonl'
    expected = open(inventory, encoding='utf8') if inventory is not None else None
    try:
        with open(index, 'x', encoding='utf8') as out:
            counts = extract(archive, payload, 'dependencies', budget, out, max_bytes,
                             expected=expected, materialize_to=destination)
            out.flush()
            os.fsync(out.fileno())
    finally:
        if expected is not None:
            expected.close()
    descriptor = manifest.get('dependencyIndex') if inventory is not None else None
    if descriptor and (counts['entries'] != descriptor['entries'] or counts['bytes'] != descriptor['payloadBytes']):
        raise ValueError('CI inventory totals differ from dependency archive')
    atomic(partial / 'verified.json', dict(identity=identity(manifest), **counts,
                                         inventorySource='ci' if descriptor else 'installer',
                                         inventorySha256=descriptor['sha256'] if descriptor else digest(index, budget)))
    # Prevent accidental writes; private release directories remain writable.
    for root, dirs, files in os.walk(partial, topdown=False, followlinks=False):
        budget.step(entries=1)
        Path(root).chmod(0o555)
    for file in ('files.jsonl', 'verified.json', 'claim.json'):
        (partial / file).chmod(0o444)
    os.rename(partial, target)
    fd = os.open(cache, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)
    return target


def prepared_index(manifest, destination, budget):
    """The optional CI inventory travels inside the already verified outputs part.

    Keeping the original two archives allows old installers to prepare the same
    self-contained package. They simply cannot use this optimization yet.
    """
    descriptor = manifest.get('dependencyIndex')
    if descriptor is None:
        return None
    archive = next(p['sha256'] for p in manifest['parts'] if p['name'] == 'dependencies')
    if not isinstance(descriptor, dict) or descriptor.get('version') != 1 \
            or descriptor.get('file') != 'packages/bot/dist/release-dependency-index.jsonl' \
            or descriptor.get('archiveSha256') != archive \
            or not re.fullmatch('[0-9a-f]{64}', str(descriptor.get('sha256', ''))) \
            or type(descriptor.get('bytes')) is not int or not 1 <= descriptor['bytes'] <= 64 * 1024 ** 2 \
            or type(descriptor.get('entries')) is not int or not 1 <= descriptor['entries'] <= 200000 \
            or type(descriptor.get('payloadBytes')) is not int or not 0 <= descriptor['payloadBytes'] <= 8 * 1024 ** 3:
        raise ValueError('invalid CI dependency inventory descriptor')
    file = Path(destination) / descriptor['file']
    if file.is_symlink() or not file.is_file() or file.stat().st_size != descriptor['bytes'] \
            or digest(file, budget) != descriptor['sha256']:
        raise ValueError('CI dependency inventory size or digest mismatch')
    return file


def materialize(layer, destination, budget):
    payload = layer / 'payload'
    destination = Path(destination)
    reused = total = entries = 0
    with open(layer / 'files.jsonl') as index:
        for line in index:
            entries += 1
            if entries > 200000 or len(line) > 65536:
                raise ValueError('dependency inventory exceeds budget')
            row = json.loads(line)
            relative = member_path(row['path'], 'dependencies')
            source, target = payload / relative, destination / relative
            budget.step(entries=1)
            target.parent.mkdir(parents=True, exist_ok=True)
            if row['type'] == 'directory':
                if target.is_symlink() or source.is_symlink() or not source.is_dir():
                    raise ValueError('dependency directory changed')
                target.mkdir(exist_ok=True)
            elif row['type'] == 'symlink':
                if not source.is_symlink() or os.readlink(source) != row['target']:
                    raise ValueError('dependency symlink changed')
                if target.is_symlink():
                    if os.readlink(target) != row['target']:
                        raise ValueError('partial release symlink changed')
                elif target.exists():
                    raise ValueError('dependency symlink destination occupied')
                else:
                    target.symlink_to(row['target'])
            elif row['type'] == 'file':
                info = source.lstat()
                if not source.is_file() or source.is_symlink() or info.st_size != row['size'] \
                        or info.st_mode & 0o777 != row['mode'] or info.st_mode & 0o222 \
                        or digest(source, budget) != row['sha256']:
                    raise ValueError('verified dependency file changed: ' + str(relative))
                if target.exists() or target.is_symlink():
                    if target.is_symlink() or target.stat().st_ino != info.st_ino \
                            or target.stat().st_dev != info.st_dev:
                        raise ValueError('partial release dependency differs')
                else:
                    os.link(source, target, follow_symlinks=False)
                reused += 1
                total += row['size']
            else:
                raise ValueError('invalid dependency inventory entry')
    return dict(filesReused=reused, bytesReused=total, entries=entries)
