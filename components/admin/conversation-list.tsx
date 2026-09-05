"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  MessageCircle,
  RefreshCw,
  Search,
  Send,
  Store,
  Trash2,
  UserPlus,
  UserRound,
  Users,
  X,
} from "lucide-react";
import ChatPanel from "@/components/chat/chat-panel";

type Conversation = {
  buyerUserId: string;
  customerName?: string;
  shopName?: string;
  phone: string;
  lastMessage?: string;
  unreadCount: number;
  updatedAt?: string;
};
type Customer = {
  id: string;
  displayName?: string;
  shopName?: string;
  phone: string;
  status: "active" | "disabled";
};
type Product = {
  id: string;
  name: string;
  brand?: string;
  status: "active" | "inactive";
  archived?: boolean;
};

const customerLabel = (customer?: Customer) =>
  customer?.shopName || customer?.displayName || customer?.phone || "客户";

export default function ConversationList({
  initialBuyerUserId,
  onUnread,
  onOpenOrder,
}: {
  initialBuyerUserId?: string | null;
  onUnread?: (count: number) => void;
  onOpenOrder?: (orderId: string) => void;
}) {
  const [items, setItems] = useState<Conversation[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [selected, setSelected] = useState<string | undefined>(
    initialBuyerUserId || undefined,
  );
  const [ownerId, setOwnerId] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [query, setQuery] = useState("");

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [conversationResponse, meResponse, customerResponse] =
          await Promise.all([
            fetch("/api/chat/conversations", { cache: "no-store" }),
            fetch("/api/auth/me", { cache: "no-store" }),
            fetch("/api/customers", { cache: "no-store" }),
          ]);
        if (!conversationResponse.ok || !meResponse.ok || !customerResponse.ok)
          throw new Error("消息服务暂时不可用");
        const [conversations, me, customerData] = await Promise.all([
          conversationResponse.json(),
          meResponse.json(),
          customerResponse.json(),
        ]);
        const rows: Conversation[] = conversations.conversations || [];
        setItems(rows);
        setCustomers(
          (customerData.customers || []).filter(
            (customer: Customer) => customer.status === "active",
          ),
        );
        onUnread?.(conversations.unreadTotal || 0);
        setOwnerId(me.user?.id || "");
        setSelected((current) => current || rows[0]?.buyerUserId);
        setError("");
        setUpdatedAt(new Date());
      } catch (reason) {
        setError(
          reason instanceof Error ? reason.message : "消息读取失败，请重试",
        );
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [onUnread],
  );

  useEffect(() => {
    const first = window.setTimeout(() => void load(), 0);
    const refresh = () =>
      document.visibilityState === "visible" && void load(true);
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [load]);
  useEffect(() => {
    if (!initialBuyerUserId) return;
    const timer = window.setTimeout(() => setSelected(initialBuyerUserId), 0);
    return () => window.clearTimeout(timer);
  }, [initialBuyerUserId]);

  const current = items.find((item) => item.buyerUserId === selected);
  const currentCustomer = customers.find(
    (customer) => customer.id === selected,
  );
  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return items;
    return items.filter((item) =>
      `${item.customerName || ""} ${item.shopName || ""} ${item.phone} ${item.lastMessage || ""}`
        .toLowerCase()
        .includes(keyword),
    );
  }, [items, query]);

  const updateConversation = async (action: "clear" | "hide") => {
    if (!selected) return;
    const label =
      action === "clear" ? "清空当前对话的消息记录" : "从列表隐藏当前对话";
    if (!window.confirm(`${label}？此操作需要确认。`)) return;
    try {
      const response = await fetch("/api/chat/conversations", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ buyerUserId: selected, action }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "对话操作失败");
      setSelected(undefined);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "对话操作失败");
    }
  };

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">客户消息</h2>
          <p className="mt-1 text-sm text-slate-500">
            订单、报价确认和日常沟通都在同一个客户会话中
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {updatedAt
              ? `上次刷新：${updatedAt.toLocaleTimeString("zh-CN")}`
              : "正在连接消息服务"}{" "}
            · 每 30 秒自动刷新
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setShowNew(true)}
            className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm font-semibold"
          >
            <UserPlus size={15} />
            发起会话
          </button>
          <button
            type="button"
            onClick={() => setShowBulk(true)}
            className="flex items-center gap-2 rounded-xl bg-orange-500 px-3 py-2 text-sm font-semibold text-white"
          >
            <Users size={15} />
            批量触达
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => load()}
            className="grid h-10 w-10 place-items-center rounded-xl bg-slate-950 text-white disabled:opacity-60"
            aria-label="立即刷新"
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
          </button>
        </div>
      </div>
      {error && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
          <span className="flex items-center gap-2">
            <AlertTriangle size={15} />
            {error}，已保留原有消息。
          </span>
          <button
            type="button"
            onClick={() => load()}
            className="font-semibold underline"
          >
            重试
          </button>
        </div>
      )}
      <div className="grid h-[min(760px,calc(100dvh-220px))] min-h-[520px] overflow-hidden rounded-2xl border lg:grid-cols-[300px_1fr] lg:rounded-3xl">
        <aside
          className={`${selected ? "hidden lg:flex" : "flex"} min-h-0 flex-col overflow-hidden border-r bg-slate-50`}
        >
          <label className="relative shrink-0 border-b border-slate-200 bg-white p-3">
            <Search
              size={16}
              className="absolute left-6 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索客户、店铺、手机号或消息"
              className="h-10 w-full rounded-xl border border-slate-200 bg-slate-50 pl-9 pr-3 text-sm outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
            />
          </label>
          <div
            data-admin-conversation-scroll
            className="mobile-scroll min-h-0 flex-1 overflow-y-auto p-3"
          >
            {filteredItems.map((item) => (
              <button
                key={item.buyerUserId}
                type="button"
                onClick={() => setSelected(item.buyerUserId)}
                className={`mb-2 w-full rounded-2xl p-3 text-left ${selected === item.buyerUserId ? "bg-white shadow-sm ring-1 ring-orange-200" : "hover:bg-white"}`}
              >
                <div className="flex items-center justify-between">
                  <span className="flex min-w-0 items-center gap-2 text-sm font-bold">
                    <UserRound size={15} className="shrink-0" />
                    <span className="truncate">
                      {item.shopName || item.customerName || item.phone}
                    </span>
                  </span>
                  {item.unreadCount > 0 && (
                    <span className="rounded-full bg-red-500 px-2 py-0.5 text-[10px] text-white">
                      {item.unreadCount}
                    </span>
                  )}
                </div>
                <p className="mt-1 truncate text-xs text-slate-400">
                  {item.customerName} · {item.phone}
                </p>
                <p className="mt-2 truncate text-xs text-slate-500">
                  {item.lastMessage || "暂无消息"}
                </p>
              </button>
            ))}
            {!filteredItems.length && !loading && (
              <p className="py-12 text-center text-sm text-slate-400">
                <MessageCircle className="mx-auto mb-2" />
                {query.trim() ? "没有符合条件的会话" : "暂无客户消息"}
              </p>
            )}
          </div>
        </aside>
        <div
          data-admin-chat-pane
          className={`${selected ? "flex" : "hidden lg:flex"} min-h-0 min-w-0 flex-col overflow-hidden bg-white`}
        >
          {selected && ownerId ? (
            <>
              <div className="flex items-center gap-2 border-b px-3 py-3 text-sm sm:px-5">
                <button
                  type="button"
                  onClick={() => setSelected(undefined)}
                  className="grid h-11 w-11 shrink-0 place-items-center rounded-lg bg-slate-100 lg:hidden"
                  aria-label="返回会话列表"
                >
                  <ArrowLeft size={17} />
                </button>
                <div className="min-w-0 flex-1">
                  <b className="block truncate">
                    {current?.shopName ||
                      current?.customerName ||
                      customerLabel(currentCustomer)}
                  </b>
                  <span className="text-slate-400">
                    {current?.phone || currentCustomer?.phone}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => updateConversation("clear")}
                  className="rounded-lg bg-slate-100 px-2 py-2 text-xs font-semibold"
                >
                  清空
                </button>
                <button
                  type="button"
                  onClick={() => updateConversation("hide")}
                  className="grid h-9 w-9 place-items-center rounded-lg bg-red-50 text-red-600"
                  title="删除或隐藏对话"
                  aria-label="删除或隐藏对话"
                >
                  <Trash2 size={15} />
                </button>
              </div>
              <div className="min-h-0 flex-1">
                <ChatPanel
                  key={selected}
                  buyerUserId={selected}
                  currentUserId={ownerId}
                  title="订单沟通"
                  onOpenOrder={onOpenOrder}
                  canRecommendProducts={true}
                />
              </div>
            </>
          ) : (
            <div className="grid h-full place-items-center text-sm text-slate-400">
              <div className="text-center">
                <Store className="mx-auto mb-2" />
                请选择客户会话
              </div>
            </div>
          )}
        </div>
      </div>
      {showNew && (
        <CustomerPicker
          customers={customers}
          onClose={() => setShowNew(false)}
          onPick={(id) => {
            setSelected(id);
            setShowNew(false);
          }}
        />
      )}
      {showBulk && (
        <BulkPanel
          customers={customers}
          onClose={() => setShowBulk(false)}
          onError={setError}
        />
      )}
    </div>
  );
}

