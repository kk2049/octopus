#!/usr/bin/env python3
"""Read-only promotion gate. Evidence never replaces land/deploy/health gates."""
import argparse,hashlib,json,pathlib,re,subprocess


def validate(manifest, artifacts, plan, inventory):
    sha=manifest.get('sha','')
    if not re.fullmatch(r'[0-9a-f]{40}',sha):raise ValueError('exact implementation SHA required')
    if manifest.get('schema')!='octopus-refactor-promotion/v1':raise ValueError('unknown promotion schema')
    if manifest.get('baseSha')!=plan['baseSha']:raise ValueError('mainline moved: reconcile and repeat acceptance')
    root=artifacts.resolve();receipts=[]
    for evidence in manifest.get('evidence',[]):
        file=(root/evidence['path']).resolve()
        if root not in file.parents:raise ValueError('evidence escapes artifact root')
        raw=file.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=evidence['sha256']:raise ValueError('evidence digest mismatch')
        receipt=json.loads(raw)
        if receipt.get('sha')!=sha:raise ValueError('evidence is for a different candidate')
        if receipt.get('passed') is not True:raise ValueError('pending/failed evidence cannot promote')
        receipts.append(receipt)
    consumers={item for row in receipts for item in row.get('consumerIds',[])}
    required={row['id'] for row in inventory['consumers']}
    if missing:=required-consumers:raise ValueError('missing real consumers: '+','.join(sorted(missing)))
    scenarios={item for row in receipts for item in row.get('scenarios',[])}
    if missing:=set(plan['scenarios'])-scenarios:raise ValueError('missing fault scenarios: '+','.join(sorted(missing)))
    checks={row.get('check') for row in receipts if row.get('kind')=='check' and row.get('exitCode')==0}
    if missing:=set(plan['checks'])-checks:raise ValueError('missing checks: '+','.join(sorted(missing)))
    for row in receipts:
        if row.get('consumerIds') and not row.get('realAgent'):raise ValueError('consumer evidence must exercise a real Agent')
    deployment=manifest.get('deployment',{})
    if deployment.get('sha')!=sha or not deployment.get('startupReady'):raise ValueError('candidate startup not verified')
    bundle=deployment.get('runnerSha256','')
    if not re.fullmatch(r'[0-9a-f]{64}',bundle):raise ValueError('candidate bundle digest missing')
    runners=manifest.get('runners',[])
    if {r.get('role') for r in runners}!={'model','execution'}:raise ValueError('both isolated Runner roles required')
    if any(r.get('bundleSha256')!=bundle or r.get('sha')!=sha or not r.get('online') for r in runners):raise ValueError('Runner watermarks differ or are offline')
    if not manifest.get('apps') or any(not app.get('active') or not re.fullmatch(r'[0-9a-f]{64}',app.get('packageDigest','')) for app in manifest['apps']):raise ValueError('candidate App releases not activated')
    required_apps={row['id'].split(':')[1] for row in inventory['consumers'] if row['id'].startswith('app:')}
    if {app.get('app') for app in manifest['apps']} != required_apps:raise ValueError('candidate App roster differs from consumer inventory')
    return {'schema':'octopus-refactor-promotion-result/v1','sha':sha,'baseSha':manifest['baseSha'],
            'readyForLanding':True,'consumers':sorted(consumers),'scenarios':sorted(scenarios),'checks':sorted(checks)}


def main():
    p=argparse.ArgumentParser()
    for name in ['repo','manifest','artifacts','base-sha']:p.add_argument('--'+name,required=True)
    a=p.parse_args();repo=pathlib.Path(a.repo).resolve()
    manifest=json.loads(pathlib.Path(a.manifest).read_text())
    plan=json.loads((repo/'architecture/managed-agent-acceptance.json').read_text());plan['baseSha']=a.base_sha
    inventory=json.loads((repo/'architecture/managed-agent-consumers.json').read_text())
    def git(*args):return subprocess.check_output(['git','-C',str(repo),*args],text=True).strip()
    if git('rev-parse','HEAD')!=manifest['sha']:raise ValueError('run on the exact implementation commit before adding the CLI report')
    if git('status','--porcelain','--untracked-files=no'):raise ValueError('dirty implementation tree')
    subprocess.run(['git','-C',str(repo),'merge-base','--is-ancestor',a.base_sha,manifest['sha']],check=True)
    print(json.dumps(validate(manifest,pathlib.Path(a.artifacts),plan,inventory),indent=2))


if __name__=='__main__':main()
