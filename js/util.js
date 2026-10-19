// 画面・データ層で共有する小さな道具。

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const yen = (n) => '¥' + Number(n || 0).toLocaleString('ja-JP');

// 旧パレットで保存済みの出品者の色を、表示のときだけ新しい色に置き換える(保存データは書き換えない)。
const LEGACY_COLORS = {
  '#c8472b': '#8c2f39', '#2f6db5': '#1f4e79', '#7a4fa3': '#5b3a7a', '#8f5f00': '#8a6d1b',
  '#1f7a66': '#1e6b5c', '#b83a72': '#a23b72', '#55662a': '#4d5d2a', '#4a5568': '#3d4451',
};
// 色は style 属性に埋め込むので、#rrggbb 以外は受け付けない。
export const safeColor = (c, fallback = '#3d4451') =>
  /^#[0-9a-f]{6}$/i.test(c) ? LEGACY_COLORS[c.toLowerCase()] ?? c : fallback;

export const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

// Excel で開いたときに数式として実行されないよう、=+-@ で始まる文字列には ' を付ける。
function csvCell(v) {
  if (typeof v === 'number') return String(v);
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');

export function download(name, text, type = 'text/csv') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

// 写真は端末側で縮小して JPEG の data URL にする(Firestore の 1 ドキュメント上限 1MB に収めるため)。
export async function resizePhoto(file, max = 400, quality = 0.72) {
  let src;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    src = await new Promise((ok, ng) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => ng(new Error('画像を読み込めませんでした'));
      img.src = URL.createObjectURL(file);
    });
  }
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  const r = Math.min(1, max / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * r);
  c.height = Math.round(h0 * r);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  src.close?.();
  return c.toDataURL('image/jpeg', quality);
}

// バックアップの取り込み用。想定外のフィールドは捨て、型を揃える。
export function cleanImport(data) {
  const str = (v, n = 200) => String(v ?? '').slice(0, n);
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const sellers = (data.sellers || []).filter((s) => s?.id).map((s) => ({
    id: str(s.id, 80), name: str(s.name, 30), color: safeColor(s.color), order: num(s.order),
  }));
  const products = (data.products || []).filter((p) => p?.id).map((p) => ({
    id: str(p.id, 80), sellerId: str(p.sellerId, 80), name: str(p.name, 40), price: Math.max(0, Math.round(num(p.price))),
    photo: typeof p.photo === 'string' && p.photo.startsWith('data:image/') ? p.photo : '',
    soldOut: !!p.soldOut, order: num(p.order),
  }));
  const sales = (data.sales || []).filter((s) => s?.id && Array.isArray(s.items)).map((s) => ({
    id: str(s.id, 80), ts: num(s.ts), staff: str(s.staff, 30), total: num(s.total), received: num(s.received),
    change: num(s.change), voided: !!s.voided,
    ...Object.fromEntries(['voidedAt', 'restoredAt'].filter((k) => s[k]).map((k) => [k, num(s[k])])),
    ...Object.fromEntries(['voidedBy', 'restoredBy'].filter((k) => s[k]).map((k) => [k, str(s[k], 30)])),
    items: s.items.map((i) => ({
      pid: str(i.pid, 80), sid: str(i.sid, 80), name: str(i.name, 40), sname: str(i.sname, 30),
      price: num(i.price), qty: Math.max(0, Math.round(num(i.qty))),
    })),
  }));
  return { sellers, products, sales };
}
