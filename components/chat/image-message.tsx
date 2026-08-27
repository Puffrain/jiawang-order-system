"use client";

import Image from "next/image";
import { useState } from "react";
import { X } from "lucide-react";

export default function ImageMessage({ mediaId, alt = "聊天图片" }: { mediaId: string | number; alt?: string }) {
  const [open, setOpen] = useState(false);
  const src = `/api/chat/media/${encodeURIComponent(String(mediaId))}`;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 block overflow-hidden rounded-xl bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
        aria-label="放大查看图片"
      >
        <Image src={src} alt={alt} width={720} height={720} unoptimized className="max-h-72 w-auto max-w-full object-contain" />
      </button>
      {open && (
        <div
          className="fixed inset-0 z-[180] grid place-items-center bg-slate-950/90 p-3 sm:p-8"
          role="dialog"
          aria-modal="true"
          aria-label="图片预览"
          onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}
        >
          <button type="button" onClick={() => setOpen(false)} className="absolute right-4 top-4 grid h-11 w-11 place-items-center rounded-full bg-white text-slate-900" aria-label="关闭图片预览">
            <X size={20} />
          </button>
          <Image src={src} alt={alt} width={1600} height={1600} unoptimized className="max-h-[calc(100dvh-2rem)] max-w-full object-contain" />
        </div>
      )}
    </>
  );
}
