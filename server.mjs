// Controle local dos ar-condicionados TCL Home via nuvem TCL (AWS IoT Device Shadow).
// Protocolo baseado em github.com/nemesa/ha-tcl-home-unofficial-integration (não oficial).
// Uso: node server.mjs [--demo] [--selftest]
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const DEMO = process.argv.includes("--demo");
const PORT = DEMO ? 8766 : 8765; // portas separadas: demo aberto não sequestra o app real
const URL_APP = `http://127.0.0.1:${PORT}`;
const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(process.env.APPDATA || DIR, "tcl-ar");
const SESSION_FILE = path.join(DATA_DIR, "session.json");

const LOGIN_URL = "https://pa.account.tcl.com/account/login?clientId=54148614";
const CLOUD_URLS = "https://prod-center.aws.tcljd.com/v3/global/cloud_url_get";
const APP_ID = "wx6e1af3fa84fbe523";

const md5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");
const hmac = (k, s) => crypto.createHmac("sha256", k).update(s, "utf8").digest();
const jwtPayload = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString());

// ---------- AWS SigV4 ----------
export function sigv4({ method, host, path: p, query = "", body = "", region, service, creds, date = new Date() }) {
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const day = amzDate.slice(0, 8);
  const headers = { host, "x-amz-date": amzDate };
  if (creds.token) headers["x-amz-security-token"] = creds.token;
  const names = Object.keys(headers).sort();
  const canonicalUri = p.split("/").map((seg) => encodeURIComponent(seg)).join("/"); // segmentos já codificados -> 2x
  const canonical = [method, canonicalUri, query, names.map((n) => `${n}:${headers[n]}\n`).join(""), names.join(";"), sha256(body)].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  let k = hmac("AWS4" + creds.secret, day);
  for (const part of [region, service, "aws4_request"]) k = hmac(k, part);
  const signature = crypto.createHmac("sha256", k).update(toSign, "utf8").digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.key}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return headers;
}

if (process.argv.includes("--selftest")) {
  // Vetor oficial "get-vanilla" da suíte de testes SigV4 da AWS.
  const h = sigv4({
    method: "GET", host: "example.amazonaws.com", path: "/", region: "us-east-1", service: "service",
    creds: { key: "AKIDEXAMPLE", secret: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
    date: new Date("2015-08-30T12:36:00Z"),
  });
  const ok = h.authorization.endsWith("Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
  console.log(ok ? "selftest OK" : "selftest FALHOU\n" + h.authorization);
  process.exit(ok ? 0 : 1);
}

// ---------- Cliente TCL ----------
async function postJson(url, body, headers = {}) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "user-agent": "Android", "content-type": "application/json; charset=UTF-8", ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`HTTP ${r.status} em ${new URL(url).pathname}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function signedTclHeaders(saasToken) {
  const timestamp = String(Date.now());
  const nonce = crypto.randomBytes(8).toString("hex");
  return {
    platform: "android", appversion: "5.4.1", thomeversion: "4.8.1", "accept-language": "en",
    accesstoken: saasToken, timestamp, nonce, sign: md5(timestamp + nonce + saasToken),
  };
}

const S = { username: null, pwMd5: null, s: null }; // s = sessão em memória (tokens, urls, credenciais AWS)

function loadSession() {
  try { Object.assign(S, JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"))); } catch {}
}
function saveSession() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // Só e-mail + MD5 da senha (é o que a API TCL recebe); tokens ficam só em memória.
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ username: S.username, pwMd5: S.pwMd5 }));
}

// ponytail: refaz o login completo quando as credenciais AWS (~1h) vencem; se a TCL começar a pedir captcha, usar refresh_token.
async function authenticate() {
  const login = await postJson(LOGIN_URL, {
    equipment: 2, password: S.pwMd5, osType: 1, username: S.username, clientVersion: "4.8.1",
    osVersion: "6.0", deviceModel: "AndroidAndroid SDK built for x86", captchaRule: 2, channel: "app",
  }, { th_platform: "android", th_version: "4.8.1", th_appbulid: "830" });
  if (login.status !== 1) throw new Error(login.msg || login.message || "Login recusado pela TCL (e-mail/senha?)");
  const ssoUser = login.user.username;

  const urls = (await postJson(CLOUD_URLS, { ssoId: ssoUser, ssoToken: login.token })).data;
  const tokens = (await postJson(`${urls.cloud_url}/v3/auth/refresh_tokens`, { userId: ssoUser, ssoToken: login.token, appId: APP_ID })).data;
  if (!tokens?.saasToken && !tokens?.saas_token) throw new Error("TCL não retornou tokens da nuvem");
  const cognitoToken = tokens.cognitoToken || tokens.cognito_token;

  const r = await fetch(`https://cognito-identity.${urls.cloud_region}.amazonaws.com/`, {
    method: "POST",
    headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityService.GetCredentialsForIdentity" },
    body: JSON.stringify({ IdentityId: jwtPayload(cognitoToken).sub, Logins: { "cognito-identity.amazonaws.com": cognitoToken } }),
  });
  const cred = (await r.json()).Credentials;
  if (!cred) throw new Error("AWS Cognito recusou as credenciais");

  S.s = {
    saas: tokens.saasToken || tokens.saas_token,
    deviceUrl: urls.device_url,
    region: urls.cloud_region,
    creds: { key: cred.AccessKeyId, secret: cred.SecretKey, token: cred.SessionToken },
    exp: cred.Expiration * 1000,
  };
}

