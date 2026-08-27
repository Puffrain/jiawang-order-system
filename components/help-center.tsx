"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  X, Search, Rocket, PackagePlus, ShoppingBag, Users, Settings, CircleHelp,
  ChevronRight, ChevronDown, Smartphone, ShieldCheck,
  BookOpen, ExternalLink, FileText,
} from "lucide-react";

type HelpCenterProps = { open: boolean; onClose: () => void };

type Chapter = {
  id: string;
  title: string;
  subtitle: string;
  icon: typeof Rocket;
  sections: { title: string; content: React.ReactNode; keywords: string }[];
};

const chapters: Chapter[] = [
  {
    id: "start", title: "快速入门", subtitle: "登录与首页", icon: Rocket,
    sections: [
      { title: "1.1 如何登录？", keywords: "登录 手机号 验证码 短信", content: <Steps items={["打开电脑浏览器，推荐使用 Chrome 或 Edge，再进入您的专属后台。", "输入注册手机号，点击“获取验证码”。", "填入短信中的 6 位数字，点击“登录”即可。"]} tip="收不到短信时，先检查手机是否开启骚扰拦截，或稍后重新获取。"/> },
      { title: "1.2 后台首页看什么？", keywords: "首页 看板 销售额 待处理订单", content: <div className="space-y-3"><p>登录后第一眼看到的是 <Term name="数据看板" desc="把关键经营数字集中展示的首页"/>，这里会显示今日新增订单、待发货数量和总销售额。</p><Tip>每天优先看“待处理订单”，出现红色数字就代表有新订单需要您处理。</Tip></div> },
    ],
  },
  {
    id: "product", title: "商品管理", subtitle: "怎么把货上架", icon: PackagePlus,
    sections: [
      { title: "2.1 新增商品（上架新产品）", keywords: "新增 商品 上架 主图 规格 SKU 阶梯价 库存", content: <div className="space-y-4"><Path>商品管理 → 新增商品</Path><Steps items={["填写商品名称，例如“施华蔻专业保丽洗发水 1000ml”。", "选择分类；拿不准时可以先选“其他”。", "上传清晰的商品主图，推荐使用纯白背景。", "有大瓶、小瓶等区别时添加规格（SKU，也就是同一商品的不同型号）。", "设置批发阶梯价：例如 1–5 瓶每瓶 100 元，6–10 瓶每瓶 90 元。", "填写仓库当前大致库存后保存。"]}/><Tip>阶梯价就是“拿得越多，单价越低”，区间不要重叠或留空。</Tip></div> },
      { title: "2.2 修改价格或下架", keywords: "编辑 修改价格 下架", content: <p>在商品列表找到对应商品，点击右侧“编辑”修改资料或价格；点击“下架”后，买家端将不再展示该商品，历史订单不会受影响。</p> },
    ],
  },
  {
    id: "order", title: "订单处理", subtitle: "每天最重要的事", icon: ShoppingBag,
    sections: [
      { title: "3.1 怎么看新订单？", keywords: "新订单 状态 待审核 待付款 待发货", content: <div className="space-y-3"><Path>订单管理 → 全部订单</Path><Status color="amber" title="待审核" text="客户刚下单，需要确认库存和价格。"/><Status color="blue" title="待付款" text="客户还没有完成付款；关闭在线支付时可按线下流程处理。"/><Status color="green" title="待发货" text="款项已到账或订单已确认，可以开始打包。"/></div> },
      { title: "3.2 如何修改订单金额？", keywords: "调整价格 优惠 运费 历史价 一键沿用", content: <div className="space-y-4"><Path>订单详情 → 调整价格</Path><Steps items={["可直接填写商品优惠、修改运费或设置整单折扣。", "老客户再次购买时，先查看每件商品旁的“上次成交价”。", "点击“一键沿用历史价”，系统会自动套用并重算总价。", "若上次价格比当前售价更高，系统会弹窗提醒，请核对后再确认。", "确认修改后，系统会自动通知买家。"]}/><Tip>历史成交价按“客户 + 商品规格（SKU）”记录，不同客户的价格不会混在一起。</Tip></div> },
      { title: "3.3 如何发货？", keywords: "发货 快递 单号 自提 核销", content: <Steps items={["订单变为“待发货”后，点击“标记发货”。", "填写快递单号并选择正确的快递公司。", "确认后，买家会看到已发货状态和物流进度。", "到店自提订单直接点击“核销 / 自提完成”。"]}/> },
    ],
  },
  {
    id: "customer", title: "客户管理", subtitle: "记住谁是大客户", icon: Users,
    sections: [
      { title: "4.1 怎么给客户打标签？", keywords: "客户 标签 VIP 内部备注 店铺", content: <div className="space-y-4"><Path>客户管理 → 找到客户 → 查看档案</Path><p>您可以维护店铺名称、经营品类、收货偏好、品牌偏好和客户等级。</p><Tip>“内部备注”和“客户等级”只有商户员工能看到，买家端不会显示，可以放心记录跟单信息。</Tip><div className="flex flex-wrap gap-2"><TagChip>VIP大客户</TagChip><TagChip>高频补货</TagChip><TagChip>沉睡客户</TagChip><TagChip>潜在流失</TagChip></div></div> },
    ],
  },
  {
    id: "setting", title: "系统设置", subtitle: "地址与员工", icon: Settings,
    sections: [
      { title: "5.1 设置发货地址", keywords: "发货 地址 仓库 面单", content: <div className="space-y-3"><Path>系统设置 → 店铺 / 仓库地址</Path><p>填写仓库地址、联系人和电话，并设为“默认发货地址”，以后打印快递面单时会自动带出。</p></div> },
      { title: "5.2 添加员工帮忙打理", keywords: "员工 权限 客服 仓库 安全", content: <div className="space-y-3"><p>点击“新增员工”，输入员工手机号并勾选允许操作的功能。</p><div className="rounded-xl border border-slate-200 p-3"><div className="flex items-center gap-2 text-sm font-medium"><ShieldCheck size={16} className="text-emerald-600"/>推荐权限</div><p className="mt-2 text-xs leading-5 text-slate-500">客服可处理消息和订单；仓库员工只处理发货；商品价格修改尽量只开放给店长。</p></div></div> },
    ],
  },
  {
    id: "qa", title: "常见问题", subtitle: "遇到问题先看这里", icon: CircleHelp,
    sections: [
      { title: "客户看不到物流怎么办？", keywords: "物流 看不到 快递单号", content: <p>检查快递单号是否填错，以及快递公司是否选错，例如中通不要误选成圆通。修改后重新保存即可。</p> },
      { title: "客户收不到验证码怎么办？", keywords: "验证码 收不到 登录", content: <p>请客户检查手机是否欠费、信号是否正常，以及是否开启陌生短信拦截；短时间内多次获取时请等待一分钟再试。</p> },
      { title: "商品价格改错了怎么办？", keywords: "价格 改错 历史订单", content: <p>历史订单价格不会跟着变化。进入商品管理把售价改回正确数字，再联系正在下单的客户确认即可。</p> },
    ],
  },
];

