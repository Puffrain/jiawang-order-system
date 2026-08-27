"use client";
import Link from "next/link";
import {usePathname,useSearchParams}from"next/navigation";
import{Printer}from"lucide-react";
const types=[["detail","订单明细单"],["shipping","发货单"],["picking","无价格拣货单"]]as const;
export function PrintToolbar(){const pathname=usePathname(),params=useSearchParams(),active=params.get("type")||"detail";return <div className="mx-auto mb-5 flex max-w-[210mm] flex-wrap items-center justify-between gap-3 print:hidden"><div className="flex flex-wrap gap-2">{types.map(([type,label])=><Link key={type} href={`${pathname}?type=${type}`} className={`rounded-xl px-3 py-2 text-sm font-semibold ${active===type?"bg-orange-500 text-white":"bg-white text-slate-600"}`}>{label}</Link>)}</div><button onClick={()=>window.print()} className="flex items-center gap-2 rounded-xl bg-slate-950 px-5 py-3 font-semibold text-white"><Printer size={18}/>打印 / 保存 PDF</button></div>}
