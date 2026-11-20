#!/usr/bin/env python3
"""Pin the dedicated container's model Runner to an owned lab candidate bundle."""
import argparse, hashlib, json, pathlib, re, shlex, subprocess, tempfile
p=argparse.ArgumentParser()
for key in ['head-host','runner-host','root','model-root','model-container','model-unit','lab','sha']:
    p.add_argument('--'+key,required=True)
a=p.parse_args()
for value in [a.head_host,a.runner_host,a.model_container,a.model_unit,a.lab]:
    assert re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_.-]{0,70}',value)
assert re.fullmatch(r'[0-9a-f]{40}',a.sha)
assert a.root.startswith('/') and '/.octopus-labs/' in a.model_root
assert a.model_unit.startswith('octopus-refactor-') and a.model_unit.endswith('.service')
def ssh(host,args,**kwargs):
    return subprocess.run(['ssh',host,shlex.join(args)],check=True,capture_output=True,**kwargs)
def text(host,args):return ssh(host,args,text=True).stdout.strip()
head=json.loads(text(a.head_host,['sudo','-n','docker','inspect','octopus-refactor-'+a.lab+'-head']))[0]
labels=head['Config']['Labels']
assert labels.get('octopus.role')=='refactor-lab' and labels.get('octopus.lab')==a.lab and labels.get('octopus.candidate')==a.sha
unit=text(a.runner_host,['systemctl','cat',a.model_unit]);assert a.model_root in unit and a.model_container in unit
scan=a.model_root+'/runners/model';target=scan+'/.octopus/runner/standalone.js'
code='import json;d=json.load(open('+repr(scan+'/.octopus/runner/config.json')+'));assert d["device"].startswith("lab_") and d.get("update_site")=="none";print("isolated")'
assert text(a.runner_host,['docker','exec','-u','ubuntu',a.model_container,'python3','-c',code])=='isolated'
bundle=a.root+'/releases/'+a.sha+'/packages/runner/dist/standalone.js'
expected=text(a.head_host,['sudo','-n','sha256sum',bundle]).split()[0]
with tempfile.TemporaryFile() as staged:
    subprocess.run(['ssh',a.head_host,shlex.join(['sudo','-n','cat',bundle])],stdout=staged,check=True)
    staged.seek(0);assert hashlib.file_digest(staged,'sha256').hexdigest()==expected;staged.seek(0)
    text(a.runner_host,['systemctl','stop',a.model_unit])
    try:
        # Fixed command, separately shell-quoted path; write under the isolated user's UID.
        command='umask 077; cat > '+shlex.quote(target+'.candidate')+' && mv '+shlex.quote(target+'.candidate')+' '+shlex.quote(target)
        subprocess.run(['ssh',a.runner_host,shlex.join(['docker','exec','-i','-u','ubuntu',a.model_container,'sh','-c',command])],stdin=staged,check=True)
        actual=text(a.runner_host,['docker','exec',a.model_container,'sha256sum',target]).split()[0]
        assert actual==expected
    finally:text(a.runner_host,['systemctl','start',a.model_unit])
assert text(a.runner_host,['systemctl','is-active',a.model_unit])=='active'
receipt={'schema':'octopus-refactor-runner/v1','role':'model','sha':a.sha,'bundleSha256':expected,'unit':a.model_unit}
raw=(json.dumps(receipt,indent=2)+'\n').encode()
ssh(a.head_host,['sudo','-n','tee',a.root+'/artifacts/model-runner-'+a.sha+'.json'],input=raw)
print(json.dumps(receipt))
