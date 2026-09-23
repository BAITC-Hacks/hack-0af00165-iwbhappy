import { tr, type Lang } from "./i18n";

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

type Props = { products: ProductPreview[]; error: string; onAsk: (product: ProductPreview) => void; lang: Lang };
const money = (value: number, lang: Lang) => `${value.toLocaleString(lang === "kk" ? "kk-KZ" : "ru-RU")} ₸`;

export default function ProductGrid({ products, error, onAsk, lang }: Props) {
  if (error) return <div className="catalog-state error">{tr(lang, "productLoadFailed")}{lang === "ru" ? `: ${error}` : ""}</div>;
  if (products.length === 0) return <div className="catalog-state">{tr(lang, "productLoading")}</div>;

  return (
    <div className="product-grid">
      {products.map((product) => (
        <article className="product-card" key={product.sku}>
          <div className="product-card-top">
            <span className="product-sku">{product.sku}</span>
            <span className={`stock-dot ${product.status}`} aria-label={product.available > 0 ? tr(lang, "inStock") : tr(lang, "outOfStock")}>{product.available > 0 ? `${product.available} ${tr(lang, "units")}` : tr(lang, "outOfStock")}</span>
          </div>
          <h3>{product.name}</h3>
          <p className="product-kind">{product.categoryTitle || product.category}</p>
          <div className="product-card-bottom">
            <div><strong>{money(product.price, lang)}</strong>{product.brand && <span>{product.brand}</span>}</div>
            <button type="button" onClick={() => onAsk(product)}>{tr(lang, "ask")}</button>
          </div>
        </article>
      ))}
    </div>
  );
}
