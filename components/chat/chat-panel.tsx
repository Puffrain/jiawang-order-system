"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, MessageCircle, PackagePlus, RefreshCw, Send } from "lucide-react";
import ImageMessage from "@/components/chat/image-message";
import ImageUploader from "@/components/chat/image-uploader";
import OrderMessageCard from "@/components/chat/order-message-card";
import ProductMessageCard, { RecommendedProduct } from "@/components/chat/product-message-card";
import ProductPicker, { ProductChoice } from "@/components/chat/product-picker";
import VoiceRecorder from "@/components/chat/voice-recorder";
import VoiceMessage from "@/components/chat/voice-message";
import { orderStatusLabel } from "@/lib/order-status";

type MessagePayload = {
  kind?: string;
  orderNo?: string;
  totalAmount?: number;
  version?: number;
  durationSeconds?: number;
  mediaId?: string | number;
  imageId?: string | number;
  productId?: string;
  productName?: string;
  name?: string;
  brand?: string;
  imageUrl?: string | null;
  price?: number | null;
  product?: RecommendedProduct;
};
type Message = { id: number; fromUserId: string; toUserId: string; orderId?: string; type: string; content: string; payload?: MessagePayload; orderNo?: string; orderTotal?: number; orderStatus?: string; createdAt: string };

function messageProduct(message: Message): RecommendedProduct | null {
  const payload = message.payload;
  const id = payload?.product?.id || payload?.productId;
  if (!id) return null;
  return payload?.product || { id, name: payload?.productName || payload?.name, brand: payload?.brand, imageUrl: payload?.imageUrl, price: payload?.price };
}

