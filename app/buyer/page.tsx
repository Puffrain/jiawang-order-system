"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import {
  AlertTriangle,
  Grid2X2,
  Home,
  MessageCircle,
  Minus,
  Package,
  Plus,
  ShoppingCart,
  Trash2,
  UserRound,
} from "lucide-react";
import ProfileOnboarding from "@/components/buyer/profile-onboarding";
import AddressManager, {
  type Address,
} from "@/components/buyer/address-manager";
import ProfileEditor from "@/components/buyer/profile-editor";
import OrderList from "@/components/buyer/order-list";
import OrderReviews from "@/components/buyer/order-reviews";
import ChatPanel from "@/components/chat/chat-panel";
import AccountSecurity from "@/components/buyer/account-security";
import LoyaltyEntry from "@/components/buyer/loyalty-entry";
import CatalogHome from "@/components/buyer/catalog-home";

type Sku = {
  id: string;
  skuCode: string;
  specName: string;
  basePrice: number;
  stock: number;
  tiers: { minQty: number; maxQty: number | null; unitPrice: number }[];
};
type Product = {
  id: string;
  name: string;
  category: string;
  categoryKey?: string;
  subcategoryKey?: string | null;
  brand?: string;
  description?: string;
  salesCount: number;
  primaryImage: { url: string } | null;
  images: { id: string; url: string }[];
  skus: Sku[];
};
type CustomerNotice = {
  id: string;
  title: string;
  document: {
    blocks: Array<{
      type: "heading" | "paragraph" | "list" | "image";
      text?: string;
      items?: string[];
      align?: "left" | "center" | "right";
      marks?: {
        bold?: boolean;
        italic?: boolean;
        underline?: boolean;
        fontSize?: number;
        color?: string;
        link?: string;
      };
      src?: string;
      alt?: string;
    }>;
  };
};
type CartItem = {
  skuId: string;
  skuCode: string;
  productName: string;
  specName: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  stock: number;
};
type InvalidCartItem = {
  skuId: string;
  quantity: number;
  productName: string;
  specName: string;
  stock: number;
  reason?: string;
};
type Order = {
  id: string;
  orderNo: string;
  status: string;
  subtotal: number;
  discountAmount: number;
  shippingFee: number;
  totalAmount: number;
  pointsUsed?: number;
  pointsDiscount?: number;
  quoteVersion: number;
  confirmedQuoteVersion: number;
  createdAt: string;
};
type Profile = {
  id: string;
  displayName: string | null;
  shopName: string | null;
  businessType: string | null;
  phone: string;
  profileCompleted: boolean;
  addressCount: number;
  hasPassword: boolean;
};
const money = (value: number) => `¥${Number(value).toFixed(2)}`;
async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init }),
    body = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(body.error || `请求失败（${response.status}）`);
  return body;
}

