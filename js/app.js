import { createStore } from './store.js';
import { esc, yen, safeColor, toCsv, download, resizePhoto } from './util.js';

const SELLER_COLORS = ['#c8472b', '#2f6db5', '#7a4fa3', '#8f5f00', '#1f7a66', '#b83a72', '#55662a', '#4a5568'];
const VIEWS = ['register', 'report', 'history', 'setup', 'admin'];
// 役割ごとに開ける画面。スタッフは売上を読めない(Firestore のルールで強制)ので、売上系の画面は出さない。
// スタッフもレジと商品登録はできる。
const TABS = {
  admin: [['register', 'レジ'], ['report', '集計'], ['history', '履歴'], ['setup', '登録'], ['admin', '管理']],
  staff: [['register', 'レジ'], ['setup', '登録'], ['admin', '設定']],
};

const $ = (s, r = document) => r.querySelector(s);
const main = $('#main');
const dlg = $('#dlg');
const dlg2 = $('#dlg2');

const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 保存できなくても動作は続ける */ } };

let store;
let state = { sellers: [], products: [], sales: [], pending: 0, offline: false, ready: false };
let sellerById = new Map();
let productById = new Map();
let loggedIn = null; // null = 確認中
let role = 'admin'; // 'admin' | 'staff'
let loginAsAdmin = false;
let histFilter = 'all';
let histLimit = 50;
let view = VIEWS.includes(lsGet('rg.view')) ? lsGet('rg.view') : 'register';
let filterSeller = 'all';
let staff = lsGet('rg.staff') || '';
let cart = new Map();
try { cart = new Map(JSON.parse(lsGet('rg.cart') || '[]')); } catch { /* 壊れていたら空から */ }
const openSellers = new Set(); // 集計画面で開いている出品者
let dlgHandler = null;

const saveCart = () => lsSet('rg.cart', JSON.stringify([...cart]));
const colorOf = (sid) => safeColor(sellerById.get(sid)?.color);
const dateTimeStr = (ts) => new Date(ts).toLocaleString('ja-JP', { hour12: false });

/* ============ 起動 ============ */
async function boot() {
  store = await createStore();
  store.onChange((s) => { state = s; reindex(); render(); });
  store.onError((m) => toast(m, { error: true, ms: 6000 }));
  store.onAuth((ok, r) => {
    loggedIn = ok;
    role = r || 'admin';
    render();
    if (ok && !staff) askStaff();
  });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

function reindex() {
  sellerById = new Map(state.sellers.map((s) => [s.id, s]));
  productById = new Map(state.products.map((p) => [p.id, p]));
  const order = new Map(state.sellers.map((s, i) => [s.id, i]));
  state.products = [...state.products].sort(
    (a, b) => (order.get(a.sellerId) ?? 99) - (order.get(b.sellerId) ?? 99) || a.order - b.order
  );
  if (filterSeller !== 'all' && !sellerById.has(filterSeller)) filterSeller = 'all';
  if (state.ready) {
    let changed = false;
    for (const pid of [...cart.keys()]) if (!productById.has(pid)) { cart.delete(pid); changed = true; }
    if (changed) saveCart();
  }
}

/* ============ 描画の入口 ============ */
function render() {
  const y = window.scrollY;
  const ok = loggedIn === true;
  $('#tabbar').hidden = !ok;
  $('#staffBtn').hidden = !ok;
  $('#staffName').textContent = staff || '未設定';
  renderSync();
  if (loggedIn === null) { main.innerHTML = '<p class="muted pad">読み込み中…</p>'; return; }
  if (!ok) { renderLogin(); updateCartBar(); return; }
  if (!TABS[role].some(([v]) => v === view)) view = 'register';
  $('#tabbar').style.setProperty('--tabs', TABS[role].length);
  $('#tabbar').innerHTML = TABS[role]
    .map(([v, label]) => `<button type="button" data-view="${v}" class="${v === view ? 'is-on' : ''}">${label}</button>`)
    .join('');
  ({ register: renderRegister, report: renderReport, history: renderHistory, setup: renderSetup, admin: renderAdmin })[view]();
  updateCartBar();
  window.scrollTo(0, y);
}

function renderSync() {
  const el = $('#syncState');
  if (loggedIn !== true) { el.textContent = ''; return; }
  el.className = 'sync';
  if (store.mode === 'demo') { el.textContent = 'デモ'; el.classList.add('is-off'); }
  else if (state.pending > 0) { el.textContent = `未同期 ${state.pending}件`; el.classList.add('is-warn'); }
  else if (state.offline) { el.textContent = 'オフライン'; el.classList.add('is-off'); }
  else el.textContent = '同期済み';
}

/* ============ ログイン ============ */
function renderLogin() {
  main.innerHTML = `
    <form class="login" id="loginForm">
      <h2>${loginAsAdmin ? '管理者ログイン' : '合言葉を入力'}</h2>
      <label class="field"><span>${loginAsAdmin ? '管理者の合言葉' : '合言葉'}</span>
        <input class="input" type="password" id="pin" autocomplete="current-password" required>
      </label>
      <p class="err" id="loginErr" role="alert"></p>
      <button class="btn primary big">ログイン</button>
      <p class="hint">初回だけネット接続が必要です。ログイン後は電波がなくても使えます。</p>
      ${store.adminEnabled ? `<button type="button" class="btn ghost" id="roleSwitch">${loginAsAdmin ? 'スタッフとしてログインする' : '管理者としてログインする'}</button>` : ''}
    </form>`;
  $('#roleSwitch')?.addEventListener('click', () => { loginAsAdmin = !loginAsAdmin; renderLogin(); });
  $('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    try {
      await store.login($('#pin').value, loginAsAdmin);
    } catch (err) {
      const code = err?.code || '';
      $('#loginErr').textContent =
        code.includes('invalid-credential') || code.includes('wrong-password') ? '合言葉が違います'
        : code.includes('network') ? 'ネットに接続できません。電波のある場所で一度ログインしてください'
        : code.includes('too-many') ? '試行が多すぎます。少し待ってからやり直してください'
        : 'ログインできませんでした(' + code + ')';
      btn.disabled = false;
    }
  });
}

