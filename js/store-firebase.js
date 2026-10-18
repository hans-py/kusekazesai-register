// Firebase(Firestore + Auth)版のデータ層。
// ・Firestore のオフライン永続キャッシュを使うので、電波が切れても入力は止まらず、復帰後に自動で同期される。
// ・書き込みは await しない(オフライン中は完了待ちが終わらないため)。ローカルには即反映される。
// ・合言葉(PIN)は、Firebase Auth の共有アカウントのパスワードとして使う。
import { cleanImport } from './util.js';

const SDK = 'https://www.gstatic.com/firebasejs/10.14.1/';
const COLLECTIONS = ['sellers', 'products', 'sales'];

export async function create(cfg) {
  const [appM, authM, fsM] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-auth.js'),
    import(SDK + 'firebase-firestore.js'),
  ]);

  const app = appM.initializeApp(cfg.firebase);
  const auth = authM.getAuth(app);
  let db;
  try {
    db = fsM.initializeFirestore(app, {
      localCache: fsM.persistentLocalCache({ tabManager: fsM.persistentMultipleTabManager() }),
    });
  } catch (e) {
    console.warn('永続キャッシュを使えないためメモリキャッシュで動作します', e);
    db = fsM.getFirestore(app);
  }

  const st = { sellers: [], products: [], sales: [] };
  const pend = { sellers: 0, products: 0, sales: 0 };
  const cached = { sellers: true, products: true, sales: true };
  const changeFns = new Set();
  const errorFns = new Set();
  const authFns = new Set();
  let unsubs = [];
  let ready = false;

  const fail = (msg) => errorFns.forEach((f) => f(msg));
  const writeFail = (e) => {
    console.error(e);
    fail(
      e?.code === 'permission-denied'
        ? '書き込みが拒否されました。ログインし直してください'
        : '保存に失敗しました: ' + (e?.message || e)
    );
  };
  const clean = (o) => JSON.parse(JSON.stringify(o)); // undefined を落とす(Firestore は undefined を拒否する)

  const emit = () => {
    const snap = {
      sellers: [...st.sellers].sort((a, b) => a.order - b.order),
      products: [...st.products].sort((a, b) => a.order - b.order),
      sales: [...st.sales].sort((a, b) => a.ts - b.ts),
      pending: pend.sellers + pend.products + pend.sales,
      offline: cached.sales && cached.products && cached.sellers,
      ready,
    };
    changeFns.forEach((f) => f(snap));
  };

  // 購読がエラーで止まったまま(ルール反映の遅れ・一時的な通信エラーなど)にならないよう、間隔を空けて張り直す。
  let gen = 0;
  function listenOne(name, myGen, attempt = 0) {
    const unsub = fsM.onSnapshot(
      fsM.collection(db, name),
      { includeMetadataChanges: true },
      (snap) => {
        attempt = 0;
        st[name] = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        pend[name] = snap.docs.filter((d) => d.metadata.hasPendingWrites).length;
        cached[name] = snap.metadata.fromCache;
        ready = true;
        emit();
      },
      (err) => {
        console.error(err);
        fail(err.code === 'permission-denied' ? 'データを読む権限がありません。数秒後に再接続します(続く場合は Firestore のルールを確認してください)' : '読み込みに失敗しました。再接続します: ' + err.message);
        unsub();
        if (myGen === gen) setTimeout(() => myGen === gen && listenOne(name, myGen, attempt + 1), Math.min(30000, 3000 * (attempt + 1)));
      }
    );
    unsubs.push(unsub);
  }
  function listen() {
    stopListening();
    const myGen = gen;
    COLLECTIONS.forEach((name) => listenOne(name, myGen));
  }
  function stopListening() {
    gen += 1; // 保留中の再接続を無効にする
    unsubs.forEach((u) => u());
    unsubs = [];
    st.sellers = st.products = st.sales = [];
    ready = false;
  }

  const refOf = (name, id) => (id ? fsM.doc(db, name, id) : fsM.doc(fsM.collection(db, name)));
  const put = (name, obj) => {
    const { id, ...rest } = obj;
    const ref = refOf(name, id);
    fsM.setDoc(ref, clean(rest), { merge: true }).catch(writeFail);
    return ref.id;
  };
  const del = (name, id) => fsM.deleteDoc(fsM.doc(db, name, id)).catch(writeFail);

  // 500 件ずつのバッチで書く(Firestore の上限)。
  function batched(items, apply) {
    for (let i = 0; i < items.length; i += 400) {
      const b = fsM.writeBatch(db);
      items.slice(i, i + 400).forEach((x) => apply(b, x));
      b.commit().catch(writeFail);
    }
  }

  return {
    mode: 'firebase',
    onAuth(fn) {
      authFns.add(fn);
      authM.onAuthStateChanged(auth, (user) => {
        if (user) listen();
        else stopListening();
        authFns.forEach((f) => f(!!user));
      });
    },
    async login(pin) {
      await authM.signInWithEmailAndPassword(auth, cfg.loginEmail, pin);
    },
    async logout() {
      await authM.signOut(auth);
    },
    onChange(fn) {
      changeFns.add(fn);
    },
    onError(fn) {
      errorFns.add(fn);
    },
    saveSeller: (o) => put('sellers', o),
    deleteSeller: (id) => del('sellers', id),
    saveProduct: (o) => put('products', o),
    deleteProduct: (id) => del('products', id),
    addSale: (sale) => put('sales', sale),
    setVoided(id, voided) {
      fsM.updateDoc(fsM.doc(db, 'sales', id), { voided }).catch(writeFail);
    },
    clearSales() {
      batched(st.sales, (b, s) => b.delete(fsM.doc(db, 'sales', s.id)));
    },
    exportAll() {
      return clean({ sellers: st.sellers, products: st.products, sales: st.sales });
    },
    importAll(raw) {
      const c = cleanImport(raw);
      const jobs = [
        ...c.sellers.map((o) => ['sellers', o]),
        ...c.products.map((o) => ['products', o]),
        ...c.sales.map((o) => ['sales', o]),
      ];
      batched(jobs, (b, [name, o]) => {
        const { id, ...rest } = o;
        b.set(fsM.doc(db, name, id), clean(rest), { merge: true });
      });
    },
  };
}
