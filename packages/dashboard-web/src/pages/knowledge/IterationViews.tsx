import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { api, errorText } from "../../lib/api.js";
import { useDashboardLanguage } from "../../i18n/react.js";
import { uiText } from "../../i18n/ui-text.js";
import { ErrorBox, Loading } from "../../ui/misc.js";
import { UiButton } from "../../ui-kit/primitives.js";
import styles from "../KnowledgePage.module.css";

type Confirmation = {ref:string;kind:string;quote:string;actor:string;at:string};
type Source = {id:string;provider:string;device:string;session_id:string;message_id:string;source_at:string;role:string;source_sha256:string;text?:string;confirmations:Confirmation[]};
type Repair = {id:string;record_id:string;problem:string;state:string;observations:number;landed_sha?:string;investigation?:Record<string,string>;replay?:{graph_sha:string;generation:string;passed:boolean;at:string;outcomes:Array<{id:string;passed:boolean;missing:string[]}>}};

export function SourcesView() {
  useDashboardLanguage();
  const [after,setAfter]=useState("");
  const [selected,setSelected]=useState("");
  const [drafts,setDrafts]=useState<Record<string,string>>({});
  const [kinds,setKinds]=useState<Record<string,"requirement"|"endorsement">>({});
  const list=useQuery({queryKey:["knowledge","sources",after],queryFn:()=>api<{sources:Source[];next_after:string|null}>(`/api/knowledge/sources?after=${encodeURIComponent(after)}`)});
  const detail=useQuery({queryKey:["knowledge","source",selected],queryFn:()=>api<Source>(`/api/knowledge/sources?id=${encodeURIComponent(selected)}`),enabled:Boolean(selected)});
  const confirm=useMutation({mutationFn:(input:{id:string;source_sha256:string;kind:"requirement"|"endorsement";statement:string})=>api<Confirmation>("/api/knowledge/sources/confirm",{method:"POST",json:input}),onSuccess:()=>{void detail.refetch();}});
  return <section>
    <h3>{uiText("我的知识来源")}</h3>
    <p>{uiText("本地导入仅记录原文，不能证明人类身份。阅读后亲自写下具体要求或认可的设计，将创建一条新的确认。")}</p>
    <UiButton onClick={()=>{void list.refetch();}} disabled={list.isFetching}>{uiText("刷新")}</UiButton>
    {list.isLoading && <Loading />}{list.error && <ErrorBox>{errorText(list.error)}</ErrorBox>}
    {list.data?.sources.map(source=><p key={source.id}><button type="button" onClick={()=>setSelected(source.id)} aria-pressed={selected===source.id}>{source.provider} · {source.device} · {source.message_id}</button> <span>{source.source_at} · {source.role}</span></p>)}
    {list.data && !list.data.sources.length && <p>{uiText("没有来源记录。")}</p>}
    {after && <UiButton onClick={()=>setAfter("")}>{uiText("返回第一页")}</UiButton>}
    {list.data?.next_after && <UiButton onClick={()=>setAfter(list.data!.next_after!)}>{uiText("下一页")}</UiButton>}
    <div hidden={!selected}>
      {detail.isLoading && <Loading />}{detail.error && <ErrorBox>{errorText(detail.error)}</ErrorBox>}
      {detail.data && <>
        <p>{detail.data.provider} · {detail.data.device} · {detail.data.session_id} · {detail.data.message_id}</p>
        <pre style={{whiteSpace:"pre-wrap"}}>{detail.data.text}</pre>
        <form onSubmit={event=>{event.preventDefault();const source=detail.data!;confirm.mutate({id:source.id,source_sha256:source.source_sha256,kind:kinds[selected]??"requirement",statement:drafts[selected]??""});}}>
          <label>{uiText("具体确认")}<textarea className={styles.textarea} maxLength={120} value={drafts[selected]??""} onChange={e=>setDrafts({...drafts,[selected]:e.target.value})} /></label>
          <select aria-label={uiText("确认类型")} value={kinds[selected]??"requirement"} onChange={e=>setKinds({...kinds,[selected]:e.target.value as "requirement"|"endorsement"})}>
            <option value="requirement">{uiText("明确要求")}</option><option value="endorsement">{uiText("认可具体设计")}</option>
          </select>
          <UiButton htmlType="submit" disabled={confirm.isPending || detail.data.role!=="user" || (drafts[selected]??"").trim().length<8}>{confirm.isPending?uiText("提交中…"):uiText("提交本人确认")}</UiButton>
        </form>
        {confirm.variables?.id===selected && confirm.error && <ErrorBox>{errorText(confirm.error)}</ErrorBox>}
        {detail.data.confirmations.map(c=><blockquote key={c.ref}><p>{c.quote}</p><p>{c.actor} · {c.at}</p><code>{c.ref}</code></blockquote>)}
      </>}
    </div>
  </section>;
}
export function RepairsView() {
  useDashboardLanguage();
  const [after,setAfter]=useState("");
  const list=useQuery({queryKey:["knowledge","repairs",after],queryFn:()=>api<{repairs:Repair[];next_after:string|null}>(`/api/knowledge/repairs?after=${encodeURIComponent(after)}`)});
  const replay=useMutation({mutationFn:()=>api<{observed:number;verified:number;stale?:boolean}>("/api/knowledge/repairs",{method:"POST",json:{action:"replay"}}),onSuccess:()=>{void list.refetch();}});
  const state=(value:string)=>({candidate:uiText("待调查"),investigated:uiText("已调查"),landed:uiText("已落地，待验证"),verified:uiText("激活回放通过")}[value]??value);
  return <section><h3>{uiText("内容纠错")}</h3><p>{uiText("纠错候选不是设计裁决。修正经 Git 落地，匹配的知识产物激活并通过正反回放后才算验证完成。")}</p>
    <UiButton disabled={list.isFetching} onClick={()=>{void list.refetch();}}>{uiText("刷新")}</UiButton>
    <UiButton disabled={replay.isPending} onClick={()=>replay.mutate()}>{replay.isPending?uiText("验证中…"):uiText("回放当前产物")}</UiButton>
    {replay.data && <p>{uiText("本批观察 {v0} 条，通过 {v1} 条",{v0:String(replay.data.observed),v1:String(replay.data.verified)})}{replay.data.stale?uiText("产物已变化，请重新验证。"):""}</p>}
    {list.isLoading && <Loading />}{list.error && <ErrorBox>{errorText(list.error)}</ErrorBox>}{replay.error && <ErrorBox>{errorText(replay.error)}</ErrorBox>}
    {list.data?.repairs.map(repair=><article key={repair.id} className={styles.card}>
      <h4><Link to={`/knowledge?v=node&id=${encodeURIComponent(repair.record_id)}`}>{repair.record_id}</Link></h4>
      <p>{state(repair.state)} · {repair.problem} · {uiText("观察次数：{v0}",{v0:String(repair.observations)})}</p>
      {repair.investigation && <dl>{Object.entries(repair.investigation).filter(([key])=>key!=="record_id").map(([key,value])=><div key={key}><dt>{{original_motivation:uiText("原始动机"),proposed_motivation:uiText("调整动机"),proposed_behavior:uiText("拟定行为"),alternatives:uiText("替代方案"),impact:uiText("用户影响"),verification:uiText("验证依据")}[key]??key}</dt><dd>{value}</dd></div>)}</dl>}
      {repair.landed_sha && <p>{uiText("落地版本")} <code>{repair.landed_sha}</code></p>}
      {repair.replay && <><p>{repair.replay.at} · {repair.replay.generation}</p>{repair.replay.outcomes.map(outcome=><p key={outcome.id}>{outcome.id} · {outcome.passed?uiText("通过"):uiText("未通过")} {outcome.missing.join("; ")}</p>)}</>}
    </article>)}
    {list.data && !list.data.repairs.length && <p>{uiText("没有纠错候选。")}</p>}
    {after && <UiButton onClick={()=>setAfter("")}>{uiText("返回第一页")}</UiButton>}
    {list.data?.next_after && <UiButton onClick={()=>setAfter(list.data!.next_after!)}>{uiText("下一页")}</UiButton>}
  </section>;
}