/* ============ レジ画面 ============ */
function tileHtml(p) {
  const qty = cart.get(p.id) || 0;
  const s = sellerById.get(p.sellerId);
  const c = colorOf(p.sellerId);
  const photo = p.photo
    ? `<img src="${esc(p.photo)}" alt="" loading="lazy">`
    : `<span class="ph" style="--c:${c}">${esc([...p.name][0] || '?')}</span>`;
  return `
    <div class="tile ${qty ? 'is-on' : ''} ${p.soldOut ? 'is-out' : ''}" data-pid="${esc(p.id)}">
      <button type="button" class="tile-main" data-act="add" data-pid="${esc(p.id)}" ${p.soldOut ? 'disabled' : ''}
        aria-label="${esc(p.name)} ${yen(p.price)} を追加">
        <span class="tile-photo">${photo}</span>
        <span class="tile-body">
          <span class="tile-name">${esc(p.name)}</span>
          <span class="tile-meta">
            <span class="tile-seller" style="--c:${c}"><i class="dot"></i><span>${esc(s?.name || '')}</span></span>
            <span class="tile-price">${yen(p.price)}</span>
          </span>
        </span>
      </button>
      ${qty ? `<span class="tile-qty" aria-label="${qty}個">${qty}</span>
      <button type="button" class="tile-minus" data-act="minus" data-pid="${esc(p.id)}" aria-label="${esc(p.name)}を1つ減らす">−</button>` : ''}
      ${p.soldOut ? '<span class="tile-soldout">売り切れ</span>' : ''}
    </div>`;
}

function renderRegister() {
  if (!state.sellers.length || !state.products.length) {
    main.innerHTML = `
      <section class="empty">
        <h2>商品がまだ登録されていません</h2>
        <p>「登録」画面で出品者と商品(写真つき)を追加すると、ここにタイルが並びます。</p>
        <button class="btn primary" data-act="goto" data-view="setup">登録画面へ</button>
      </section>`;
    return;
  }
  const chips = [
    `<button type="button" class="chip ${filterSeller === 'all' ? 'is-on' : ''}" data-act="filter" data-sid="all">すべて</button>`,
    ...state.sellers.map((s) => `
      <button type="button" class="chip ${filterSeller === s.id ? 'is-on' : ''}" style="--c:${safeColor(s.color)}" data-act="filter" data-sid="${esc(s.id)}">
        <i class="dot"></i>${esc(s.name)}
      </button>`),
  ].join('');
  const list = state.products.filter((p) => filterSeller === 'all' || p.sellerId === filterSeller);
  main.innerHTML = `
    <div class="chips" role="group" aria-label="出品者で絞り込み">${chips}</div>
    <div class="grid">${list.map(tileHtml).join('')}</div>`;
}

function cartLines() {
  return [...cart].map(([pid, qty]) => ({ p: productById.get(pid), qty })).filter((l) => l.p);
}
const cartTotal = () => cartLines().reduce((a, l) => a + l.p.price * l.qty, 0);
const cartCount = () => cartLines().reduce((a, l) => a + l.qty, 0);

function updateCartBar() {
  const n = cartCount();
  const show = loggedIn === true && view === 'register' && n > 0;
  $('#cartBar').hidden = !show;
  document.body.classList.toggle('has-cart', show);
  if (show) $('#cartSummary').innerHTML = `<span>${n}点</span><strong>${yen(cartTotal())}</strong>`;
}

function changeCart(pid, d) {
  const q = (cart.get(pid) || 0) + d;
  if (q <= 0) cart.delete(pid);
  else cart.set(pid, Math.min(q, 99));
  saveCart();
}

