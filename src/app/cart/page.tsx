import { getCart, type Cart } from "@/lib/db";
import { CartPageContent } from "@/components/CartPanel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY_CART: Cart = { lines: [], total: 0, count: 0 };
export default async function CartPage({ searchParams }: { searchParams: Promise<{ session?: string }> }) {
  const { session = "" } = await searchParams;
  const sessionId = session.trim();
  const cart = sessionId ? await getCart(sessionId) : EMPTY_CART;
  return <CartPageContent cart={cart} sessionId={sessionId} />;
}
