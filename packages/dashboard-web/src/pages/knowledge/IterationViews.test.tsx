import { screen,waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { it,expect } from "vitest";
import { renderPage } from "../../test-utils.js";
import { SourcesView,RepairsView } from "./IterationViews.js";

it("does not prefill human evidence, preserves drafts on refusal, and submits only the selected source",async()=>{
  const selected={id:"source-a",provider:"codex",device:"laptop",session_id:"session-a",message_id:"message-a",source_at:"2026-09-17",role:"user",source_sha256:"a".repeat(64),text:"原始私有消息",confirmations:[]};
  const requests:Array<{url:string;body:unknown}>=[];
  globalThis.fetch=(async(input,init)=>{
    const url=String(input);requests.push({url,body:init?.body?JSON.parse(String(init.body)):null});
    if(url.endsWith("/confirm"))return new Response(JSON.stringify({error:"原文已变化，重新核对"}),{status:400});
    return new Response(JSON.stringify(url.includes("?id=")?selected:{sources:[selected,{...selected,id:"source-b",message_id:"message-b"}],next_after:null}));
  }) as typeof fetch;
  renderPage(<SourcesView />);
  await userEvent.click(await screen.findByRole("button",{name:/message-a/}));
  const textarea=await screen.findByRole("textbox",{name:"具体确认"});
  expect(textarea).toHaveValue("");expect(screen.getByRole("button",{name:"提交本人确认"})).toBeDisabled();
  const statement="来源必须保持每个用户之间的隔离边界";
  await userEvent.type(textarea,statement);
  await userEvent.click(screen.getByRole("button",{name:"提交本人确认"}));
  expect(await screen.findByText("原文已变化，重新核对")).toBeInTheDocument();
  expect(textarea).toHaveValue(statement);
  expect(requests.filter(r=>r.url.endsWith("/confirm"))).toEqual([{url:"/api/knowledge/sources/confirm",body:{id:"source-a",source_sha256:selected.source_sha256,kind:"requirement",statement}}]);
  await userEvent.click(screen.getByRole("button",{name:/message-b/}));
  await userEvent.click(screen.getByRole("button",{name:/message-a/}));
  await waitFor(()=>expect(screen.getByRole("textbox",{name:"具体确认"})).toHaveValue(statement));
});
it("separates landed from verified and displays failed active replay outcomes",async()=>{
 globalThis.fetch=(async()=>new Response(JSON.stringify({repairs:[{id:"r1",record_id:"decision:one",problem:"wrong_scope",state:"landed",observations:2,landed_sha:"a".repeat(40),replay:{graph_sha:"a".repeat(40),generation:"g1",passed:false,at:"2026-09-17",outcomes:[{id:"J001.1",passed:false,missing:["forbidden:1"]}]}}],next_after:null}))) as typeof fetch;
 renderPage(<RepairsView />);
 expect(await screen.findByText(/已落地，待验证/)).toBeInTheDocument();
 expect(screen.getByText(/forbidden:1/)).toBeInTheDocument();
 expect(screen.queryByText("激活回放通过")).not.toBeInTheDocument();
});
