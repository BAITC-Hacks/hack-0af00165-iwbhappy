export type ProductPreview = {
  sku: string;
  name: string;
  category: string;
  categoryTitle: string;
  brand: string;
  price: number;
  available: number;
  status: "in_stock" | "out_of_stock";
};

type Props = { products: ProductPreview[]; error: string; onAsk: (product: ProductPreview) => void };
const money = (value: number) => `${value.toLocaleString("ru-RU")} ₸`;

export default function ProductGrid({ products, error, onAsk }: Props) {
  if (error) return <div className="catalog-state error">Не удалось загрузить витрину: {error}</div>;
  if (products.length === 0) return <div className="catalog-state">Загружаем товары из локального каталога…</div>;

  return (
    <div className="product-grid">
      {products.map((product) => (
        <article className="product-card" key={product.sku}>
          <div className="product-card-top">
            <span className="product-sku">{product.sku}</span>
            <span className={`stock-dot ${product.status}`}>{product.available > 0 ? `${product.available} шт.` : "Нет в наличии"}</span>
          </div>
          <h3>{product.name}</h3>
          <p className="product-kind">{product.categoryTitle || product.category}</p>
          <div className="product-card-bottom">
            <div><strong>{money(product.price)}</strong>{product.brand && <span>{product.brand}</span>}</div>
            <button type="button" onClick={() => onAsk(product)}>Спросить</button>
          </div>
        </article>
      ))}
    </div>
  );
}
