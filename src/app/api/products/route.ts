import { searchCatalog } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const products = await searchCatalog("", undefined, 24);
  return Response.json({
    products: products.map((product) => ({
      sku: product.sku,
      name: product.name,
      category: product.category,
      categoryTitle: product.categoryTitle,
      brand: product.brand,
      price: product.price,
      available: product.available,
      status: product.status,
    })),
  });
}
