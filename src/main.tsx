import { useState, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import OrdersDashboard from './OrdersDashboard.tsx';
import './index.css';

function Root() {
  const [screen, setScreen] = useState<'kiosk' | 'dashboard'>('kiosk');
  return screen === 'kiosk'
    ? <App onNavigateToDashboard={() => setScreen('dashboard')} />
    : <OrdersDashboard onBack={() => setScreen('kiosk')} />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