// タップのたびに画面全体を描き直すと写真が再デコードされるので、該当タイルだけ差し替える。
function refreshTile(pid) {
  const old = main.querySelector(`.tile[data-pid="${CSS.escape(pid)}"]`);
  const p = productById.get(pid);
  if (old && p) old.outerHTML = tileHtml(p);
  updateCartBar();
}

/* ---- 会計ダイアログ ---- */
function openCheckout() {
  if (!cartLines().length) return;
  let received = 0;
  let busy = false;

  const draw = () => {
    const lines = cartLines();
    if (!lines.length) { dlg.close(); render(); return; }
    const total = cartTotal();
    const ok = received >= total && !busy;
    const diff = received - total;
    dlg.innerHTML = `
      <div class="sheet checkout">
        <header><h2>会計</h2><button type="button" class="icon-btn" data-d="close" aria-label="閉じる">×</button></header>
        <ul class="lines">
          ${lines.map(({ p, qty }) => `
            <li class="line">
              <div class="line-name">${esc(p.name)}</div>
              <div class="line-amt">${yen(p.price * qty)}</div>
              <div class="line-sub"><i class="dot" style="--c:${colorOf(p.sellerId)}"></i><span>${esc(sellerById.get(p.sellerId)?.name || '')} · ${yen(p.price)}</span></div>
              <div class="stepper">
                <button type="button" data-d="dec" data-pid="${esc(p.id)}" aria-label="${esc(p.name)}を1つ減らす">−</button>
                <output>${qty}</output>
                <button type="button" data-d="inc" data-pid="${esc(p.id)}" aria-label="${esc(p.name)}を1つ増やす">＋</button>
              </div>
            </li>`).join('')}
        </ul>
        <div class="amounts">
          <div><span>合計</span><strong>${yen(total)}</strong></div>
          <div><span>お預かり</span><output>${yen(received)}</output></div>
        </div>
        <div class="quick">
          <button type="button" class="btn" data-d="exact">ちょうど</button>
          <button type="button" class="btn" data-d="add" data-v="1000">＋1,000</button>
          <button type="button" class="btn" data-d="add" data-v="5000">＋5,000</button>
          <button type="button" class="btn" data-d="add" data-v="10000">＋10,000</button>
        </div>
        <div class="keypad">
          ${['7', '8', '9', '4', '5', '6', '1', '2', '3', 'C', '0', '00'].map((k) => k === 'C'
            ? '<button type="button" class="key key-clear" data-d="key" data-k="C" aria-label="お預かり金額をクリア">クリア</button>'
            : `<button type="button" class="key" data-d="key" data-k="${k}">${k}</button>`).join('')}
        </div>
        <div class="sheet-foot">
          <div class="change ${received === 0 ? '' : diff >= 0 ? 'ok' : 'short'}">
            ${received === 0 ? 'お預かり金額を入力してください' : diff >= 0 ? `おつり ${yen(diff)}` : `あと ${yen(-diff)} 足りません`}
          </div>
          <button type="button" class="btn primary big" data-d="confirm" ${ok ? '' : 'disabled'}>会計を確定する</button>
        </div>
      </div>`;
  };

  dlgHandler = (t) => {
    const a = t.dataset.d;
    if (a === 'close') dlg.close();
    else if (a === 'inc') { changeCart(t.dataset.pid, 1); draw(); }
    else if (a === 'dec') { changeCart(t.dataset.pid, -1); draw(); }
    else if (a === 'exact') { received = cartTotal(); draw(); }
    else if (a === 'add') { received = Math.min(received + Number(t.dataset.v), 9999999); draw(); }
    else if (a === 'key') {
      const k = t.dataset.k;
      received = k === 'C' ? 0 : Math.min(Number(String(received === 0 ? '' : received) + k), 9999999);
      draw();
    } else if (a === 'confirm') {
      if (busy || received < cartTotal()) return;
      busy = true;
      const lines = cartLines();
      const total = cartTotal();
      const sale = {
        ts: Date.now(),
        staff: staff || '未設定',
        items: lines.map(({ p, qty }) => ({
          pid: p.id, sid: p.sellerId, name: p.name, sname: sellerById.get(p.sellerId)?.name || '', price: p.price, qty,
        })),
        total, received, change: received - total, voided: false,
      };
      const id = store.addSale(sale);
      cart.clear();
      saveCart();
      dlg.close();
      render();
      toast(`会計完了 ${yen(total)} ／ おつり ${yen(sale.change)}`, {
        ms: 10000,
        action: '取り消す',
        onAction: () => { store.setVoided(id, true, staff || '未設定'); toast('直前の会計を取り消しました'); },
      });
    }
  };
  draw();
  dlg.showModal();
}

