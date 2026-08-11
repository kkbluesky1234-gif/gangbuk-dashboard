// Firebase 연결 설정 (gangbuk-dashboard 프로젝트)
const firebaseConfig = {
  apiKey: "AIzaSyAALBGvYfAZTDsvsbuuTGY4cuDmvrJKYmI",
  authDomain: "gangbuk-dashboard.firebaseapp.com",
  projectId: "gangbuk-dashboard",
  storageBucket: "gangbuk-dashboard.firebasestorage.app",
  messagingSenderId: "546052130153",
  appId: "1:546052130153:web:c4e602ab009b05ca3829f8"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();
const firestoreSitesDoc = db.collection("dashboard").doc("sites_v1");
