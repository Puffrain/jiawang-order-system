"use client";

import { ChangeEvent, useRef, useState } from "react";
import { ImagePlus } from "lucide-react";

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export default function ImageUploader({ buyerUserId, onSent, onError }: { buyerUserId?: string; onSent: () => Promise<void> | void; onError: (message: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [sending, setSending] = useState(false);

  const upload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return onError("请选择图片文件");
    if (file.size > MAX_IMAGE_BYTES) return onError("图片不能超过 5MB");
    setSending(true);
    try {
      const form = new FormData();
      form.set("image", file, file.name);
      form.set("clientMessageId", crypto.randomUUID());
      if (buyerUserId) form.set("buyerUserId", buyerUserId);
      const response = await fetch("/api/chat/image", { method: "POST", body: form });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "图片发送失败");
      await onSent();
    } catch (error) {
      onError(error instanceof Error ? error.message : "图片发送失败");
    } finally {
      setSending(false);
    }
  };

  return (
    <>
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp,image/gif" className="hidden" onChange={upload} />
      <button type="button" disabled={sending} onClick={() => input.current?.click()} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-slate-100 text-orange-600 disabled:opacity-50" title="发送图片" aria-label="发送图片">
        <ImagePlus size={18} />
      </button>
    </>
  );
}
