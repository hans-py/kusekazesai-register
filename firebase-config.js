// Firebase の接続設定。null にするとデモモード(この端末の中だけに保存。他の端末とは共有されない)に戻る。
// loginEmail は、Firebase の Authentication で作った共有アカウントのメール(合言葉はここに書かない)。
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
};