export function ReportRepair({id,fingerprint}:{id:string;fingerprint:string}) {
  useDashboardLanguage();
  const [problems,setProblems]=useState<Record<string,string>>({});
  const report=useMutation({mutationFn:(input:{record_id:string;fingerprint:string;problem:string})=>api("/api/knowledge/repairs",{method:"POST",json:{action:"report",...input}})});
  return <form onSubmit={event=>{event.preventDefault();report.mutate({record_id:id,fingerprint,problem:problems[id]??"wrong_scope"});}}>
    <label>{uiText("内容问题")} <select value={problems[id]??"wrong_scope"} onChange={event=>setProblems({...problems,[id]:event.target.value})}>
      <option value="wrong_scope">{uiText("适用范围不准确")}</option><option value="wrong_lifecycle">{uiText("生命周期不准确")}</option><option value="invalid_anchor">{uiText("来源链接失效")}</option><option value="missing_slot">{uiText("检索内容缺失")}</option>
    </select></label>
    <UiButton htmlType="submit" disabled={report.isPending}>{report.isPending?uiText("提交中…"):uiText("报告内容问题")}</UiButton>
    {report.error && report.variables?.record_id===id && <ErrorBox>{errorText(report.error)}</ErrorBox>}
    {report.isSuccess && report.variables?.record_id===id && <Link to="/knowledge?v=repairs">{uiText("查看纠错队列")}</Link>}
  </form>;
}
