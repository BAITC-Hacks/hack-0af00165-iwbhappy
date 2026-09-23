import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Агент-магазин — HackAlem",
  description: "Агентная торговля: подбор, сравнение, заказ и возврат в одном диалоге",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
