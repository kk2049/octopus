/** Fixed first-party worker shipped in Runner. Only the private device configuration supplies paths. */
export const MOSS_WORKER = String.raw`
import fcntl,itertools,json,math,os,pathlib,re,subprocess,sys,time,threading
p=json.loads(sys.argv[1]); os.umask(0o077)
job=pathlib.Path(p['job']); result=job/'result'; result.mkdir(exist_ok=True,mode=0o700)
started=time.monotonic(); sources=[]; mappings=[]; seams=[]; merged=[]; duration=0; manifest={}; last_inference={}
def save(path,value):
 t=path.with_suffix(path.suffix+'.tmp')
 with t.open('w') as h:
  h.write(json.dumps(value,ensure_ascii=False,indent=2)); h.flush(); os.fsync(h.fileno())
 t.replace(path)
 fd=os.open(str(path.parent),os.O_RDONLY); os.fsync(fd); os.close(fd)
def progress(status,**extra): save(result/'progress.json',{'status':status,**extra})
def bounded():
 if time.monotonic()-started>p.get('timeout',28800): raise RuntimeError('eight-hour job budget exceeded')
def load(run,offset,code):
 global last_inference
 raw=(run/'model-raw.txt').read_text() if (run/'model-raw.txt').exists() else ''
 inf=json.loads((run/'inference.json').read_text()) if (run/'inference.json').exists() else {}
 last_inference=inf
 parts=[]
 for i,m in enumerate(re.finditer(r'\[(\d+(?:\.\d+)?)\]\s*\[(S\d+)\](.*?)\[(\d+(?:\.\d+)?)\]',raw,re.S),1):
  a=float(m[1])+offset; b=float(m[4])+offset; body=m[3].strip()
  if not body or not all(math.isfinite(x) for x in [a,b]) or a<0 or b<=a or b>duration+1: raise RuntimeError('invalid source segment')
  if parts and a<parts[-1]['start']: raise RuntimeError('nonchronological source')
  parts.append({'start':a,'end':b,'voice':m[2],'text':body,'source_refs':[{'run':str(run),'id':f'D{i:06}','offset_seconds':offset}]})
 closed=bool(re.search(r'\[\d+(?:\.\d+)?\]\s*$',raw))
 openings=len(re.findall(r'\[\d+(?:\.\d+)?\]\s*\[S\d+\]',raw))
 if (closed and openings!=len(parts)) or openings>len(parts)+1: raise RuntimeError('unparsed utterances in source')
 sources.append({'run':str(run),'offset_seconds':offset,'exit_code':code,'raw_closed':closed,'parsed_segments':len(parts),'generated_tokens':inf.get('generated_tokens')})
 return parts,closed

def invoke(audio,out,title):
 bounded(); args=[p['script'],str(audio),'--out',str(out),'--title',title]
 if p.get('model_dir'): args+=['--model-dir',p['model_dir']]
 child=subprocess.Popen(args,cwd=p['cwd'],stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 def drain():
  written=0
  with (job/(out.name+'.log')).open('ab') as log:
   while True:
    data=child.stdout.read(16384)
    if not data: break
    if written<2097152:
     keep=data[:2097152-written]; log.write(keep); written+=len(keep)
 thread=threading.Thread(target=drain,daemon=True); thread.start()
 try: code=child.wait(timeout=max(1,p.get('timeout',28800)-(time.monotonic()-started)))
 except subprocess.TimeoutExpired:
  child.kill(); child.wait(); raise
 finally: thread.join(timeout=5)
 return code

def match(prefix,tail,offset):
 end=min(max(s['end'] for s in prefix),max(s['end'] for s in tail))
 a=sorted({s['voice'] for s in prefix}); b=sorted({s['voice'] for s in tail})
 if not a or len(a)!=len(b) or len(a)>6: raise RuntimeError('speaker mapping not identifiable across recovery overlap')
 scores={}; total=0
 for x in prefix:
  if x['end']<=offset: continue
  for y in tail:
   if y['start']>=end: break
   overlap=max(0,min(x['end'],y['end'],end)-max(x['start'],y['start'],offset))
   if overlap:
    scores[x['voice'],y['voice']]=scores.get((x['voice'],y['voice']),0)+overlap; total+=overlap
 ranking=[]
 for perm in itertools.permutations(a):
  mapping=dict(zip(b,perm)); score=sum(scores.get((v,k),0) for k,v in mapping.items()); ranking.append((score,mapping))
 ranking.sort(key=lambda x:x[0],reverse=True)
 best,mapping=ranking[0]; other=ranking[1][0] if len(ranking)>1 else 0
 if total<20 or best/total<.8 or (len(ranking)>1 and (best-other)/total<.25): raise RuntimeError('ambiguous speaker mapping; keep chunks for review')
 mappings.append({'offset_seconds':offset,'mapping':mapping,'comparable_seconds':total,'agreement':best/total,'runner_up':other/total})
 return mapping,end

def cutover(prefix,tail,start,end):
 points=sorted({start+20,end-10,*[s[k] for s in prefix+tail for k in ['start','end'] if start+20<s[k]<end-10]})
 options=[]
 for a,b in zip(points,points[1:]):
  if b-a<.03: continue
  mid=(a+b)/2
  if not any(s['start']<mid<s['end'] for s in prefix+tail): options.append(mid)
 if not options: raise RuntimeError('no shared silence boundary in recovery overlap')
 return min(options,key=lambda x:abs(x-(end-45)))

def export(complete,error=None):
 labels={}; segments=[]; raw=[]; lines=['# '+p['title']+'：带讲话人的完整转写' if complete else '# '+p['title']+'：部分转写（完整性待审）','',
 '匿名讲话人标签仅表示这份录音中的声音；未核验实名，未人工逐句听审。','']
 for i,s in enumerate(merged,1):
  voice=s['voice']; labels.setdefault(voice,chr(65+len(labels)))
  row={'id':f'D{i:06}','start':s['start'],'end':s['end'],'speaker':labels[voice],'model_speaker':voice,'text':s['text'],'source_refs':s['source_refs']}
  segments.append(row); raw.append(f"[{s['start']:.2f}][{voice}]{s['text']}[{s['end']:.2f}]")
  lines += [f"[{row['id']} {s['start']:.2f}–{s['end']:.2f}s] **说话人 {row['speaker']}**：{s['text']}",'']
 last=max([s['end'] for s in merged],default=0)
 recovery={'sources':sources,'speaker_mapping':mappings,'seams':seams,'budget':3,'error':error} if len(sources)>1 or error else None
 save(result/'manifest.json',manifest); save(result/'segments.json',segments)
 (result/'model-raw.txt').write_text('\n'.join(raw)+'\n'); (result/'dialogue.md').write_text('\n'.join(lines))
 save(result/'quality.json',{'segments':len(segments),'last_segment_end':last,'tail_review_required':not complete or duration-last>30,
  'trailing_audio_seconds':max(0,duration-last),'recovered':len(sources)>1,'source_errors':error,'human_audio_review':False,'speaker_identity_verified':False})
 save(result/'inference.json',{'generated_tokens':last_inference.get('generated_tokens'), 'total_generated_tokens':sum(s.get('generated_tokens') or 0 for s in sources)})
 if recovery: save(result/'recovery.json',recovery)
 if complete: save(result/'complete.json',{'status':'recovered_machine_transcript_complete' if len(sources)>1 else 'machine_transcription_complete'})
 progress('complete' if complete else 'needs_review')

if p.get('durable'):
 stat=pathlib.Path('/proc/self/stat').read_text(); ticks=stat[stat.rfind(')')+2:].split()[19]
 save(job/'pid.json',{'pid':os.getpid(),'ticks':ticks})
try:
 lock=(pathlib.Path(p['root'])/'.meeting-transcription.lock').open('a+')
 while True:
  bounded()
  try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB); break
  except BlockingIOError: progress('waiting_for_gpu'); time.sleep(10)
 progress('transcribing')
 first=job/'asr'; code=invoke(p['input'],first,p['title'])
 manifest=json.loads((first/'manifest.json').read_text()); duration=float(manifest['settings']['duration_seconds'])
 merged,closed=load(first,0,code)
 if not merged: raise RuntimeError('no complete source utterances')
 token_limited=(last_inference.get('generated_tokens') or 0)>=manifest['settings']['max_new_tokens']
 complete=code==0 and closed and not token_limited and duration-max(s['end'] for s in merged)<=30
 for attempt in range(1,4):
  if complete: break
  bounded(); last=max(s['end'] for s in merged); offset=max(0,last-120); length=min(1200,duration-offset)
  if length<=0: raise RuntimeError('invalid recovery audio window')
  progress('recovering',attempt=attempt,offset_seconds=offset)
  audio=job/f'recovery-{attempt}.wav'; out=job/f'recovery-{attempt}'
  subprocess.run(['ffmpeg','-nostdin','-hide_banner','-loglevel','error','-ss',str(offset),'-i',p['input'],'-t',str(length),'-ac','1','-ar','16000',str(audio)],check=True,timeout=max(1,min(120,p.get('timeout',28800)-(time.monotonic()-started))))
  code=invoke(audio,out,p['title']+f' · recovery {attempt}')
  tail,closed=load(out,offset,code)
  if not tail or max(s['end'] for s in tail)<=last+1: raise RuntimeError('recovery did not advance verified coverage')
  mapping,end=match(merged,tail,offset); seam=cutover(merged,tail,offset,end)
  prefix=[s for s in merged if s['end']<=seam]; addition=[{**s,'voice':mapping[s['voice']]} for s in tail if s['start']>=seam]
  if not prefix or not addition: raise RuntimeError('empty merge side')
  seams.append({'offset_seconds':offset,'cutover_seconds':seam,'prefix_segments':len(prefix),'tail_segments':len(addition),
   'omitted_prefix_overlap':len(merged)-len(prefix),'omitted_tail_overlap':len(tail)-len(addition)})
  merged=prefix+addition
  token_limited=(last_inference.get('generated_tokens') or 0)>=manifest['settings']['max_new_tokens']
  complete=code==0 and closed and not token_limited and duration-max(s['end'] for s in merged)<=30
  audio.unlink(missing_ok=True)
 if not complete: raise RuntimeError('recovery budget exhausted before full tail coverage')
 export(True)
 save(job/'exit.json',{'exit_code':0})
except Exception as error:
 if merged and manifest: export(False,str(error))
 save(job/'exit.json',{'exit_code':1,'error':str(error)})
 sys.exit(1)
`;
