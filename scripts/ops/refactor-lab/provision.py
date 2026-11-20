#!/usr/bin/env python3
"""Create an empty owned builder; never copy production state or install a public listener."""
import argparse
import json
import pathlib
import re
import subprocess

p = argparse.ArgumentParser()
p.add_argument('--root', required=True)
p.add_argument('--name', required=True)
p.add_argument('--image', required=True)
p.add_argument('--origin-port', type=int, required=True)
p.add_argument('--dashboard-port', type=int, required=True)
p.add_argument('--runner-port', type=int, required=True)
p.add_argument('--pnpm-store')
a = p.parse_args()
root = pathlib.Path(a.root).resolve()
if root == pathlib.Path('/') or not re.fullmatch(r'[a-z][a-z0-9-]{1,31}', a.name):
    p.error('explicit isolated root and bounded lab name required')
ports = [a.origin_port, a.dashboard_port, a.runner_port]
if len(set(ports)) != 3 or any(port < 1024 or port > 65535 for port in ports):
    p.error('three distinct unprivileged ports required')
marker = {'schema': 'octopus-refactor-lab/v1', 'name': a.name, 'origin': f'http://127.0.0.1:{a.origin_port}',
          'dashboardPort': a.dashboard_port, 'runnerPort': a.runner_port}
if root.exists() and any(root.iterdir()):
    p.error('new empty directory required; use lab.py for an existing lab')
name = f'octopus-refactor-{a.name}'
prior = subprocess.run(['docker', 'inspect', name], capture_output=True)
if prior.returncode == 0:
    p.error('container already exists; refusing replacement')
image = json.loads(subprocess.check_output(['docker', 'image', 'inspect', a.image], text=True))[0]
mounts = ['--mount', f'type=bind,src={root},dst=/lab']
if a.pnpm_store:
    store = pathlib.Path(a.pnpm_store).resolve()
    if not store.is_dir() or root == store or root in store.parents:
        p.error('pnpm content store must exist outside the lab; never mount node_modules/dist')
    mounts += ['--mount', f'type=bind,src={store},dst=/work/pnpm-store']
root.mkdir(parents=True, exist_ok=True)
(root / '.refactor-lab').write_text(json.dumps(marker, indent=2) + '\n')
for entry in ['artifacts', 'releases', 'drivers', 'workspaces']:
    (root / entry).mkdir()
subprocess.run(['docker', 'run', '-d', '--init', '--name', name,
                '--label', 'octopus.role=refactor-lab', '--label', f'octopus.lab={a.name}',
                '--cpus', '4', '--memory', '10g', '--pids-limit', '2048', '--network', 'host',
                *mounts, '-w', '/lab', '--entrypoint', '/bin/sleep', image['Id'], 'infinity'], check=True, capture_output=True)
receipt = {**marker, 'schema': 'octopus-refactor-lab-provision/v1', 'root': str(root), 'builder': name,
           'image': image['Id'], 'seeded': False}
(root / 'artifacts/provision.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps(receipt))
