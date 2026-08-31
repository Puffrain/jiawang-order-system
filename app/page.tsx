import { redirect } from "next/navigation";
import BuyerLoginPage from "@/app/buyer/login/page";
import { currentSession } from "@/lib/session";

export default async function HomePage() {
  const session = await currentSession();
  if (session?.role === "buyer") redirect("/buyer");
  if (session?.role === "owner") redirect("/admin");
  return <BuyerLoginPage />;
}
