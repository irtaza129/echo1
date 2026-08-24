import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import GuestApp from './GuestApp.tsx';
import '../index.css';

// Entry point for the diner's phone (guest.html).
//
// Separate from src/main.tsx on purpose: that tree contains the till, the admin
// panel and the super-admin console, and none of it should ever be shipped to
// someone who scanned a QR code on a table.

createRoot(document.getElementById('guest-root')!).render(
  <StrictMode>
    <GuestApp />
  </StrictMode>,
);
