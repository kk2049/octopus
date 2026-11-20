import hashlib,json,pathlib,tempfile,unittest
from promotion import validate

class PromotionGateTest(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=pathlib.Path(self.tmp.name)
        self.sha='a'*40;self.base='b'*40;self.bundle='c'*64
        self.plan={'baseSha':self.base,'scenarios':['minute-visible-wait'],'checks':['focused-tests']}
        self.inventory={'consumers':[{'id':'ticket'},{'id':'app:demo:writer'}]}
        self.receipt={'sha':self.sha,'passed':True,'realAgent':True,'consumerIds':['ticket','app:demo:writer'],'scenarios':['minute-visible-wait'],'kind':'check','check':'focused-tests','exitCode':0}
        self.manifest={'schema':'octopus-refactor-promotion/v1','sha':self.sha,'baseSha':self.base,
          'deployment':{'sha':self.sha,'startupReady':True,'runnerSha256':self.bundle},
          'runners':[{'sha':self.sha,'role':role,'bundleSha256':self.bundle,'online':True} for role in ['model','execution']],
          'apps':[{'app':'demo','packageDigest':'d'*64,'active':True}]}
        self.write()
    def write(self):
        raw=json.dumps(self.receipt).encode();(self.root/'case.json').write_bytes(raw)
        self.manifest['evidence']=[{'path':'case.json','sha256':hashlib.sha256(raw).hexdigest()}]
    def check(self):return validate(self.manifest,self.root,self.plan,self.inventory)
    def test_complete_candidate(self):self.assertTrue(self.check()['readyForLanding'])
    def test_no_pass_from_old_candidate_or_pending_case(self):
        self.receipt['sha']='e'*40;self.write()
        with self.assertRaisesRegex(ValueError,'different candidate'):self.check()
        self.receipt['sha']=self.sha;self.receipt['passed']=False;self.write()
        with self.assertRaisesRegex(ValueError,'pending/failed'):self.check()
    def test_new_consumer_and_mainline_move_close_gate(self):
        self.inventory['consumers'].append({'id':'new-agent'})
        with self.assertRaisesRegex(ValueError,'missing real consumers'):self.check()
        self.manifest['baseSha']='f'*40
        with self.assertRaisesRegex(ValueError,'mainline moved'):self.check()
    def test_artifact_tampering_and_wrong_runner(self):
        (self.root/'case.json').write_text('{}')
        with self.assertRaisesRegex(ValueError,'digest mismatch'):self.check()
        self.write();self.manifest['runners'][1]['bundleSha256']='f'*64
        with self.assertRaisesRegex(ValueError,'watermarks differ'):self.check()
    def test_missing_app_release(self):
        self.manifest['apps'][0]['app']='unrelated'
        with self.assertRaisesRegex(ValueError,'App roster'):self.check()
    def test_unit_only_receipt_cannot_claim_consumer(self):
        self.receipt['realAgent']=False;self.write()
        with self.assertRaisesRegex(ValueError,'real Agent'):self.check()
if __name__=='__main__':unittest.main()
