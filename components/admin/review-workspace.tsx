"use client";
import { useEffect, useRef, useState } from "react";
import { Star } from "lucide-react";
type Review = { id:string; productName:string; orderNo:string; buyerName:string; rating:number; content:string; status:string; merchantReply:string|null };
export default function ReviewWorkspace() {
  const [items,setItems]=useState<Review[]>([]);
  const [q,setQ]=useState("");
  const [rating,setRating]=useState("");
  const [refresh,setRefresh]=useState(0);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [busy,setBusy]=useState("");
  const [reply,setReply]=useState<Record<string,string>>({});
  const lock=useRef(false);
  useEffect(()=>{
    const controller=new AbortController();
    setLoading(true); setError(""); setItems([]);
    const timer=setTimeout(async()=>{
      try {
        const response=await fetch(`/api/admin/reviews?q=${encodeURIComponent(q)}&rating=${rating}`,{cache:"no-store",signal:controller.signal});
        const data=await response.json();
        if(!response.ok) throw new Error(data.error||"评价加载失败");
        if(!controller.signal.aborted) setItems(data.reviews);
      } catch(e) { if(!controller.signal.aborted) setError(e instanceof Error?e.message:"评价加载失败"); }
      finally { if(!controller.signal.aborted) setLoading(false); }
    },250);
    return ()=>{clearTimeout(timer);controller.abort();};
  },[q,rating,refresh]);
  async function act(id:string,action:"reply"|"hide"|"restore") {
    if(lock.current) return;
    const value=(reply[id]||"").trim();
    if(action==="reply"&&!value) {setError("回复内容不能为空");return;}
    lock.current=true;setBusy(id);setError("");setNotice("");
    try {
      const response=await fetch("/api/admin/reviews",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({id,action,value})});
      const data=await response.json();
      if(!response.ok) throw new Error(data.error||"操作失败");
      setNotice("操作成功");setReply(previous=>({...previous,[id]:""}));setRefresh(value=>value+1);
    } catch(e) {setError(e instanceof Error?e.message:"操作失败，请重试");}
    finally {lock.current=false;setBusy("");}
  }
  return <section>
    <h1 className="text-xl font-bold">商品评价</h1>
    <div className="mt-4 flex flex-wrap gap-2">
      <input aria-label="搜索评价" placeholder="搜索商品、客户、订单" value={q} onChange={e=>setQ(e.target.value)} className="input min-w-0 flex-1"/>
      <select aria-label="星级筛选" value={rating} onChange={e=>setRating(e.target.value)} className="input"><option value="">全部星级</option>{[1,2,3,4,5].map(n=><option key={n} value={n}>{n} 星</option>)}</select>
    </div>
    {error&&<div role="alert" className="mt-3 text-sm text-red-700">{error}<button className="ml-3 underline" onClick={()=>setRefresh(n=>n+1)}>重新加载</button></div>}
    {notice&&<p role="status" className="mt-3 text-sm text-emerald-700">{notice}</p>}
    {loading?<p role="status" className="py-8 text-gray-500">正在加载评价...</p>:!items.length&&!error?<p className="py-8 text-gray-500">暂无评价</p>:null}
    {items.map(item=><article key={item.id} className="border-b py-5">
      <div className="flex flex-wrap justify-between gap-2"><div className="min-w-0 break-all"><h2 className="font-semibold">{item.productName}</h2><p className="text-xs text-gray-500">{item.buyerName} · {item.orderNo}</p></div><span aria-label={`${item.rating}星`} className="flex gap-1 text-amber-600">{[1,2,3,4,5].map(n=><Star key={n} size={16} fill={n<=item.rating?"currentColor":"none"}/>)}</span></div>
      <p className="mt-3 whitespace-pre-wrap break-all text-sm">{item.content}</p>
      <p className="mt-2 text-xs text-gray-500">{item.status==="hidden"?"已隐藏":"公开显示"}</p>
      {item.merchantReply&&<p className="mt-3 whitespace-pre-wrap break-all text-sm text-emerald-800">商户回复：{item.merchantReply}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {!item.merchantReply&&<><input aria-label={`回复 ${item.productName} 的评价`} maxLength={1000} disabled={Boolean(busy)} value={reply[item.id]||""} onChange={e=>setReply(previous=>({...previous,[item.id]:e.target.value}))} placeholder="回复客户" className="input min-w-0 flex-1"/><button disabled={Boolean(busy)||!(reply[item.id]||"").trim()} onClick={()=>void act(item.id,"reply")} className="rounded-lg bg-orange-600 px-4 py-2 text-white disabled:opacity-50">回复</button></>}
        <button disabled={Boolean(busy)} onClick={()=>void act(item.id,item.status==="hidden"?"restore":"hide")} className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50">{busy===item.id?"处理中...":item.status==="hidden"?"恢复显示":"隐藏评价"}</button>
      </div>
    </article>)}
  </section>;
}
