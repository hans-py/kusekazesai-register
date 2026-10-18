// データ層の入口。firebase-config.js に設定があれば Firebase、なければ端末内だけのデモ用ストアを返す。
// どちらも同じ形のオブジェクトを返す:
//   mode            'firebase' | 'demo'
//   onAuth(fn)      fn(ログイン済みか)  ※状態が変わるたびに呼ばれる
//   login(pin) / logout()
//   onChange(fn)    fn({sellers, products, sales, pending, offline, ready})
//   onError(fn)     fn(メッセージ)
//   saveSeller / deleteSeller / saveProduct / deleteProduct
//   addSale(sale) → id / setVoided(id, bool) / clearSales()
//   exportAll() / importAll(data)

export async function createStore() {
  const { default: cfg } = await import('../firebase-config.js');
  if (cfg?.firebase?.apiKey && cfg?.loginEmail) {
    return (await import('./store-firebase.js')).create(cfg);
  }
  return (await import('./store-local.js')).create();
}