export default function BuyerPage() {
  const [tab, setTab] = useState<
    "home" | "cart" | "orders" | "messages" | "me"
  >("home");
  const [products, setProducts] = useState<Product[]>([]),
    [cart, setCart] = useState<CartItem[]>([]),
    [invalidCart, setInvalidCart] = useState<InvalidCartItem[]>([]),
    [orders, setOrders] = useState<Order[]>([]),
    [addresses, setAddresses] = useState<Address[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null),
    [notice, setNotice] = useState(""),
    [customerNotices, setCustomerNotices] = useState<CustomerNotice[]>([]),
    [checkout, setCheckout] = useState(false),
    [tour, setTour] = useState(false),
    [unread, setUnread] = useState(0);
  const applyCart = useCallback(
    (payload: { items?: CartItem[]; invalidItems?: InvalidCartItem[] }) => {
      setCart(Array.isArray(payload.items) ? payload.items : []);
      setInvalidCart(
        Array.isArray(payload.invalidItems) ? payload.invalidItems : [],
      );
    },
    [],
  );
  const load = useCallback(async () => {
    const results = await Promise.allSettled([
      requestJson("/api/products"),
      requestJson("/api/cart"),
      requestJson("/api/orders"),
      requestJson("/api/auth/me"),
      requestJson("/api/addresses"),
      requestJson("/api/chat/conversations"),
      requestJson("/api/notices"),
    ]);
    const [p, c, o, m, a, chats, n] = results;
    if (p.status === "fulfilled") setProducts(p.value.products || []);
    if (c.status === "fulfilled") applyCart(c.value);
    if (o.status === "fulfilled") setOrders(o.value.orders || []);
    if (a.status === "fulfilled") setAddresses(a.value.addresses || []);
    if (m.status === "fulfilled") {
      setProfile(
        m.value.user?.profile
          ? {
              ...m.value.user.profile,
              hasPassword: Boolean(m.value.user.hasPassword),
            }
          : null,
      );
      setTour(Boolean(m.value.user && !m.value.user.tourCompleted));
    }
    if (chats.status === "fulfilled") setUnread(chats.value.unreadTotal || 0);
    if (n.status === "fulfilled") setCustomerNotices(n.value.notices || []);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected")
      setNotice(
        failure.reason instanceof Error
          ? failure.reason.message
          : "部分数据读取失败，请稍后刷新",
      );
  }, [applyCart]);
  const poll = useCallback(async () => {
    const results = await Promise.allSettled([
      requestJson("/api/products"),
      requestJson("/api/cart"),
      requestJson("/api/orders"),
      requestJson("/api/chat/conversations"),
    ]);
    const [p, c, o, chats] = results;
    if (p.status === "fulfilled") setProducts(p.value.products || []);
    if (c.status === "fulfilled") applyCart(c.value);
    if (o.status === "fulfilled") setOrders(o.value.orders || []);
    if (chats.status === "fulfilled") setUnread(chats.value.unreadTotal || 0);
  }, [applyCart]);
  useEffect(() => {
    const refresh = () => {
        if (document.visibilityState === "visible") void poll();
      },
      first = window.setTimeout(() => void load(), 0),
      timer = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load, poll]);
  const update = async (item: CartItem, quantity: number) => {
    try {
      if (quantity < 1)
        await requestJson(`/api/cart?skuId=${encodeURIComponent(item.skuId)}`, {
          method: "DELETE",
        });
      else
        await requestJson("/api/cart", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ skuId: item.skuId, quantity }),
        });
      await load();
    } catch (reason) {
      setNotice(
        reason instanceof Error ? reason.message : "购物车更新失败，请稍后重试",
      );
    }
  };
  const clearInvalid = async (item: InvalidCartItem) => {
    try {
      await requestJson("/api/cart?skuId=" + encodeURIComponent(item.skuId), {
        method: "DELETE",
      });
      await load();
    } catch (reason) {
      setNotice(
        reason instanceof Error
          ? reason.message
          : "失效商品清理失败，请稍后重试",
      );
    }
  };
  const total = useMemo(
    () => cart.reduce((sum, item) => sum + item.lineTotal, 0),
    [cart],
  );
  const checkoutBlocked = invalidCart.length > 0 || !cart.length;
  useEffect(() => {
    if (checkout && checkoutBlocked) setCheckout(false);
  }, [checkout, checkoutBlocked]);
  const finishTour = async () => {
    await fetch("/api/auth/tour", { method: "POST" });
    setTour(false);
  };
  const desktopWidth =
    tab === "home" ? "lg:max-w-[1440px]" : "lg:max-w-[760px]";
  return (
    <main className="mobile-safe-screen bg-slate-100 py-0 sm:py-8 lg:px-6 lg:py-10">
      <div
        className={`mobile-safe-screen relative mx-auto w-full max-w-[460px] overflow-hidden bg-[#f7f8fb] shadow-2xl sm:min-h-[860px] sm:rounded-[32px] sm:border-[7px] sm:border-slate-900 lg:rounded-none lg:border-0 lg:shadow-xl ${desktopWidth}`}
      >
        <header className="sticky top-0 z-20 bg-white px-4 py-4 shadow-sm lg:px-8 lg:py-5">
          <div className="flex min-w-0 items-center gap-3">
            <Image
              src="/brand/portrait.jpg"
              alt="佳旺美容美发用品店"
              width={44}
              height={44}
              priority
              className="h-11 w-11 shrink-0 rounded-lg border-2 border-orange-100 bg-white object-contain"
            />
            <div className="min-w-0">
              <h1 className="font-bold text-slate-900 lg:text-xl">
                佳旺美容美发用品店
              </h1>
              <p className="mt-0.5 text-xs leading-5 text-emerald-600 lg:text-sm">
                同城美发店 · 专属批发平台 · 免费送货上门 · 下单即享优惠
              </p>
            </div>
          </div>
          {notice && (
            <button
              onClick={() => setNotice("")}
              className="mt-3 w-full rounded-lg bg-emerald-50 px-3 py-2 text-left text-xs text-emerald-700"
            >
              {notice}
            </button>
          )}
        </header>
        <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 mx-auto grid w-full max-w-[460px] grid-cols-5 border-t bg-white px-1 pt-2 sm:absolute lg:static lg:max-w-none lg:border-t-0 lg:border-b lg:px-8 lg:py-3 lg:shadow-sm">
          <Nav
            icon={Home}
            label="首页"
            active={tab === "home"}
            onClick={() => setTab("home")}
          />
          <Nav
            icon={ShoppingCart}
            label="购物车"
            active={tab === "cart"}
            count={
              cart.reduce((sum, item) => sum + item.quantity, 0) +
              invalidCart.reduce((sum, item) => sum + item.quantity, 0)
            }
            onClick={() => setTab("cart")}
          />
          <Nav
            icon={Package}
            label="订单"
            active={tab === "orders"}
            onClick={() => setTab("orders")}
          />
          <Nav
            icon={MessageCircle}
            label="消息"
            active={tab === "messages"}
            count={unread}
            onClick={() => {
              setTab("messages");
              setUnread(0);
            }}
          />
          <Nav
            icon={UserRound}
            label="我的"
            active={tab === "me"}
            onClick={() => setTab("me")}
          />
        </nav>
        <div className="pb-[calc(6.5rem+env(safe-area-inset-bottom))] lg:pb-8">
          {tab === "home" && (
            <CatalogHome
              products={products}
              notices={customerNotices}
              onAdded={load}
            />
          )}{" "}
          {tab === "cart" && (
            <CartView
              items={cart}
              invalidItems={invalidCart}
              total={total}
              update={update}
              clearInvalid={clearInvalid}
              checkout={() => {
                if (!checkoutBlocked) setCheckout(true);
              }}
            />
          )}{" "}
          {tab === "orders" && (
            <>
            <OrderReviews orders={orders} />
            <OrderList
              orders={orders}
              reload={load}
              onChat={() => setTab("messages")}
            />
            </>
          )}{" "}
          {tab === "messages" && profile && (
            <div className="h-[calc(100dvh-11.75rem)] p-3 lg:h-[calc(100vh-15.5rem)] lg:p-8">
              <ChatPanel currentUserId={profile.id} title="联系商户" />
            </div>
          )}{" "}
          {tab === "me" && (
            <MeView profile={profile} addresses={addresses} reload={load} />
          )}
        </div>
        {checkout && !checkoutBlocked && (
          <Checkout
            items={cart}
            total={total}
            addresses={addresses}
            reload={load}
            close={() => setCheckout(false)}
            done={async () => {
              setCheckout(false);
              setTab("orders");
              await load();
            }}
            setNotice={setNotice}
          />
        )}{" "}
        {checkout && notice && (
          <button
            type="button"
            onClick={() => setNotice("")}
            role="alert"
            className="fixed inset-x-4 top-4 z-[60] mx-auto max-w-[430px] rounded-xl border border-red-200 bg-red-50 p-3 text-left text-sm leading-6 text-red-700 shadow-lg"
          >
            {notice}
          </button>
        )}
        {profile && !profile.profileCompleted && (
          <ProfileOnboarding
            phone={profile.phone}
            onComplete={async () => {
              await load();
              setNotice("资料与常用地址已保存");
            }}
          />
        )}
        {tour && profile?.profileCompleted && (
          <div className="absolute inset-0 z-50 grid place-items-center bg-slate-950/65 p-6">
            <div className="rounded-3xl bg-white p-6 shadow-2xl">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-orange-100 text-orange-600">
                <Grid2X2 />
              </div>
              <h2 className="mt-5 text-xl font-bold">批发采购，自动阶梯价</h2>
              <p className="mt-3 text-sm leading-6 text-slate-600">
                选购后进入购物车，系统会按数量重新计算批发价；提交前会再次确认商品可售状态。
              </p>
              <button
                onClick={finishTour}
                className="mt-6 w-full rounded-xl bg-orange-500 py-3 font-semibold text-white"
              >
                开始采购
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

function CartView({
  items,
  invalidItems,
  total,
  update,
  clearInvalid,
  checkout,
}: {
  items: CartItem[];
  invalidItems: InvalidCartItem[];
  total: number;
  update: (item: CartItem, quantity: number) => void;
  clearInvalid: (item: InvalidCartItem) => Promise<void>;
  checkout: () => void;
}) {
  const [clearingSkuId, setClearingSkuId] = useState<string | null>(null),
    blocked = invalidItems.length > 0 || !items.length;
  const clear = async (item: InvalidCartItem) => {
    setClearingSkuId(item.skuId);
    try {
      await clearInvalid(item);
    } finally {
      setClearingSkuId(null);
    }
  };
  return (
    <div className="p-4">
      <h2 className="text-xl font-bold">购物车</h2>
      {invalidItems.length > 0 && (
        <section
          role="alert"
          className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4"
        >
          <div className="flex min-w-0 items-start gap-3">
            <AlertTriangle
              size={19}
              className="mt-0.5 shrink-0 text-amber-600"
            />
            <div className="min-w-0">
              <h3 className="font-semibold text-amber-900">
                有 {invalidItems.length} 项商品暂不能结算
              </h3>
              <p className="mt-1 text-xs leading-5 text-amber-800">
                商品已下架、归档或库存变化时会保留在购物车，确认后请手动清理。
              </p>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {invalidItems.map((item) => (
              <article
                key={item.skuId}
                className="flex min-w-0 items-center gap-3 rounded-xl bg-white/80 p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm font-semibold">
                    {item.productName || "商品已不可售"}
                  </p>
                  <p className="mt-1 break-words text-xs text-slate-500">
                    {item.specName || "规格信息不可用"} · 数量 {item.quantity}
                  </p>
                  <p className="mt-1 break-words text-xs text-amber-800">
                    {item.reason || (item.stock <= 0 ? "库存不足，联系商家" : "该商品当前无法购买")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void clear(item)}
                  disabled={clearingSkuId === item.skuId}
                  className="flex shrink-0 items-center gap-1 rounded-lg bg-amber-100 px-3 py-2 text-xs font-semibold text-amber-800 disabled:opacity-50"
                >
                  <Trash2 size={14} />
                  <span>
                    {clearingSkuId === item.skuId ? "清理中…" : "清理"}
                  </span>
                </button>
              </article>
            ))}
          </div>
        </section>
      )}
      <div className="mt-4 space-y-3">
        {items.map((item) => (
          <article
            key={item.skuId}
            className="rounded-2xl bg-white p-4 shadow-sm"
          >
            <div className="flex min-w-0 justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words font-semibold">{item.productName}</p>
                <p className="mt-1 break-words text-xs text-slate-400">
                  {item.specName} · {money(item.unitPrice)}/件
                </p>
              </div>
              <p className="shrink-0 font-bold text-rose-600">
                {money(item.lineTotal)}
              </p>
            </div>
            <div className="mt-4 flex items-center justify-end gap-3">
              <button
                onClick={() => update(item, item.quantity - 1)}
                className="grid h-8 w-8 place-items-center rounded-lg bg-slate-100"
              >
                <Minus size={14} />
              </button>
              <span className="w-6 text-center text-sm font-bold">
                {item.quantity}
              </span>
              <button
                onClick={() => update(item, item.quantity + 1)}
                className="grid h-8 w-8 place-items-center rounded-lg bg-orange-500 text-white"
              >
                <Plus size={14} />
              </button>
            </div>
          </article>
        ))}
      </div>
      {!items.length && (
        <Empty
          text={invalidItems.length ? "请先清理失效商品" : "还没有选购商品"}
        />
      )}
      <div className="mt-4 rounded-2xl bg-white p-4">
        <div className="flex min-w-0 justify-between gap-3">
          <span>商品合计</span>
          <b className="shrink-0">{money(total)}</b>
        </div>
        <button
          type="button"
          onClick={checkout}
          disabled={blocked}
          className="mt-4 w-full rounded-xl bg-orange-500 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {invalidItems.length
            ? "请先清理失效商品"
            : items.length
              ? "选择地址并提交订单"
              : "暂无可结算商品"}
        </button>
      </div>
    </div>
  );
}
function MeView({
  profile,
  addresses,
  reload,
}: {
  profile: Profile | null;
  addresses: Address[];
  reload: () => Promise<void>;
}) {
  return (
    <div className="space-y-4 p-4">
      <section className="rounded-2xl bg-orange-500 p-6 text-white">
        <UserRound size={36} />
        <h2 className="mt-4 text-xl font-bold">
          {profile?.displayName || "买家中心"}
        </h2>
        <p className="mt-2 text-sm text-slate-300">
          {profile?.shopName || "客户资料"} · {profile?.phone}
        </p>
        {profile?.businessType && (
          <p className="mt-1 text-xs text-slate-400">{profile.businessType}</p>
        )}
      </section>
      <LoyaltyEntry />
      {profile && (
        <AccountSecurity
          phone={profile.phone}
          hasPassword={profile.hasPassword}
          onChanged={reload}
        />
      )}{" "}
      {profile && <ProfileEditor profile={profile} onChanged={reload} />}
      <section className="rounded-2xl bg-white p-5">
        <AddressManager addresses={addresses} onChanged={reload} />
      </section>
    </div>
  );
}
function Checkout({
  items,
  total,
  addresses,
  reload,
  close,
  done,
  setNotice,
}: {
  items: CartItem[];
  total: number;
  addresses: Address[];
  reload: () => Promise<void>;
  close: () => void;
  done: () => void;
  setNotice: (v: string) => void;
}) {
  const [selected, setSelected] = useState(
      addresses.find((a) => a.isDefault)?.id || addresses[0]?.id || "",
    ),
    [busy, setBusy] = useState(false),
    [remark, setRemark] = useState(""),
    [points, setPoints] = useState(0),
    [balance, setBalance] = useState(0),
    [pointValueFen, setPointValueFen] = useState(10),
    [loyaltyBusy, setLoyaltyBusy] = useState(true),
    idempotencyKey = useRef(crypto.randomUUID());
  useEffect(() => {
    let active = true;
    void fetch("/api/loyalty", { cache: "no-store" })
      .then(async (response) => {
        const json = await response.json().catch(() => ({}));
        const data = json.loyalty ?? json;
        if (active && response.ok) {
          setBalance(Number(data.balancePoints) || 0);
          setPointValueFen(Number(data.pointValueFen) || 10);
        }
      })
      .finally(() => active && setLoyaltyBusy(false));
    return () => {
      active = false;
    };
  }, []);
  const maxPoints = Math.max(
      0,
      Math.min(balance, Math.floor(Math.round(total * 100) / pointValueFen)),
    ),
    discount = (points * pointValueFen) / 100,
    payable = Math.max(0, total - discount);
  const changePoints = (value: number) =>
    setPoints(
      Math.max(
        0,
        Math.min(maxPoints, Math.floor(Number.isFinite(value) ? value : 0)),
      ),
    );
  const submit = async () => {
    if (!selected) return setNotice("请先选择收货地址");
    setBusy(true);
    const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          addressId: selected,
          idempotencyKey: idempotencyKey.current,
          remark,
          pointsToUse: points,
        }),
      }),
      json = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) return setNotice(json.error || "订单提交失败");
    setNotice(`订单 ${json.order.orderNo} 已提交，等待商户确认`);
    done();
  };
  return (
    <div className="mobile-scroll absolute inset-0 z-40 min-h-full overflow-y-auto bg-slate-100 p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <button onClick={close} className="mb-4 text-sm text-slate-600">
        ← 返回购物车
      </button>
      <h2 className="text-xl font-bold">确认订单</h2>
      <div className="mt-4 rounded-2xl bg-white p-4 text-sm">
        <div className="flex justify-between">
          <span>{items.length} 种商品</span>
          <b>{money(total)}</b>
        </div>
      </div>
      <div className="mt-4 rounded-2xl bg-white p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">积分抵扣</h3>
            <p className="mt-1 text-xs text-slate-400">
              {loyaltyBusy ? "正在读取积分…" : `可用 ${balance} 积分`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => changePoints(maxPoints)}
            disabled={loyaltyBusy || maxPoints === 0}
            className="rounded-lg bg-orange-50 px-3 py-2 text-xs font-semibold text-orange-600 disabled:text-slate-300"
          >
            全部使用
          </button>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <input
            aria-label="使用积分"
            inputMode="numeric"
            pattern="[0-9]*"
            value={points}
            onChange={(event) => changePoints(Number(event.target.value))}
            className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-right"
          />
          <span className="shrink-0 text-sm text-slate-500">积分</span>
        </div>
        <div className="mt-3 flex justify-between text-sm">
          <span className="text-slate-500">本次抵扣</span>
          <b className="text-orange-600">-{money(discount)}</b>
        </div>
        <div className="mt-2 flex justify-between border-t pt-3">
          <span className="font-semibold">预计实付</span>
          <b className="text-lg text-rose-600">{money(payable)}</b>
        </div>
      </div>
      <div className="mt-4 rounded-2xl bg-white p-4">
        <AddressManager
          compact
          addresses={addresses}
          selectedId={selected}
          onSelect={setSelected}
          onChanged={reload}
        />
      </div>
      <textarea
        value={remark}
        onChange={(event) => setRemark(event.target.value)}
        placeholder="订单备注（选填）"
        className="mt-4 w-full rounded-2xl border-0 bg-white p-4 text-sm"
      />
      <button
        disabled={busy || !selected}
        onClick={submit}
        className="mt-4 w-full rounded-xl bg-orange-500 py-3 font-semibold text-white disabled:opacity-60"
      >
        {busy ? "正在安全提交…" : `提交订单 ${money(payable)}`}
      </button>
    </div>
  );
}
function Nav({
  icon: Icon,
  label,
  active,
  count,
  onClick,
}: {
  icon: typeof Home;
  label: string;
  active: boolean;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`relative mx-auto flex min-h-12 w-full min-w-0 flex-col items-center justify-center gap-1 py-1 text-[10px] lg:min-h-0 lg:flex-row lg:gap-2 lg:py-2 lg:text-sm ${active ? "text-orange-600" : "text-slate-400"}`}
    >
      <Icon size={20} />
      {count ? (
        <span className="absolute right-4 top-0 rounded-full bg-rose-500 px-1.5 text-[9px] text-white lg:static lg:px-2 lg:py-0.5 lg:text-[10px]">
          {count}
        </span>
      ) : null}
      {label}
    </button>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="mt-12 text-center text-sm text-slate-400">
      <Package className="mx-auto mb-3" />
      {text}
    </div>
  );
}