export default function ChatPanel({
  buyerUserId,
  currentUserId,
  onOpenOrder,
  title = "联系商户",
  canRecommendProducts = false,
}: {
  buyerUserId?: string;
  currentUserId: string;
  onOpenOrder?: (id: string) => void;
  title?: string;
  canRecommendProducts?: boolean;
}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [showProductPicker, setShowProductPicker] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const loading = useRef(false);
  const cursor = useRef(0);

  const load = useCallback(async (silent = false) => {
    if (loading.current) return;
    loading.current = true;
    if (!silent) setRefreshing(true);
    try {
      const params = new URLSearchParams();
      if (buyerUserId) params.set("buyerUserId", buyerUserId);
      if (cursor.current > 0) params.set("afterId", String(cursor.current));
      const response = await fetch(`/api/chat/messages${params.size ? `?${params}` : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error("消息连接暂时中断");
      const json = await response.json();
      const incoming: Message[] = json.messages || [];
      setMessages((current) => {
        if (!cursor.current) return incoming;
        const known = new Set(current.map((item) => item.id));
        return [...current, ...incoming.filter((item) => !known.has(item.id))];
      });
      cursor.current = Number(json.cursor || cursor.current);
      setError("");
      setUpdatedAt(new Date());
      await fetch("/api/chat/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ buyerUserId }) }).catch(() => null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "消息读取失败，请重试");
    } finally {
      loading.current = false;
      if (!silent) setRefreshing(false);
    }
  }, [buyerUserId]);

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const refresh = () => document.visibilityState === "visible" && void load(true);
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    return () => { window.clearTimeout(first); window.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [load]);
  useEffect(() => { bottom.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    if (!content.trim()) return;
    setSending(true);
    try {
      const response = await fetch("/api/chat/messages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ buyerUserId, content, clientMessageId: crypto.randomUUID() }) });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "发送失败");
      setContent("");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "发送失败，请重试");
    } finally {
      setSending(false);
    }
  };

  const sendProduct = async (product: ProductChoice) => {
    try {
      const response = await fetch("/api/chat/product", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ buyerUserId, productId: product.id, clientMessageId: crypto.randomUUID() }) });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "商品推荐发送失败");
      setShowProductPicker(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "商品推荐发送失败");
    }
  };

  return (
    <section className="flex min-h-[min(520px,calc(100dvh-180px))] flex-col overflow-hidden rounded-2xl bg-white sm:rounded-3xl">
      <header className="flex items-center justify-between border-b p-4">
        <div className="flex min-w-0 items-center gap-2"><MessageCircle className="shrink-0 text-orange-500" /><div className="min-w-0"><h2 className="truncate font-bold">{title}</h2><p className="text-[10px] text-slate-400">{updatedAt ? `更新于 ${updatedAt.toLocaleTimeString("zh-CN")}` : "正在加载"} · 每 30 秒增量刷新</p></div></div>
        <button type="button" disabled={refreshing} onClick={() => load()} className="grid h-10 w-10 place-items-center rounded-lg bg-slate-100 disabled:opacity-50" aria-label="刷新消息"><RefreshCw size={15} className={refreshing ? "animate-spin" : ""} /></button>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto bg-[#f7f8fb] p-3 sm:p-4">
        {messages.map((message) => {
          const mine = message.fromUserId === currentUserId;
          const mediaId = message.payload?.mediaId || message.payload?.imageId || (message.type === "image" ? message.id : undefined);
          const product = messageProduct(message);
          return <div key={message.id} className={`flex ${mine ? "justify-end" : "justify-start"}`}><div className={`max-w-[88%] rounded-2xl px-3 py-2 text-sm sm:max-w-[82%] ${message.type === "system" ? "w-full bg-orange-50 text-orange-900" : mine ? "bg-orange-500 text-white" : "bg-white text-slate-800 shadow-sm"}`}>
            {message.type === "voice" ? <VoiceMessage id={message.id} duration={message.payload?.durationSeconds} mine={mine} /> : message.type === "image" && mediaId ? <ImageMessage mediaId={mediaId} /> : message.type === "product" && product ? <ProductMessageCard product={product} /> : <p className="whitespace-pre-wrap break-words">{message.content}</p>}
            {message.orderId && <OrderMessageCard orderNo={message.payload?.orderNo || message.orderNo} total={message.payload?.totalAmount ?? message.orderTotal} status={message.orderStatus ? orderStatusLabel(message.orderStatus) : undefined} kind={message.payload?.kind} onClick={onOpenOrder?()=>onOpenOrder(message.orderId!):undefined} />}
            <p className={`mt-1 text-[10px] ${mine && message.type !== "system" ? "text-orange-100" : "text-slate-400"}`}>{new Date(message.createdAt).toLocaleString("zh-CN")}</p>
          </div></div>;
        })}
        {!messages.length && !refreshing && <p className="py-16 text-center text-sm text-slate-400">还没有消息，可以发送文字、图片或语音联系对方</p>}
        <div ref={bottom} />
      </div>
      {error && <div className="flex items-center justify-between gap-3 bg-amber-50 px-4 py-2 text-xs text-amber-800"><span className="flex items-center gap-1"><AlertTriangle size={13} className="shrink-0" />{error}，现有消息仍可查看。</span><button type="button" onClick={() => load()} className="shrink-0 font-semibold underline">重试</button></div>}
      <form onSubmit={send} className="flex flex-wrap items-center gap-2 border-t p-3 pb-[max(.75rem,env(safe-area-inset-bottom))]">
        <VoiceRecorder buyerUserId={buyerUserId} onSent={() => load()} onError={setError} />
        <ImageUploader buyerUserId={buyerUserId} onSent={() => load()} onError={setError} />
        {canRecommendProducts && <button type="button" onClick={() => setShowProductPicker(true)} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-slate-100 text-orange-600" title="推荐商品" aria-label="推荐商品"><PackagePlus size={18} /></button>}
        <input value={content} onChange={(event) => setContent(event.target.value)} maxLength={1000} placeholder="输入消息…" className="min-w-[10rem] flex-1 rounded-xl border border-slate-200 px-3 py-3 text-sm" />
        <button disabled={sending || !content.trim()} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-orange-500 text-white disabled:opacity-50" aria-label="发送文字消息"><Send size={17} /></button>
      </form>
      {canRecommendProducts && showProductPicker && <ProductPicker onPick={sendProduct} onClose={() => setShowProductPicker(false)} />}
    </section>
  );
}
