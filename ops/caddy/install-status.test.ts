import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("restores the previous observer unit when the guarded Caddy activation fails", () => {
  const result = execFileSync("python3", ["-c", `
import importlib.util,pathlib,tempfile,json,time,pwd,os,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('installer','ops/caddy/install-status.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d)/'root';unit=pathlib.Path(d)/'observer.service';unit.write_text('previous unit')
 calls=[]
 def run(*args):
  calls.append(args)
  if 'rev-parse' in args:return 'a'*40
  if 'restart' in args:
   (root/'status/status.json').write_text(json.dumps({'observed_at':time.time()*1000,'status':'idle'}))
  if '--apply' in args:raise RuntimeError('Caddy reload refused')
  return ''
 m.run=run
 m.os.geteuid=lambda:0
 m.os.chown=lambda *args:None
 m.subprocess.run=lambda *a,**k:type('R',(),{'returncode':0})()
 try:m.install(pathlib.Path.cwd(),True,root,unit,pwd.getpwuid(os.getuid()).pw_name)
 except RuntimeError as e:assert str(e)=='Caddy reload refused'
 else:raise AssertionError('expected refusal')
 assert unit.read_text()=='previous unit'
 assert ('systemctl','start',unit.name) in calls
 assert ('systemctl','stop',unit.name) in calls
 print('observer rollback verified')
`], { encoding: "utf8" });
  expect(result).toContain("observer rollback verified");
});
