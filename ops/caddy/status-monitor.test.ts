import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("projects live WAL and rollback facts without publishing private deployment fields", () => {
  const result = execFileSync("python3", ["-c", `
import importlib.util,sqlite3,tempfile,json,subprocess,pathlib,time,sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('monitor','ops/caddy/status-monitor.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d);db=p/'bot.db';c=sqlite3.connect(db)
 c.execute('PRAGMA journal_mode=WAL')
 c.execute('CREATE TABLE deploy_intents(id,status,created_at,updated_at,target_sha,base_sha,detail)')
 c.execute("INSERT INTO deploy_intents VALUES(1,'health_gate','now','now','target','base','SECRET')");c.commit()
 m.subprocess.run=lambda *a,**k:type('R',(),{'stdout':'base'})()
 r=m.projection(str(db),d,100)
 assert r['status']=='rolling_back' and r['observed_at']==100
 assert 'SECRET' not in json.dumps(r) and 'target_sha' not in r and 'base_sha' not in r
 c.execute("UPDATE deploy_intents SET status='rolled_back'");c.commit()
 assert m.projection(str(db),d,101)['status']=='rolled_back'
 c.close()
 print('projection verified')
`], { cwd: process.cwd(), encoding: "utf8" });
  expect(result).toContain("projection verified");
});