function CustomerPicker({
  customers,
  onClose,
  onPick,
}: {
  customers: Customer[];
  onClose: () => void;
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = customers.filter((customer) =>
    `${customerLabel(customer)} ${customer.phone}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <Modal title="发起新会话" onClose={onClose}>
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="mb-3 w-full rounded-xl border border-slate-200 px-3 py-3 text-sm"
        placeholder="搜索正常客户"
      />
      <div className="max-h-[60dvh] space-y-2 overflow-y-auto">
        {filtered.map((customer) => (
          <button
            key={customer.id}
            type="button"
            onClick={() => onPick(customer.id)}
            className="flex w-full items-center justify-between rounded-xl border p-3 text-left hover:border-orange-300"
          >
            <span>
              <b className="block text-sm">{customerLabel(customer)}</b>
              <span className="text-xs text-slate-400">{customer.phone}</span>
            </span>
            <MessageCircle size={16} className="text-orange-500" />
          </button>
        ))}
        {!filtered.length && (
          <p className="py-10 text-center text-sm text-slate-400">
            没有符合条件的正常客户
          </p>
        )}
      </div>
    </Modal>
  );
}

function BulkPanel({
  customers,
  onClose,
  onError,
}: {
  customers: Customer[];
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [content, setContent] = useState("");
  const [productId, setProductId] = useState("");
  const [products, setProducts] = useState<Product[]>([]);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/products", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(json.error || "商品读取失败");
        if (active)
          setProducts(
            (json.products || []).filter(
              (product: Product) =>
                product.status === "active" && !product.archived,
            ),
          );
      })
      .catch(
        (reason) =>
          active &&
          onError(reason instanceof Error ? reason.message : "商品读取失败"),
      );
    return () => {
      active = false;
    };
  }, [onError]);

  const toggle = (id: string) =>
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : current.length < 100
          ? [...current, id]
          : current,
    );
  const send = async () => {
    const hasText = Boolean(content.trim());
    if (!selectedIds.length) return onError("请至少选择一位客户");
    if (!hasText && !productId) return onError("请输入文字或选择一个在售商品");
    if (hasText && productId)
      return onError("批量消息每次只能发送文字或一个商品");
    const description = hasText ? "文字消息" : "商品推荐";
    if (
      !window.confirm(
        `将向 ${selectedIds.length} 位客户发送${description}。收件人之间互不可见，确定发送吗？`,
      )
    )
      return;
    setSending(true);
    try {
      const payload = {
        type: hasText ? "text" : "product",
        buyerUserIds: selectedIds,
        ...(hasText ? { content: content.trim() } : { productId }),
        batchId: crypto.randomUUID(),
      };
      const response = await fetch("/api/chat/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "批量发送失败");
      onClose();
    } catch (reason) {
      onError(reason instanceof Error ? reason.message : "批量发送失败");
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal title="批量触达" onClose={onClose}>
      <div className="flex items-center justify-between rounded-xl bg-orange-50 px-3 py-2 text-sm text-orange-800">
        <span>已选 {selectedIds.length} / 100 位正常客户</span>
        <button
          type="button"
          onClick={() =>
            setSelectedIds(
              customers.slice(0, 100).map((customer) => customer.id),
            )
          }
          className="font-semibold underline"
        >
          选择前 100 位
        </button>
      </div>
      <div className="mt-3 max-h-48 space-y-1 overflow-y-auto rounded-xl border p-2">
        {customers.map((customer) => (
          <label
            key={customer.id}
            className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 hover:bg-slate-50"
          >
            <input
              type="checkbox"
              checked={selectedIds.includes(customer.id)}
              onChange={() => toggle(customer.id)}
              disabled={
                !selectedIds.includes(customer.id) && selectedIds.length >= 100
              }
            />
            <span className="min-w-0 flex-1 truncate text-sm">
              {customerLabel(customer)}
            </span>
            <span className="text-xs text-slate-400">{customer.phone}</span>
          </label>
        ))}
      </div>
      <div className="my-4 flex items-center gap-2 text-xs text-slate-400">
        <span className="h-px flex-1 bg-slate-200" />
        选择一种发送内容
        <span className="h-px flex-1 bg-slate-200" />
      </div>
      <textarea
        value={content}
        onChange={(event) => {
          setContent(event.target.value);
          if (event.target.value) setProductId("");
        }}
        maxLength={1000}
        rows={4}
        className="w-full rounded-xl border border-slate-200 p-3 text-sm"
        placeholder="输入批量文字消息"
      />
      <label className="relative mt-3 block">
        <select
          value={productId}
          onChange={(event) => {
            setProductId(event.target.value);
            if (event.target.value) setContent("");
          }}
          className="w-full appearance-none rounded-xl border border-slate-200 px-3 py-3 pr-10 text-sm"
        >
          <option value="">或选择一个在售商品</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name}
              {product.brand ? ` · ${product.brand}` : ""}
            </option>
          ))}
        </select>
        <ChevronDown
          size={16}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
        />
      </label>
      <button
        type="button"
        disabled={
          sending || !selectedIds.length || (!content.trim() && !productId)
        }
        onClick={send}
        className="mt-4 flex w-full items-center justify-center gap-2 rounded-xl bg-orange-500 py-3 text-sm font-semibold text-white disabled:opacity-50"
      >
        <Send size={16} />
        {sending ? "发送中…" : "确认发送"}
      </button>
    </Modal>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-[160] bg-slate-950/45 p-3 sm:grid sm:place-items-center"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section className="mobile-scroll ml-auto h-full w-full overflow-y-auto bg-white p-4 shadow-2xl sm:ml-0 sm:h-auto sm:max-h-[90dvh] sm:max-w-lg sm:rounded-2xl">
        <header className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-orange-50 text-orange-600">
              <Check size={17} />
            </span>
            <h2 className="font-bold">{title}</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-10 w-10 place-items-center rounded-lg bg-slate-100"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
