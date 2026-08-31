import { currentSession } from "@/lib/session";

export async function ownerOrNull() {
  const session = await currentSession();
  return session?.role === "owner" ? session : null;
}

export async function buyerOrNull() {
  const session = await currentSession();
  return session?.role === "buyer" ? session : null;
}