/* ============ 集計画面 ============ */
function aggregate() {
  const live = state.sales.filter((s) => !s.voided);
  const bySeller = new Map();
  const byStaff = new Map();
  let qty = 0;
  let total = 0;
  for (const s of live) {
    total += s.total;
    const st = byStaff.get(s.staff) || { count: 0, amount: 0 };
    st.count += 1;
    st.amount += s.total;
    byStaff.set(s.staff, st);
    for (const i of s.items) {
      qty += i.qty;
      const b = bySeller.get(i.sid) || { sid: i.sid, name: i.sname, qty: 0, amount: 0, products: new Map() };
      b.qty += i.qty;
      b.amount += i.price * i.qty;
      const pr = b.products.get(i.pid) || { name: i.name, price: i.price, qty: 0, amount: 0 };
      pr.qty += i.qty;
      pr.amount += i.price * i.qty;
      b.products.set(i.pid, pr);
      bySeller.set(i.sid, b);
    }
  }
  const order = new Map(state.sellers.map((s, i) => [s.id, i]));
  const sellers = [...bySeller.values()].sort((a, b) => (order.get(a.sid) ?? 99) - (order.get(b.sid) ?? 99));
  return { live, total, qty, sellers, byStaff };
}

function renderReport() {
  const ag = aggregate();
  if (!state.sales.length) {
    main.innerHTML = `<section class="empty"><h2>まだ会計がありません</h2><p>レジ画面で会計を確定すると、ここに出品者別・商品別の売上が出ます。</p></section>`;
    return;
  }
  const sellerBlocks = ag.sellers.map((b) => `
    <details class="seller-block" data-sid="${esc(b.sid)}" ${openSellers.has(b.sid) ? 'open' : ''}>
      <summary>
        <i class="dot" style="--c:${colorOf(b.sid)}"></i>
        <span class="name">${esc(sellerById.get(b.sid)?.name || b.name)}</span>
        <span class="sub">${b.qty}点</span>
        <span class="amt">${yen(b.amount)}</span>
      </summary>
      <div class="inner">
        <table>
          <thead><tr><th>商品</th><th class="num">単価</th><th class="num">個数</th><th class="num">金額</th></tr></thead>
          <tbody>${[...b.products.values()].map((p) => `
            <tr><td>${esc(p.name)}</td><td class="num">${yen(p.price)}</td><td class="num">${p.qty}</td><td class="num">${yen(p.amount)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
    </details>`).join('');

  const staffRows = [...ag.byStaff].map(([name, v]) =>
    `<tr><td>${esc(name)}</td><td class="num">${v.count}件</td><td class="num">${yen(v.amount)}</td></tr>`).join('');

  const voidedCount = state.sales.length - ag.live.length;

  main.innerHTML = `
    <div class="stats">
      <div class="stat main"><span>総売上</span><strong>${yen(ag.total)}</strong></div>
      <div class="stat"><span>会計数</span><strong>${ag.live.length}</strong></div>
      <div class="stat"><span>販売点数</span><strong>${ag.qty}</strong></div>
      <div class="stat"><span>客単価</span><strong>${ag.live.length ? yen(Math.round(ag.total / ag.live.length)) : '—'}</strong></div>
    </div>

    <h2 class="section-title">出品者別</h2>
    ${sellerBlocks || '<p class="muted">有効な会計がありません</p>'}
    <div class="card-actions" style="margin-top:var(--s4)">
      <button type="button" class="btn" data-act="csv-settle">出品者別の精算CSV</button>
      <button type="button" class="btn" data-act="csv-detail">会計明細CSV</button>
    </div>

    <h2 class="section-title">担当者別(シフト)</h2>
    <div class="card"><table>
      <thead><tr><th>担当</th><th class="num">会計</th><th class="num">売上</th></tr></thead>
      <tbody>${staffRows || '<tr><td colspan="3" class="muted">なし</td></tr>'}</tbody>
    </table></div>

    <p class="muted" style="margin-top:var(--s5)">取消済み ${voidedCount} 件は集計に含めていません。
      <button type="button" class="btn ghost sm" data-act="goto" data-view="history">会計履歴を見る</button></p>`;
}

/* ============ 履歴画面(管理者のみ) ============ */
function saleRow(s) {
  const audit = [
    s.voided && s.voidedAt ? `取消: ${esc(s.voidedBy || '不明')} ／ ${dateTimeStr(s.voidedAt)}` : '',
    !s.voided && s.restoredAt ? `取消を戻した: ${esc(s.restoredBy || '不明')} ／ ${dateTimeStr(s.restoredAt)}` : '',
  ].filter(Boolean).join('<br>');
  return `
    <li class="sale ${s.voided ? 'is-void' : ''}">
      <div>
        <div class="sale-head">${dateTimeStr(s.ts)} ／ ${esc(s.staff)}${s.voided ? ' ／ 取消済み' : ''}</div>
        <div class="sale-items">${s.items.map((i) => `${esc(i.name)}×${i.qty}`).join('、')}</div>
        <div class="sale-head">お預かり ${yen(s.received)} ／ おつり ${yen(s.change)}</div>
        ${audit ? `<div class="sale-audit">${audit}</div>` : ''}
      </div>
      <div class="sale-total">${yen(s.total)}</div>
      <button type="button" class="btn sm ${s.voided ? '' : 'danger'}" data-act="${s.voided ? 'restore' : 'void'}" data-id="${esc(s.id)}">${s.voided ? '取消を戻す' : '取り消す'}</button>
    </li>`;
}

function renderHistory() {
  const all = [...state.sales].reverse();
  const list = histFilter === 'void' ? all.filter((s) => s.voided || s.restoredAt) : all;
  const shown = list.slice(0, histLimit);
  main.innerHTML = `
    <div class="chips-inline" role="group" aria-label="表示の絞り込み">
      <button type="button" class="chip ${histFilter === 'all' ? 'is-on' : ''}" data-act="hist-filter" data-f="all">すべて ${all.length}</button>
      <button type="button" class="chip ${histFilter === 'void' ? 'is-on' : ''}" data-act="hist-filter" data-f="void">取消の履歴 ${all.filter((s) => s.voided || s.restoredAt).length}</button>
    </div>
    ${shown.length ? `<ul class="sale-list">${shown.map(saleRow).join('')}</ul>` : '<section class="empty"><h2>該当する会計がありません</h2></section>'}
    ${list.length > shown.length ? `<div class="card-actions" style="margin-top:var(--s4)"><button type="button" class="btn" data-act="hist-more">さらに表示(残り ${list.length - shown.length} 件)</button></div>` : ''}`;
}

function exportSettleCsv() {
  const ag = aggregate();
  const rows = [['出品者', '商品', '単価', '個数', '金額']];
  for (const b of ag.sellers) {
    const name = sellerById.get(b.sid)?.name || b.name;
    for (const p of b.products.values()) rows.push([name, p.name, p.price, p.qty, p.amount]);
    rows.push([name, '【小計】', '', b.qty, b.amount]);
  }
  rows.push(['全体', '【総売上】', '', ag.qty, ag.total]);
  download(`精算_${stamp()}.csv`, toCsv(rows));
}

function exportDetailCsv() {
  const rows = [['日時', '担当', '出品者', '商品', '単価', '個数', '金額', '会計合計(行ごとに繰返し・合算不可)', '取消', '会計ID']];
  for (const s of state.sales) {
    for (const i of s.items) rows.push([dateTimeStr(s.ts), s.staff, i.sname, i.name, i.price, i.qty, i.price * i.qty, s.total, s.voided ? 'はい' : '', s.id]);
  }
  download(`会計明細_${stamp()}.csv`, toCsv(rows));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/* ============ 登録画面 ============ */
function renderSetup() {
  const blocks = state.sellers.map((s) => {
    const items = state.products.filter((p) => p.sellerId === s.id);
    return `
      <section class="setup-seller" style="--c:${safeColor(s.color)}">
        <div class="setup-head">
          <h3>${esc(s.name)}</h3>
          <button type="button" class="btn sm" data-act="seller-edit" data-id="${esc(s.id)}">編集</button>
          <button type="button" class="btn sm primary" data-act="product-new" data-sid="${esc(s.id)}">＋ 商品を追加</button>
        </div>
        ${items.length ? items.map((p) => `
          <div class="prod-row">
            <div class="prod-thumb">${p.photo ? `<img src="${esc(p.photo)}" alt="">` : `<span class="ph" style="--c:${safeColor(s.color)}">${esc([...p.name][0] || '?')}</span>`}</div>
            <div><div class="prod-name">${esc(p.name)}</div><div class="prod-price">${yen(p.price)}</div></div>
            <div class="prod-actions">
              <label class="toggle-wrap"><input type="checkbox" class="toggle" data-act="soldout" data-id="${esc(p.id)}" ${p.soldOut ? 'checked' : ''}>売り切れ</label>
              <button type="button" class="btn sm" data-act="product-edit" data-id="${esc(p.id)}">編集</button>
              <button type="button" class="btn sm" data-act="product-del" data-id="${esc(p.id)}">削除</button>
            </div>
          </div>`).join('') : '<p class="setup-empty">まだ商品がありません</p>'}
      </section>`;
  }).join('');
  main.innerHTML = `
    <div class="card-actions" style="margin-bottom:var(--s4)">
      <button type="button" class="btn primary" data-act="seller-new">＋ 出品者を追加</button>
    </div>
    ${blocks || '<section class="empty"><h2>最初に出品者を追加しましょう</h2><p>出品者(個人・団体)ごとに商品を登録します。売上は出品者ごとに集計されます。</p></section>'}`;
}

function openSellerForm(id) {
  const s = id ? sellerById.get(id) : null;
  const cur = s ? safeColor(s.color) : SELLER_COLORS[state.sellers.length % SELLER_COLORS.length];
  dlg.innerHTML = `
    <form class="sheet" id="sellerForm">
      <header><h2>${s ? '出品者を編集' : '出品者を追加'}</h2><button type="button" class="icon-btn" data-d="close" aria-label="閉じる">×</button></header>
      <label class="field"><span>名前</span><input class="input" name="name" required maxlength="30" autocomplete="off" value="${esc(s?.name || '')}"></label>
      <fieldset class="field"><legend>色(レジ画面で見分ける目印)</legend>
        <div class="swatches">${SELLER_COLORS.map((c) => `
          <label class="swatch" style="--c:${c}"><input type="radio" name="color" value="${c}" ${c === cur ? 'checked' : ''} aria-label="色 ${c}"><span></span></label>`).join('')}</div>
      </fieldset>
      <div class="row-end">
        ${s ? '<button type="button" class="btn" data-d="del" style="margin-right:auto">削除</button>' : ''}
        <button type="button" class="btn" data-d="close">キャンセル</button>
        <button class="btn primary">保存</button>
      </div>
    </form>`;
  dlgHandler = async (t) => {
    if (t.dataset.d === 'close') dlg.close();
    else if (t.dataset.d === 'del') {
      if (state.products.some((p) => p.sellerId === s.id)) { toast('先にこの出品者の商品を削除してください', { error: true }); return; }
      if (await confirmDialog(`「${s.name}」を削除しますか?`, '削除する', true)) { store.deleteSeller(s.id); dlg.close(); }
    }
  };
  $('#sellerForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = String(f.get('name')).trim();
    if (!name) return;
    store.saveSeller({ id: s?.id, name, color: String(f.get('color')), order: s?.order ?? Date.now() });
    dlg.close();
  });
  dlg.showModal();
  dlg.querySelector('[name=name]').focus();
}

function openProductForm(id, sid) {
  const p = id ? productById.get(id) : null;
  let photo = p?.photo || '';
  const sellerId = p?.sellerId || sid || state.sellers[0]?.id;
  dlg.innerHTML = `
    <form class="sheet" id="prodForm">
      <header><h2>${p ? '商品を編集' : '商品を追加'}</h2><button type="button" class="icon-btn" data-d="close" aria-label="閉じる">×</button></header>
      <label class="field"><span>出品者</span>
        <select class="input" name="sid">${state.sellers.map((s) => `<option value="${esc(s.id)}" ${s.id === sellerId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      </label>
      <label class="field"><span>商品名</span><input class="input" name="name" required maxlength="40" autocomplete="off" value="${esc(p?.name || '')}"></label>
      <label class="field"><span>価格(円)</span><input class="input" name="price" required inputmode="numeric" pattern="[0-9]*" maxlength="6" autocomplete="off" value="${p ? p.price : ''}"></label>
      <div class="field"><span>写真</span>
        <div class="photo-edit">
          <div class="photo-prev" id="photoPrev"></div>
          <div class="col">
            <button type="button" class="btn sm" data-d="pick">写真を撮る / 選ぶ</button>
            <button type="button" class="btn sm" data-d="nophoto">写真を外す</button>
          </div>
        </div>
        <input type="file" accept="image/*" id="photoIn" hidden>
        <p class="hint">レジ画面のタイルに大きく出ます。商品がひと目で分かる写真がおすすめです。</p>
      </div>
      <p class="err" id="prodErr" role="alert"></p>
      <div class="row-end"><button type="button" class="btn" data-d="close">キャンセル</button><button class="btn primary" id="prodSave">保存</button></div>
    </form>`;
  const paint = () => {
    const nm = dlg.querySelector('[name=name]').value;
    $('#photoPrev').innerHTML = photo
      ? `<img src="${esc(photo)}" alt="選んだ写真">`
      : `<span class="ph" style="--c:#8a8478">${esc([...nm][0] || '写')}</span>`;
  };
  paint();
  dlgHandler = (t) => {
    const a = t.dataset.d;
    if (a === 'close') dlg.close();
    else if (a === 'pick') $('#photoIn').click();
    else if (a === 'nophoto') { photo = ''; paint(); }
  };
  dlg.querySelector('[name=name]').addEventListener('input', () => { if (!photo) paint(); });
  $('#photoIn').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    $('#prodErr').textContent = '';
    try { photo = await resizePhoto(file); paint(); }
    catch (err) { $('#prodErr').textContent = '写真を読み込めませんでした: ' + err.message; }
    e.target.value = '';
  });
  $('#prodForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const name = String(f.get('name')).trim();
    const price = Number(String(f.get('price')).replace(/[,，\s]/g, ''));
    if (!name) return;
    if (!Number.isInteger(price) || price < 0 || price > 999999) { $('#prodErr').textContent = '価格は 0〜999,999 の整数で入力してください'; return; }
    if (photo.length > 600000) { $('#prodErr').textContent = '写真のサイズが大きすぎます。別の写真にしてください'; return; }
    store.saveProduct({ id: p?.id, sellerId: String(f.get('sid')), name, price, photo, soldOut: !!p?.soldOut, order: p?.order ?? Date.now() });
    dlg.close();
  });
  dlg.showModal();
  dlg.querySelector('[name=name]').focus();
}

/* ============ 管理画面 ============ */
function renderAdmin() {
  const demo = store.mode === 'demo';
  const isAdmin = role === 'admin';
  const last = lsGet('rg.lastBackup');
  main.innerHTML = `
    <section class="card"><h2>状態</h2>
      <dl class="kv">
        <dt>動作モード</dt><dd>${demo ? 'デモ(この端末の中だけに保存)' : 'Firebase 同期'}</dd>
        <dt>ログイン</dt><dd>${isAdmin ? '管理者' : 'スタッフ'}</dd>
        <dt>同期</dt><dd>${demo ? '—' : state.pending > 0 ? `未同期 ${state.pending}件` : state.offline ? 'オフライン(端末に保存済み)' : '同期済み'}</dd>
        <dt>登録数</dt><dd>出品者 ${state.sellers.length} ／ 商品 ${state.products.length}${isAdmin ? ` ／ 会計 ${state.sales.length}` : ''}</dd>
      </dl>
    </section>
    <section class="card"><h2>担当者</h2>
      <p>会計に記録される名前です(シフト別の集計に使います)。交代したら変更してください。</p>
      <div class="card-actions"><button type="button" class="btn" data-act="staff">現在: ${esc(staff || '未設定')} — 変更</button></div>
    </section>
    ${isAdmin ? `<section class="card"><h2>バックアップ</h2>
      <p>写真を含む全データをファイルに保存します。当日は 1〜2 時間おきに保存して、別の場所(LINE の自分宛てなど)に送っておくと安心です。<br>最後に保存: ${last ? esc(dateTimeStr(Number(last))) : 'まだありません'}</p>
      <div class="card-actions">
        <button type="button" class="btn primary" data-act="backup">全データを書き出す</button>
        <button type="button" class="btn" data-act="restore-pick">ファイルから読み込む</button>
        <input type="file" accept="application/json,.json" id="restoreIn" hidden>
      </div>
    </section>
    ${demo ? `<section class="card"><h2>デモデータ</h2><p>動作確認用のサンプル(出品者3人・商品8点)を入れます。</p>
      <div class="card-actions"><button type="button" class="btn" data-act="seed">サンプルを入れる</button></div></section>` : ''}
    <section class="card is-danger"><h2>テスト売上の消去</h2>
      <p>本番前のテスト会計を消すときに使います。出品者・商品は消えません。<b>全員の端末から売上が消え、元に戻せません。</b></p>
      <div class="card-actions"><button type="button" class="btn danger" data-act="clear-sales">売上を全て消去</button></div>
    </section>` : ''}
    ${demo ? '' : `<section class="card"><h2>ログアウト</h2>
      <div class="card-actions"><button type="button" class="btn" data-act="logout">ログアウト</button></div></section>`}`;
}

function backup() {
  const data = { app: 'bunkasai-register', version: 1, exportedAt: Date.now(), ...store.exportAll() };
  download(`bunkasai-backup-${stamp()}.json`, JSON.stringify(data), 'application/json');
  lsSet('rg.lastBackup', String(Date.now()));
  renderAdmin();
}

async function restoreFrom(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'bunkasai-register') throw new Error('このアプリのバックアップではありません');
    const n = [data.sellers, data.products, data.sales].map((a) => (Array.isArray(a) ? a.length : 0));
    if (await confirmDialog(`出品者 ${n[0]} ／ 商品 ${n[1]} ／ 会計 ${n[2]} を読み込みます。同じIDのデータは上書きされます。`, '読み込む')) {
      store.importAll(data);
      toast('読み込みました');
    }
  } catch (e) {
    toast('読み込めませんでした: ' + e.message, { error: true });
  }
}

