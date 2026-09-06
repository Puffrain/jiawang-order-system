import ReviewManager from "@/components/admin/review-workspace";
import { redirect } from "next/navigation";
import Link from "next/link";
import { currentSession } from "@/lib/session";
export default async function ReviewsPage() {
  const session = await currentSession();
  if (!session) redirect('/admin/login?returnTo=/admin/reviews');
  if (session.role !== 'owner') redirect('/buyer');
  return <main className="min-h-screen bg-white p-4 sm:p-8"><div className="mx-auto max-w-5xl"><Link href="/admin" className="mb-4 inline-block text-sm text-orange-700">返回后台</Link><ReviewManager/></div></main>;
}
