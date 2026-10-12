// Ícone na bandeja do Windows + painel suspenso. O backend (server.mjs) roda no mesmo processo.
import { app, BrowserWindow, Tray, Menu, nativeImage, screen } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.dirname(fileURLToPath(import.meta.url));
const W = 360, H = 560;

if (!app.requestSingleInstanceLock()) app.quit();
else start();

async function start() {
  const { URL_APP } = await import("./server.mjs");
  await app.whenReady();

  const api = async (p, desired) => {
    const r = await fetch(URL_APP + p, desired
      ? { method: "POST", headers: { "content-type": "application/json", "x-tcl-ar": "1" }, body: JSON.stringify({ desired }) }
      : undefined);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
    return r.json();
  };
  const isOn = (d) => Number(d.state?.powerSwitch) === 1;

  // Ícone desenhado em pixels (BGRA): círculo + floco de neve. Azul se algum ar ligado, cinza se nenhum.
  const icon = (on) => {
    const S = 32, buf = Buffer.alloc(S * S * 4), c = (S - 1) / 2;
    const [r, g, b] = on ? [56, 189, 248] : [100, 116, 139];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const dx = x - c, dy = y - c, i = (y * S + x) * 4;
      if (Math.hypot(dx, dy) > 15.5) continue;
      const flake = [0, Math.PI / 3, (2 * Math.PI) / 3].some((t) =>
        Math.abs(-Math.sin(t) * dx + Math.cos(t) * dy) < 1.4 && Math.abs(Math.cos(t) * dx + Math.sin(t) * dy) < 10);
      const [R, G, B] = flake ? [255, 255, 255] : [r, g, b];
      buf[i] = B; buf[i + 1] = G; buf[i + 2] = R; buf[i + 3] = 255;
    }
    return nativeImage.createFromBitmap(buf, { width: S, height: S });
  };

  const tray = new Tray(icon(false));
  tray.setToolTip("TCL Ar");

  const flyout = new BrowserWindow({
    width: W, height: H, show: false, frame: false, transparent: true, resizable: false, skipTaskbar: true,
    alwaysOnTop: true, fullscreenable: false, maximizable: false, minimizable: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  const loaded = flyout.loadURL(URL_APP + "/tray");
  let hiddenAt = 0;
  flyout.on("blur", () => { flyout.hide(); hiddenAt = Date.now(); });

  let full = null;
  const openFull = () => {
    if (full && !full.isDestroyed()) return full.show(), full.focus();
    full = new BrowserWindow({ width: 1280, height: 820, autoHideMenuBar: true, title: "TCL Ar", icon: icon(true), webPreferences: { contextIsolation: true, sandbox: true } });
    full.loadURL(URL_APP);
  };
  flyout.webContents.setWindowOpenHandler(() => { flyout.hide(); openFull(); return { action: "deny" }; });

  const showFlyout = () => {
    const tb = tray.getBounds();
    const wa = screen.getDisplayNearestPoint({ x: tb.x, y: tb.y }).workArea;
    const x = Math.min(Math.max(Math.round(tb.x + tb.width / 2 - W / 2), wa.x + 8), wa.x + wa.width - W - 8);
    const y = tb.y > wa.y + wa.height / 2 ? wa.y + wa.height - H - 8 : wa.y + 8; // barra embaixo ou em cima
    flyout.setPosition(x, y);
    flyout.show();
    flyout.focus();
  };
  tray.on("click", () => {
    if (flyout.isVisible()) return flyout.hide();
    if (Date.now() - hiddenAt < 300) return; // esse clique foi o que tirou o foco: fica fechado
    showFlyout();
  });

  // Ao iniciar com o Windows sobe escondido; aberto pelo usuário (ou pelo instalador) já mostra o painel/login.
  const loginItem = { path: process.execPath, args: app.isPackaged ? ["--hidden"] : [DIR, "--hidden"] };
  if (!process.argv.includes("--hidden")) loaded.then(showFlyout, () => {});
  tray.on("right-click", async () => {
    let devs = [];
    try { devs = await api("/api/devices"); } catch {}
    const setAll = (v) => Promise.all(devs.filter((d) => d.online && isOn(d) !== !!v).map((d) =>
      api(`/api/devices/${encodeURIComponent(d.id)}`, { powerSwitch: v }))).then(updateTray, () => {});
    tray.popUpContextMenu(Menu.buildFromTemplate([
      ...devs.map((d) => ({
        label: d.name + (d.online ? "" : " (offline)"), type: "checkbox", checked: isOn(d), enabled: d.online,
        click: () => api(`/api/devices/${encodeURIComponent(d.id)}`, { powerSwitch: isOn(d) ? 0 : 1 }).then(updateTray, () => {}),
      })),
      ...(devs.length ? [{ type: "separator" }, { label: "Ligar todos", click: () => setAll(1) }, { label: "Desligar todos", click: () => setAll(0) }, { type: "separator" }] : []),
      { label: "Abrir painel completo", click: openFull },
      { label: "Iniciar com o Windows", type: "checkbox", checked: app.getLoginItemSettings(loginItem).openAtLogin,
        click: (item) => app.setLoginItemSettings({ ...loginItem, openAtLogin: item.checked }) },
      { type: "separator" },
      { label: "Sair", click: () => app.quit() },
    ]));
  });

  async function updateTray() {
    try {
      const devs = await api("/api/devices");
      const on = devs.filter(isOn);
      tray.setImage(icon(on.length > 0));
      tray.setToolTip(on.length ? `TCL Ar — ligados: ${on.map((d) => d.name).join(", ")}` : "TCL Ar — todos desligados");
    } catch { tray.setToolTip("TCL Ar — clique para entrar"); }
  }
  updateTray();
  setInterval(updateTray, 30_000);

  app.on("second-instance", showFlyout);
  app.on("window-all-closed", () => {}); // continua na bandeja
}
