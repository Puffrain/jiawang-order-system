import { redirect } from "next/navigation";
import AdminDashboard from "@/components/admin-dashboard";
import { currentSession } from "@/lib/session";
import db from "@/lib/db";

export default async function AdminPage() {
  const session = await currentSession();
  if (!session) redirect("/admin/login?returnTo=/admin");
  if (session.role !== "owner") redirect("/buyer");
  const orderSummary=db.prepare("SELECT COUNT(*) count,COALESCE(SUM(total_amount),0) revenue FROM orders WHERE deleted_at IS NULL").get() as {count:number;revenue:number};
  const customerSummary=db.prepare("SELECT COUNT(*) count FROM users WHERE role='buyer'").get() as {count:number};
  return <AdminDashboard initialOrderCount={orderSummary.count} initialRevenue={orderSummary.revenue} initialCustomerCount={customerSummary.count}/>;
}
