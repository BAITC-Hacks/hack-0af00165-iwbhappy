import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@libsql/client"],
  eslint: { ignoreDuringBuilds: true },
  typescript: { ignoreBuildErrors: false },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // Встраивать чат во фрейм можно только нам самим и сайту партнёра.
          // Иначе чужая страница накроет кнопку «Да» прозрачным фреймом
          // и подтвердит добавление в корзину чужим кликом.
          { key: "Content-Security-Policy", value: "frame-ancestors 'self' https://ekt.kz https://*.ekt.kz" },
          // Ссылка на корзину содержит токен: наружу уходит только origin.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
