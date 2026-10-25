import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY || 'AIzaSyD6mJo0Mt9usZV8P4ME6NUjKrNsK7BHIe0',
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN || 'rocket-league-turnuva.firebaseapp.com',
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID || 'rocket-league-turnuva',
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET || 'rocket-league-turnuva.firebasestorage.app',
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID || '683231588937',
  appId: import.meta.env.VITE_FIREBASE_APP_ID || '1:683231588937:web:eac3eb88f5131344a1c598',
};

const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = null;
