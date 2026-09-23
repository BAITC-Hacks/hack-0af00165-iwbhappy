(() => {
  if (document.querySelector("[data-ekt-assistant-widget]")) return;

  const script = document.currentScript;
  if (!(script instanceof HTMLScriptElement) || !script.src) return;
  const baseUrl = new URL(".", script.src).href;
  const host = document.createElement("div");
  host.dataset.ektAssistantWidget = "true";
  const shadow = host.attachShadow({ mode: "open" });
  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .launcher { position: fixed; right: 22px; bottom: 22px; z-index: 2147483000; width: 58px; height: 58px; border: 0; border-radius: 50%; background: #1769e0; color: #fff; box-shadow: 0 8px 28px #102b5060; font: 700 14px/1 system-ui,sans-serif; cursor: pointer; }
      .panel { position: fixed; right: 22px; bottom: 92px; z-index: 2147483000; display: none; width: min(390px, calc(100vw - 28px)); height: min(640px, calc(100dvh - 120px)); overflow: hidden; border: 1px solid #dce3ec; border-radius: 18px; background: #fff; box-shadow: 0 18px 60px #102b5033; }
      .panel.open { display: block; }
      .frame { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
      @media (max-width: 520px) { .panel { right: 8px; bottom: 76px; width: calc(100vw - 16px); height: min(76dvh, 680px); border-radius: 15px; } .launcher { right: 16px; bottom: 14px; } }
    </style>
    <section class="panel" aria-label="ИИ-консультант">
      <iframe class="frame" title="ИИ-консультант Электрокомплект" src="${baseUrl}embed" allow="clipboard-write"></iframe>
    </section>
    <button class="launcher" type="button" aria-label="Открыть чат" aria-expanded="false">ЭК</button>
  `;
  document.body.append(host);

  const panel = shadow.querySelector(".panel");
  const button = shadow.querySelector(".launcher");
  const frame = shadow.querySelector("iframe");
  let isOpen = false;
  const setOpen = (next) => {
    isOpen = next;
    panel.classList.toggle("open", isOpen);
    button.setAttribute("aria-expanded", String(isOpen));
    button.setAttribute("aria-label", isOpen ? "Закрыть чат" : "Открыть чат");
    button.textContent = isOpen ? "×" : "ЭК";
    if (isOpen && frame.contentWindow) {
      frame.contentWindow.postMessage({ type: "ekt-widget:init" }, new URL(frame.src).origin);
    }
  };
  button.addEventListener("click", () => setOpen(!isOpen));

  window.addEventListener("message", (event) => {
    if (!frame.contentWindow || event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin) return;
    if (event.data?.type === "ekt-widget:close") setOpen(false);
    if (event.data?.type === "ekt-widget:height" && Number.isFinite(event.data.height)) {
      frame.style.height = `${Math.max(420, Math.min(680, Number(event.data.height)))}px`;
    }
  });
})();