async function ensure(force = false) {
  if (!S.username) throw Object.assign(new Error("Faça login"), { status: 401 });
  if (force || !S.s || Date.now() > S.s.exp - 120_000) await authenticate();
}

async function iot(method, p, query = "", body = "") {
  const host = `data-ats.iot.${S.s.region}.amazonaws.com`;
  const headers = sigv4({ method, host, path: p, query, body, region: S.s.region, service: "iotdata", creds: S.s.creds });
  const r = await fetch(`https://${host}${p}${query ? "?" + query : ""}`, { method, headers, body: body || undefined });
  const text = await r.text();
  if (!r.ok) throw Object.assign(new Error(`AWS IoT ${r.status}: ${text.slice(0, 200)}`), { status: r.status });
  return text ? JSON.parse(text) : {};
}

async function withRetry(fn) {
  await ensure();
  try { return await fn(); }
  catch (e) { if (e.status === 401 || e.status === 403) { await ensure(true); return fn(); } throw e; }
}

async function listDevices() {
  return withRetry(async () => {
    const res = await postJson(`${S.s.deviceUrl}/v3/user/get_things`, {}, signedTclHeaders(S.s.saas));
    const things = Array.isArray(res.data) ? res.data : [];
    return Promise.all(things.map(async (t) => {
      const id = t.deviceId || t.device_id;
      let state = {};
      try {
        const sh = await iot("GET", `/things/${encodeURIComponent(id)}/shadow`);
        state = { ...sh.state?.reported, ...sh.state?.delta };
      } catch (e) { state = { _error: e.message }; }
      return {
        id, name: t.nickName || t.nick_name || t.deviceName || id, model: t.deviceName || t.device_name || "",
        online: Number(t.isOnline ?? t.is_online) === 1, state,
      };
    }));
  });
}

async function setDesired(id, desired) {
  const body = JSON.stringify({ state: { desired }, clientToken: `mobile_${Math.floor(Date.now() / 1000)}` });
  return withRetry(() => iot("POST", `/topics/${encodeURIComponent(`$aws/things/${id}/shadow/update`)}`, "qos=1", body));
}

// ---------- Demo (sem conta, só para ver a interface) ----------
const demo = ["Sala", "Quarto casal", "Quarto hóspedes", "Escritório"].map((name, i) => ({
  id: `demo-${i}`, name, model: "Split AC", online: i !== 3,
  state: { powerSwitch: i % 2 ? 0 : 1, targetTemperature: 22 + i, currentTemperature: 27 - i, workMode: 1, windSpeed: 0, verticalSwitch: 1, ECO: 0, sleep: 0, turbo: 0, screen: 1, beepSwitch: 1 },
}));

// ---------- Servidor HTTP ----------
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
const readBody = (req) => new Promise((ok, fail) => {
  let b = ""; req.on("data", (c) => { b += c; if (b.length > 1e5) req.destroy(); });
  req.on("end", () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { fail(e); } });
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, URL_APP);
  try {
    if (!url.pathname.startsWith("/api/")) {
      const html = fs.readFileSync(path.join(DIR, "public", url.pathname === "/tray" ? "tray.html" : "index.html"));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    // Header custom força preflight CORS (não respondido) => outro site no navegador não consegue mandar comando.
    if (req.method !== "GET" && req.headers["x-tcl-ar"] !== "1") return send(res, 403, { error: "forbidden" });
    if (req.headers.host !== `127.0.0.1:${PORT}`) return send(res, 403, { error: "forbidden" });

    if (url.pathname === "/api/status") return send(res, 200, { loggedIn: DEMO || !!S.username, demo: DEMO, user: DEMO ? "demo" : S.username });

    if (url.pathname === "/api/login" && req.method === "POST") {
      const { username, password } = await readBody(req);
      if (!username || !password) return send(res, 400, { error: "Informe e-mail e senha" });
      S.username = String(username).trim(); S.pwMd5 = md5(String(password));
      try { await ensure(true); } catch (e) { S.username = S.pwMd5 = null; throw e; }
      saveSession();
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
      S.username = S.pwMd5 = S.s = null;
      fs.rmSync(SESSION_FILE, { force: true });
      return send(res, 200, { ok: true });
    }
    if (url.pathname === "/api/devices" && req.method === "GET") {
      return send(res, 200, DEMO ? demo : await listDevices());
    }
    const m = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
    if (m && req.method === "POST") {
      const id = decodeURIComponent(m[1]);
      const { desired } = await readBody(req);
      if (!desired || typeof desired !== "object") return send(res, 400, { error: "desired inválido" });
      if (DEMO) { Object.assign(demo.find((d) => d.id === id)?.state ?? {}, desired); return send(res, 200, { ok: true }); }
      await setDesired(id, desired);
      return send(res, 200, { ok: true });
    }
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, e.status === 401 ? 401 : 502, { error: e.message });
  }
});

const openWindow = () => spawn("cmd", ["/c", "start", "", "msedge", `--app=${URL_APP}`, "--window-size=1280,820"], { detached: true, stdio: "ignore" }).unref();

const IN_ELECTRON = !!process.versions.electron; // main.mjs cuida das janelas

loadSession();
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { // já rodando: reaproveita
    if (!IN_ELECTRON) { openWindow(); process.exit(0); }
    return;
  }
  throw e;
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(`TCL Ar rodando em ${URL_APP}${DEMO ? " (demo)" : ""}`);
  if (!IN_ELECTRON && !process.argv.includes("--no-open")) openWindow();
});
export { URL_APP, DEMO };
