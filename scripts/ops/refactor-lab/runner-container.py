#!/usr/bin/env python3
"""Launch the candidate's credential-free execution Runner on the Docker lab host."""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess


def run(args):
    return subprocess.check_output(args, text=True).strip()


def inspect(name, lab, required=True):
    p = subprocess.run(['docker', 'inspect', name], text=True, capture_output=True)
    if p.returncode and not required:
        return None
    p.check_returncode()
    value = json.loads(p.stdout)[0]
    if value['Config'].get('Labels', {}).get('octopus.role') != 'refactor-lab' or value['Config']['Labels'].get('octopus.lab') != lab:
        raise RuntimeError('Refusing a container outside the named lab')
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--sha', required=True)
    args = parser.parse_args()
    root = pathlib.Path(args.root).resolve()
    if not re.fullmatch(r'[a-z][a-z0-9-]{1,31}', args.name) or not re.fullmatch(r'[0-9a-f]{40}', args.sha):
        parser.error('Invalid lab name or candidate SHA')
    if not (root / '.refactor-lab').is_file():
        parser.error('Explicitly marked lab required')
    builder = f'octopus-refactor-{args.name}'
    name = f'{builder}-execution'
    build = inspect(builder, args.name)
    candidate = root / 'releases' / args.sha
    if run(['docker', 'exec', '-w', f'/lab/releases/{args.sha}', builder, 'git', 'rev-parse', 'HEAD']) != args.sha:
        raise RuntimeError('Candidate checkout mismatch')
    bundle = candidate / 'packages/runner/dist/standalone.js'
    if not bundle.is_file() or not (root / 'bin/codex').is_file():
        raise RuntimeError('Build the candidate and provide an explicit Codex exec-server binary first')
    config = json.loads((root / 'runners/execution/.octopus/runner/config.json').read_text())
    if not config['device'].startswith('lab_') or config.get('update_site') != 'none' or config.get('execution_only'):
        raise RuntimeError('Execution Runner must have a lab identity, no updater and an exec-server host')
    prior = inspect(name, args.name, False)
    if prior:
        if prior['State']['Running']:
            run(['docker', 'stop', '--timeout', '40', name])
        run(['docker', 'rm', name])
    node = run(['docker', 'exec', builder, 'node', '-p', 'process.execPath'])
    run(['docker', 'run', '-d', '--init', '--name', name, '--user', '1000:1000',
         '--label', 'octopus.role=refactor-lab', '--label', f'octopus.lab={args.name}',
         '--label', f'octopus.candidate={args.sha}', '--restart', 'unless-stopped',
         '--cpus', '2', '--memory', '3g', '--pids-limit', '1024', '--network', 'host',
         '--mount', f'type=bind,src={root},dst=/lab', '-w', '/lab/runners/execution',
         '-e', 'RUNNER_SCAN_HOME=/lab/runners/execution', '-e', 'XDG_RUNTIME_DIR=/lab/runners/execution/runtime',
         '-e', 'RUNNER_AGENT_HOOKS=off', '-e', 'RUNNER_LOCAL_MCP=off',
         '-e', 'OCTOPUS_RUNNER_DSH_TUNNEL=0', '-e', 'RUNNER_KNOWLEDGE_INDEX=0',
         '-e', 'PATH=/lab/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
         '--entrypoint', node, build['Config']['Image'], f'/lab/releases/{args.sha}/packages/runner/dist/standalone.js', 'daemon'])
    receipt = {'schema': 'octopus-refactor-runner/v1', 'role': 'execution', 'sha': args.sha,
               'container': name, 'bundleSha256': hashlib.sha256(bundle.read_bytes()).hexdigest()}
    (root / 'artifacts' / f'execution-runner-{args.sha}.json').write_text(json.dumps(receipt, indent=2) + '\n')
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
