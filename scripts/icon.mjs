// Gera build/icon.png (256x256) — mesmo desenho do ícone da bandeja. Uso: node scripts/icon.mjs
import fs from "node:fs";
import zlib from "node:zlib";

const S = 256, c = (S - 1) / 2, R = 124, k = S / 32;
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
  const dx = x - c, dy = y - c, i = y * (S * 4 + 1) + 1 + x * 4;
  const d = Math.hypot(dx, dy);
  if (d > R) continue;
  const flake = [0, Math.PI / 3, (2 * Math.PI) / 3].some((t) =>
    Math.abs(-Math.sin(t) * dx + Math.cos(t) * dy) < 1.4 * k && Math.abs(Math.cos(t) * dx + Math.sin(t) * dy) < 10 * k);
  const rgb = flake ? [255, 255, 255] : [56, 189, 248];
  raw.set([...rgb, Math.round(255 * Math.min(1, R - d))], i); // borda suavizada
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let v = n; for (let j = 0; j < 8; j++) v = v & 1 ? 0xedb88320 ^ (v >>> 1) : v >>> 1; return v >>> 0; });
const crc = (b) => { let v = 0xffffffff; for (const x of b) v = crcTable[(v ^ x) & 255] ^ (v >>> 8); return (v ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const cr = Buffer.alloc(4); cr.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, cr]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4); ihdr.set([8, 6, 0, 0, 0], 8);
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
]);
// ICO com o PNG embutido (Windows Vista+): cabeçalho 6 bytes + 1 entrada de 16 bytes.
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); // tipo ícone, 1 imagem
ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); // planos, bits (largura/altura 0 = 256)
ico.writeUInt32LE(png.length, 14); ico.writeUInt32LE(22, 18);
fs.mkdirSync("build", { recursive: true });
fs.writeFileSync("build/icon.png", png);
fs.writeFileSync("build/icon.ico", Buffer.concat([ico, png]));
console.log("build/icon.png + build/icon.ico ok");
