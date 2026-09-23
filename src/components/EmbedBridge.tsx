"use client";

import { useEffect } from "react";

export default function EmbedBridge() {
  useEffect(() => {
    const parentOrigin = (() => {
      try { return document.referrer ? new URL(document.referrer).origin : "*"; }
      catch { return "*"; }
    })();
    const send = (message: Record<string, unknown>) => window.parent.postMessage(message, parentOrigin);

    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      if (parentOrigin !== "*" && event.origin !== parentOrigin) return;
      if (event.data?.type === "ekt-widget:init") send({ type: "ekt-widget:ready" });
    };
    window.addEventListener("message", onMessage);
    send({ type: "ekt-widget:ready" });

    const observer = new ResizeObserver(() => {
      send({ type: "ekt-widget:height", height: Math.ceil(document.documentElement.scrollHeight) });
    });
    observer.observe(document.documentElement);
    return () => {
      observer.disconnect();
      window.removeEventListener("message", onMessage);
    };
  }, []);

  return null;
}