function seedDemo() {
  const defs = [
    ['A さん(手作り雑貨)', ['ミニトート', 800], ['缶バッジ', 200], ['ステッカー', 150]],
    ['B さん(お菓子)', ['クッキー', 300], ['マフィン', 400]],
    ['C さん(イラスト)', ['ポストカード', 150], ['アクスタ', 1200], ['しおり', 100]],
  ];
  let t = Date.now();
  defs.forEach(([name, ...prods], i) => {
    const sid = store.saveSeller({ name, color: SELLER_COLORS[i], order: t++ });
    prods.forEach(([pn, price]) => store.saveProduct({ sellerId: sid, name: pn, price, photo: '', soldOut: false, order: t++ }));
  });
  toast('サンプルを入れました');
}

/* ============ ダイアログ・トースト ============ */
function confirmDialog(message, okLabel, danger = false) {
  return new Promise((resolve) => {
    dlg2.returnValue = '';
    dlg2.innerHTML = `<form method="dialog"><p>${esc(message)}</p>
      <div class="row-end"><button class="btn" value="cancel">キャンセル</button><button class="btn ${danger ? 'danger' : 'primary'}" value="ok">${esc(okLabel)}</button></div></form>`;
    dlg2.addEventListener('close', () => resolve(dlg2.returnValue === 'ok'), { once: true });
    dlg2.showModal();
  });
}

