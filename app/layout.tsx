import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ErrorReporter } from "@/lib/error-reporter";
import { SessionMenu } from "@/components/session-menu";

export const metadata: Metadata = {
  title: "佳旺美容美发用品店 · 客户经营工作台",
  description: "批发商户订单、客户与沟通一体化管理系统",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning className="h-full antialiased">
      <body suppressHydrationWarning className="min-h-full">
        <ErrorReporter />
        <SessionMenu />
        {children}
      </body>
    </html>
  );
}