export default function HelpCenter({ open, onClose }: HelpCenterProps) {
  const [active, setActive] = useState("start");
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<string | null>("1.1 如何登录？");
  const [tourEnabled, setTourEnabled] = useState(true);
  const chapter = chapters.find(item => item.id === active) ?? chapters[0];
  const results = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return chapter.sections;
    return chapters.flatMap(item => item.sections).filter(section => `${section.title}${section.keywords}`.toLowerCase().includes(keyword));
  }, [chapter, query]);

  if (!open) return null;
  return <div className="fixed inset-0 z-[80] flex justify-end bg-slate-950/30 backdrop-blur-[2px]" onClick={onClose}>
    <section className="flex h-full w-full max-w-5xl overflow-hidden bg-[#f7f8fb] shadow-2xl" onClick={event => event.stopPropagation()}>
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white p-4 md:block">
        <div className="mb-5 flex items-center gap-2 px-2"><div className="grid h-9 w-9 place-items-center rounded-xl bg-blue-600 text-white"><BookOpen size={18}/></div><div><p className="text-sm font-semibold">操作帮助手册</p><p className="text-[10px] text-slate-400">零基础版 · V1.4</p></div></div>
        <nav className="space-y-1">{chapters.map(item => { const Icon=item.icon; return <button key={item.id} onClick={()=>{setActive(item.id);setQuery("");setExpanded(null)}} className={`flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left ${active===item.id&&!query?"bg-blue-50 text-blue-700":"text-slate-600 hover:bg-slate-50"}`}><Icon size={17}/><div className="min-w-0"><p className="text-sm font-medium">{item.title}</p><p className="truncate text-[10px] opacity-60">{item.subtitle}</p></div><ChevronRight size={14} className="ml-auto"/></button>})}</nav>
        <button onClick={()=>{const next=!tourEnabled;setTourEnabled(next);window.localStorage.setItem("buyer-tour-enabled",next?"on":"off")}} className="mt-5 flex w-full items-center justify-between rounded-xl border border-slate-200 p-3 text-left"><div><p className="text-xs font-medium text-slate-700">客户新手引导</p><p className="mt-1 text-[10px] text-slate-400">首次登录自动展示</p></div><span className={`relative h-5 w-9 rounded-full transition ${tourEnabled?"bg-blue-600":"bg-slate-300"}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition ${tourEnabled?"left-[18px]":"left-0.5"}`}/></span></button>
        <Link href="/buyer" className="mt-5 flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs font-medium text-blue-700"><Smartphone size={16}/>查看买家端新手引导<ExternalLink size={13} className="ml-auto"/></Link>
        <Link href="/setup-guide" className="mt-2 flex items-center gap-2 rounded-xl border border-slate-200 p-3 text-xs font-medium text-slate-600"><FileText size={16}/>上线前资料清单<ExternalLink size={13} className="ml-auto"/></Link>
      </aside>
      <div className="min-w-0 flex-1 overflow-y-auto">
        <header className="sticky top-0 z-10 border-b border-slate-200 bg-white/95 px-5 py-4 backdrop-blur"><div className="flex items-center gap-3"><div className="relative flex-1"><Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索：改价、发货、验证码…" className="h-11 w-full rounded-xl bg-slate-100 pl-10 pr-4 text-sm outline-none ring-blue-500 focus:ring-2"/></div><button onClick={onClose} title="关闭帮助中心" className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 bg-white text-slate-500 hover:bg-slate-50"><X size={18}/></button></div></header>
        <div className="mx-auto max-w-3xl p-5 md:p-8"><div className="mb-6"><p className="text-xs font-medium text-blue-600">{query ? "搜索结果" : `第 ${chapters.findIndex(item=>item.id===active)+1} 章`}</p><h1 className="mt-1 text-2xl font-semibold text-slate-900">{query ? `找到 ${results.length} 条相关帮助` : chapter.title}</h1><p className="mt-2 text-sm text-slate-500">{query ? `与“${query}”相关的操作说明` : chapter.subtitle}</p></div>
          <div className="space-y-3">{results.map(section => { const isOpen=expanded===section.title || Boolean(query); return <article key={section.title} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm"><button onClick={()=>setExpanded(isOpen?null:section.title)} className="flex w-full items-center justify-between gap-4 p-5 text-left"><span className="font-semibold text-slate-800">{section.title}</span><ChevronDown size={17} className={`shrink-0 text-slate-400 transition ${isOpen?"rotate-180":""}`}/></button>{isOpen&&<div className="border-t border-slate-100 px-5 py-5 text-sm leading-7 text-slate-600">{section.content}</div>}</article>})}{results.length===0&&<div className="rounded-2xl border border-dashed border-slate-300 bg-white p-10 text-center"><CircleHelp className="mx-auto text-slate-300" size={34}/><p className="mt-3 text-sm text-slate-500">没找到相关说明，换个简单的关键词试试。</p></div>}</div>
        </div>
      </div>
    </section>
  </div>;
}

function Steps({ items, tip }: { items: string[]; tip?: string }) { return <div className="space-y-3">{items.map((item,index)=><div key={item} className="flex gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-blue-50 text-xs font-semibold text-blue-600">{index+1}</span><p className="leading-6">{item}</p></div>)}{tip&&<Tip>{tip}</Tip>}</div> }
function Tip({ children }: { children: React.ReactNode }) { return <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">温馨提示：{children}</div> }
function Path({ children }: { children: React.ReactNode }) { return <div className="rounded-xl bg-slate-900 px-4 py-3 font-medium text-white">操作位置：{children}</div> }
function Term({ name, desc }: { name: string; desc: string }) { return <strong className="text-slate-800">{name}（{desc}）</strong> }
function TagChip({ children }: { children: React.ReactNode }) { return <span className="rounded-full bg-violet-50 px-3 py-1 text-xs font-medium text-violet-700">{children}</span> }
function Status({ color, title, text }: { color: "amber"|"blue"|"green"; title: string; text: string }) { const colors={amber:"bg-amber-400",blue:"bg-blue-500",green:"bg-emerald-500"}; return <div className="flex gap-3 rounded-xl border border-slate-200 p-3"><span className={`mt-1 h-3 w-3 shrink-0 rounded-full ${colors[color]}`}/><div><p className="font-medium text-slate-800">{title}</p><p className="mt-1 text-xs text-slate-500">{text}</p></div></div> }