function typedConfirm(message, word, okLabel) {
  return new Promise((resolve) => {
    dlg2.returnValue = '';
    dlg2.innerHTML = `<form method="dialog"><p>${esc(message)}</p>
      <label class="field"><span>確認のため「${esc(word)}」と入力</span><input class="input" id="typed" autocomplete="off"></label>
      <div class="row-end"><button class="btn" value="cancel">キャンセル</button><button class="btn danger" value="ok" id="typedOk" disabled>${esc(okLabel)}</button></div></form>`;
    dlg2.querySelector('#typed').addEventListener('input', (e) => { dlg2.querySelector('#typedOk').disabled = e.target.value.trim() !== word; });
    dlg2.addEventListener('close', () => resolve(dlg2.returnValue === 'ok'), { once: true });
    dlg2.showModal();
  });
}

function askStaff() {
  dlg.innerHTML = `
    <form class="sheet" id="staffForm">
      <header><h2>担当者名</h2></header>
      <label class="field"><span>あなたの名前(会計の記録に残ります)</span>
        <input class="input" name="name" required maxlength="20" autocomplete="off" value="${esc(staff)}"></label>
      <div class="row-end"><button class="btn primary">決定</button></div>
    </form>`;
  dlgHandler = null;
  $('#staffForm').addEventListener('submit', (e) => {
    e.preventDefault();
    staff = String(new FormData(e.target).get('name')).trim() || '未設定';
    lsSet('rg.staff', staff);
    dlg.close();
    render();
  });
  dlg.showModal();
  dlg.querySelector('[name=name]').focus();
}

