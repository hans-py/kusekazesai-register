// デモ/お試し用: データをこの端末の localStorage にだけ保存する。他の端末とは共有されない。
import { newId, cleanImport } from './util.js';

const KEY = 'bunkasai-register-demo-v1';

export function create() {
  const empty = () => ({ sellers: [], products: [], sales: [] });
  let data = empty();
  try {
    data = { ...empty(), ...JSON.parse(localStorage.getItem(KEY)) };
  } catch {
    /* 初回、または保存領域が使えない */
  }
  const changeFns = new Set();
  const errorFns = new Set();

  // 画面確認用: URL に ?role=staff を付けると、スタッフ(売上を読めない)の見え方を再現する。
  const asStaff = new URLSearchParams(location.search).get('role') === 'staff';

  const snapshot = () => ({
    sellers: [...data.sellers].sort((a, b) => a.order - b.order),
    products: [...data.products].sort((a, b) => a.order - b.order),
    sales: asStaff ? [] : [...data.sales].sort((a, b) => a.ts - b.ts),
    pending: 0,
    offline: false,
    ready: true,
  });
  const emit = () => changeFns.forEach((f) => f(snapshot()));
  const persist = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(data));
    } catch {
      errorFns.forEach((f) => f('端末の保存容量がいっぱいで保存できませんでした(写真を減らしてください)'));
    }
    emit();
  };
  const upsert = (list, obj) => {
    const id = obj.id || newId();
    const i = list.findIndex((x) => x.id === id);
    const next = { ...(i >= 0 ? list[i] : {}), ...obj, id };
    if (i >= 0) list[i] = next;
    else list.push(next);
    return id;
  };

  return {
    mode: 'demo',
    onAuth(fn) {
      queueMicrotask(() => fn(true, asStaff ? 'staff' : 'admin'));
    },
    async login() {},
    async logout() {},
    onChange(fn) {
      changeFns.add(fn);
      queueMicrotask(() => fn(snapshot()));
    },
    onError(fn) {
      errorFns.add(fn);
    },
    saveSeller(o) {
      const id = upsert(data.sellers, o);
      persist();
      return id;
    },
    deleteSeller(id) {
      data.sellers = data.sellers.filter((x) => x.id !== id);
      persist();
    },
    saveProduct(o) {
      const id = upsert(data.products, o);
      persist();
      return id;
    },
    deleteProduct(id) {
      data.products = data.products.filter((x) => x.id !== id);
      persist();
    },
    addSale(sale) {
      const id = upsert(data.sales, sale);
      persist();
      return id;
    },
    setVoided(id, voided, by = '') {
      const s = data.sales.find((x) => x.id === id);
      if (s) Object.assign(s, voided ? { voided: true, voidedAt: Date.now(), voidedBy: by } : { voided: false, restoredAt: Date.now(), restoredBy: by });
      persist();
    },
    clearSales() {
      data.sales = [];
      persist();
    },
    exportAll() {
      return snapshotForExport(data);
    },
    importAll(raw) {
      const c = cleanImport(raw);
      c.sellers.forEach((o) => upsert(data.sellers, o));
      c.products.forEach((o) => upsert(data.products, o));
      c.sales.forEach((o) => upsert(data.sales, o));
      persist();
    },
  };
}

const snapshotForExport = (d) => ({ sellers: d.sellers, products: d.products, sales: d.sales });
