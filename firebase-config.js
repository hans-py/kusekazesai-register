// Firebase の接続設定。null にするとデモモード(この端末の中だけに保存。他の端末とは共有されない)に戻る。
// loginEmail … スタッフ用の共有アカウントのメール。会計と商品登録ができ、売上は読めない。
// adminEmail … 管理者(運営者本人)用のアカウントのメール。売上・履歴・取消の復元・バックアップができる。
// どちらも Firebase の Authentication で作ったユーザー。合言葉(パスワード)はここに書かない。
// 実際に権限を分けているのは Firestore のルール(SETUP.md)。adminEmail はルール内のメールと同じにする。
export default {
  firebase: {
    apiKey: 'AIzaSyBFItxmbYuP5EeDMXKpB_wXTVJEjU0RdFk',
    authDomain: 'bunkasai-register.firebaseapp.com',
    projectId: 'bunkasai-register',
    storageBucket: 'bunkasai-register.firebasestorage.app',
    messagingSenderId: '245367710152',
    appId: '1:245367710152:web:f184968cbb26aea70a60fd',
  },
  loginEmail: 'register@example.com',
  adminEmail: 'admin@example.com',
};