let toastTimer;
function toast(msg, { ms = 3000, error = false, action, onAction } = {}) {
  const el = $('#toast');
  el.className = 'toast' + (error ? ' is-error' : '');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button">${esc(action)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; onAction?.(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* ============ イベント ============ */
dlg.addEventListener('click', (e) => {
  const t = e.target.closest('[data-d]');
  if (t && dlgHandler) dlgHandler(t);
});
dlg.addEventListener('close', () => { dlgHandler = null; });

document.querySelector('.tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (!b) return;
  view = b.dataset.view;
  lsSet('rg.view', view);
  window.scrollTo(0, 0);
  render();
});
$('#staffBtn').addEventListener('click', askStaff);
$('#cartBar').addEventListener('click', (e) => { if (e.target.closest('[data-act=checkout]')) openCheckout(); });

main.addEventListener('toggle', (e) => {
  const d = e.target;
  if (d.matches?.('.seller-block')) d.open ? openSellers.add(d.dataset.sid) : openSellers.delete(d.dataset.sid);
}, true);

main.addEventListener('change', (e) => {
  if (e.target.matches('[data-act=soldout]')) {
    const p = productById.get(e.target.dataset.id);
    if (p) store.saveProduct({ ...p, soldOut: e.target.checked });
  } else if (e.target.id === 'restoreIn' && e.target.files[0]) {
    restoreFrom(e.target.files[0]);
    e.target.value = '';
  }
});

