import { readFile } from "node:fs/promises";
import path from "node:path";

const CATALOG_PATH = path.resolve(process.cwd(), "data", "catalog.json");
const EXCLUDED_STORE_KEYWORDS = [
  "брак",
  "востановлен",
  "восстановлен",
  "перемещен",
  "образц",
  "витрин",
  "маркетинг",
] as const;

type JsonObject = Record<string, unknown>;

type Check = {
  label: string;
  passed: boolean;
  actual: string | number;
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stockTotal(product: JsonObject): number {
  if (!Array.isArray(product.stock)) return 0;
  return product.stock.reduce((sum: number, store: unknown) => {
    if (!isObject(store)) return sum;
    const quantity = Number(store.quantity);
    return sum + (Number.isFinite(quantity) ? quantity : 0);
  }, 0);
}

function hasRequiredFields(product: JsonObject): boolean {
  return (
    typeof product.sku === "string" &&
    product.sku.trim().length > 0 &&
    typeof product.name === "string" &&
    product.name.trim().length > 0 &&
    typeof product.category === "string" &&
    product.category.trim().length > 0 &&
    typeof product.price === "number" &&
    Number.isFinite(product.price) &&
    product.price > 0
  );
}

function hasExcludedStore(product: JsonObject): boolean {
  if (!Array.isArray(product.stock)) return false;

  return product.stock.some((store) => {
    if (!isObject(store) || typeof store.name !== "string") return false;
    const name = store.name.toLocaleLowerCase("ru-RU");
    return EXCLUDED_STORE_KEYWORDS.some((keyword) => name.includes(keyword));
  });
}

function printCheck(check: Check): void {
  console.log(
    `${check.passed ? "ПРОЙДЕНО" : "НЕ ПРОЙДЕНО"}: ${check.label}; фактически: ${check.actual}`,
  );
}

async function main(): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(CATALOG_PATH, "utf8"));
  } catch (error) {
    console.error(
      `НЕ ПРОЙДЕНО: чтение data/catalog.json; фактически: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
    return;
  }

  if (!Array.isArray(parsed)) {
    console.error(
      `НЕ ПРОЙДЕНО: корень catalog.json должен быть массивом; фактически: ${typeof parsed}`,
    );
    process.exitCode = 1;
    return;
  }

  const products = parsed.filter(isObject);
  const outOfStockCount = products.filter(
    (product) => product.status === "out_of_stock",
  ).length;
  const lowStockCount = products.filter((product) => {
    const total = stockTotal(product);
    return total >= 1 && total <= 3;
  }).length;
  const alternativesCount = products.filter(
    (product) =>
      Array.isArray(product.alternatives) && product.alternatives.length > 0,
  ).length;
  const certificateCount = products.filter(
    (product) => isObject(product.certificate),
  ).length;
  const validRequiredCount = products.filter(hasRequiredFields).length;
  const excludedStoreCount = products.filter(hasExcludedStore).length;

  const checks: Check[] = [
    {
      label: "товаров не меньше 250",
      passed: products.length >= 250 && products.length === parsed.length,
      actual: products.length,
    },
    {
      label: "позиций со статусом out_of_stock не меньше 5",
      passed: outOfStockCount >= 5,
      actual: outOfStockCount,
    },
    {
      label: "позиций с доступным остатком от 1 до 3 не меньше 5",
      passed: lowStockCount >= 5,
      actual: lowStockCount,
    },
    {
      label: "позиций с непустым alternatives не меньше 10",
      passed: alternativesCount >= 10,
      actual: alternativesCount,
    },
    {
      label: "позиций с непустым certificate не меньше 30",
      passed: certificateCount >= 30,
      actual: certificateCount,
    },
    {
      label: "у каждого товара заполнены sku, name, category и price > 0",
      passed:
        products.length > 0 &&
        validRequiredCount === products.length &&
        products.length === parsed.length,
      actual: `${validRequiredCount}/${parsed.length}`,
    },
    {
      label: "в stock нет складов из чёрного списка раздела 12.1",
      passed: excludedStoreCount === 0,
      actual: excludedStoreCount,
    },
  ];

  checks.forEach(printCheck);
  if (checks.some((check) => !check.passed)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
