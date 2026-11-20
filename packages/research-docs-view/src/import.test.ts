import {afterEach,it,expect} from "vitest";
import type {Call} from "@claude-bot/research-docs-contract";
import type {ResearchNode} from "@claude-bot/research-canvas-contract";
import {importIntoDocuments} from "./import.js";
afterEach(()=>localStorage.clear());
it("resumes the frozen import after an uncertain receipt even when the live source changed",async()=>{
 const nodes=[{id:"root",type:"goal",title:"Original",summary:"Goal",data:{members:["agent"]}},{id:"agent",ref:"agent:stable",type:"agent",title:"Agent",summary:"Original task",data:{}}] as ResearchNode[];
 const created=new Map<string,{id:string;body:string}>();let lose=true;
 const call:Call=async(_action,p={})=>{
  const request=String(p.request),body=JSON.stringify(p);const prior=created.get(request);
  if(prior){expect(body).toBe(prior.body);return {id:prior.id} as never;}
  const item={id:"doc-"+created.size,body};created.set(request,item);
  if(created.size===2&&lose){lose=false;throw new Error("receipt lost");}
  return {id:item.id} as never;
 };
 await expect(importIntoDocuments(call,"source",nodes,"import")).rejects.toThrow("receipt lost");
 const journal=localStorage.getItem("import");expect(journal).toContain("Original");
 const first=await importIntoDocuments(call,"source",nodes.map(n=>({...n,title:"Changed",summary:"new"})),"import");
 expect(first).toBe("doc-0");expect(created.size).toBe(2);expect(localStorage.getItem("import")).toBeNull();
 expect([...created.values()].map(x=>x.body).join(" ")).not.toContain("Changed");
});