main.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t || t.matches('input')) return;
  const { act, pid, id, sid } = t.dataset;
  switch (act) {
    case 'goto': view = t.dataset.view; lsSet('rg.view', view); render(); break;
    case 'filter': filterSeller = sid; render(); break;
    case 'add': changeCart(pid, 1); refreshTile(pid); break;
    case 'minus': changeCart(pid, -1); refreshTile(pid); break;
    case 'void':
      if (await confirmDialog('この会計を取り消しますか?(集計から除外されます。後で戻せます)', '取り消す', true)) store.setVoided(id, true, staff || '管理者');
      break;
    case 'restore': store.setVoided(id, false, staff || '管理者'); break;
    case 'hist-filter': histFilter = t.dataset.f; histLimit = 50; render(); break;
    case 'hist-more': histLimit += 50; render(); break;
    case 'csv-settle': exportSettleCsv(); break;
    case 'csv-detail': exportDetailCsv(); break;
    case 'seller-new': openSellerForm(); break;
    case 'seller-edit': openSellerForm(id); break;
    case 'product-new': openProductForm(null, sid); break;
    case 'product-edit': openProductForm(id); break;
    case 'product-del': {
      const p = productById.get(id);
      if (p && await confirmDialog(`「${p.name}」を削除しますか?(過去の会計の記録は残ります)`, '削除する', true)) {
        cart.delete(id); saveCart(); store.deleteProduct(id);
      }
      break;
    }
    case 'staff': askStaff(); break;
    case 'backup': backup(); break;
    case 'restore-pick': $('#restoreIn').click(); break;
    case 'seed': seedDemo(); break;
    case 'clear-sales':
      if (await typedConfirm('全ての売上データを消去します。この操作は元に戻せません。', '削除', '売上を消去')) {
        store.clearSales();
        toast('売上を消去しました');
      }
      break;
    case 'logout':
      if (await confirmDialog('ログアウトしますか?(未同期のデータは端末に残り、次回ログイン時に同期されます)', 'ログアウト')) store.logout();
      break;
  }
});

boot();
