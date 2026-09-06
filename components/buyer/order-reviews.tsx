"use client";
import { useRef, useState } from "react";
import { Star } from "lucide-react";

type Item = { id: string; productName: string; canReview: boolean; reviewId?: string };
export default function OrderReviews({ orders }: { orders: { id: string; orderNo: string; status: string }[] }) {
  const [orderId, setOrderId] = useState("");
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState("");
  const [rating, setRating] = useState(5);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const sequence = useRef(0);
  async function load(id: string) {
    const current = ++sequence.current;
    setOrderId(id); setItems([]); setSelected(""); setError("");
    if (!id) { setLoading(false); return; }
    setLoading(true);
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "订单读取失败");
      if (current === sequence.current) setItems(data.order.items);
    } catch (e) { if (current === sequence.current) setError(e instanceof Error ? e.message : "订单读取失败"); }
    finally { if (current === sequence.current) setLoading(false); }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (lock.current || !selected || !content.trim()) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const response = await fetch("/api/reviews", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ orderId, orderItemId: selected, rating, content }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "提交失败");
      setItems(previous => previous.map(item => item.id === selected ? { ...item, canReview: false, reviewId: data.review.id } : item));
      setSelected(""); setContent("");
    } catch (e) { setError(e instanceof Error ? e.message : "提交失败，请重试"); }
    finally { lock.current = false; setBusy(false); }
  }
  const completed = orders.filter(order => order.status === "closed");
  if (!completed.length) return null;
  return <section className="border-b bg-white p-4">
    <h3 className="mb-3 font-semibold">商品评价</h3>
    <select aria-label="选择评价订单" className="input w-full" value={orderId} disabled={busy} onChange={event => void load(event.target.value)}>
      <option value="">选择已完成订单</option>{completed.map(order => <option key={order.id} value={order.id}>{order.orderNo}</option>)}
    </select>
    {loading && <p role="status">正在加载...</p>}
    {error && <div role="alert" className="mt-3 text-sm text-red-700">{error}{!selected && <button type="button" className="ml-3 underline" onClick={() => void load(orderId)}>重试</button>}</div>}
    {items.map(item => <div key={item.id} className="flex flex-wrap items-center justify-between gap-3 border-b py-3 text-sm">
      <span className="min-w-0 break-all">{item.productName}</span>
      {item.reviewId ? <span className="text-emerald-700">已评价</span> : item.canReview ? <button disabled={busy} className="text-orange-700" onClick={() => { setSelected(item.id); setContent(""); setRating(5); setError(""); }}>评价商品</button> : <span className="text-gray-500">当前不可评价</span>}
    </div>)}
    {selected && <form onSubmit={submit} className="mt-3 space-y-3">
      <div role="group" aria-label="商品评分" className="flex gap-2">{[1,2,3,4,5].map(value => <button key={value} type="button" aria-label={`${value}星`} aria-pressed={value === rating} disabled={busy} onClick={() => setRating(value)} className="p-2 text-amber-600"><Star size={24} fill={value <= rating ? "currentColor" : "none"}/></button>)}</div>
      <textarea aria-label="评价内容" required maxLength={1000} disabled={busy} value={content} onChange={event => setContent(event.target.value)} className="input min-h-28 w-full" placeholder="评价内容"/>
      <button disabled={busy || !content.trim()} className="rounded-lg bg-orange-600 px-4 py-2 text-white disabled:opacity-50">{busy ? "提交中..." : "提交评价"}</button>
      <button type="button" disabled={busy} className="ml-3" onClick={() => setSelected("")}>取消</button>
    </form>}
  </section>;
}
