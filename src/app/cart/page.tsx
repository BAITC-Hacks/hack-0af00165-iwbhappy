import { getCart, getSessionByCartToken, type Cart } from "@/lib/db";
import { CartPageContent } from "@/components/CartPanel";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY_CART: Cart = { lines: [], total: 0, count: 0 };

/**
 * Страница корзины открывается по токену только для чтения (?c=…).
 * sessionId сюда не приходит и в разметку не попадает: он даёт право
 * менять корзину через чат. Старый формат ?session=… не поддерживается
 * намеренно — такая ссылка и была дырой.
 */
export default async function CartPage({ searchParams }: { searchParams: Promise<{ c?: string }> }) {
  const { c = "" } = await searchParams;
  const token = c.trim();
  const sessionId = token ? await getSessionByCartToken(token) : null;
  const cart = sessionId ? await getCart(sessionId) : EMPTY_CART;
  // В клиентский компонент уходит токен, а не sessionId: он нужен только
  // чтобы отличить «ссылки нет» от «корзина пуста».
  return <CartPageContent cart={cart} sessionId={sessionId ? token : ""} />;
}
