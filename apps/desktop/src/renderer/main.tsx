import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { MenuBarApp } from './components/MenuBarApp';
import { FleetProvider } from './state/FleetContext';
import './styles.css';

const menuBarView = new URLSearchParams(window.location.search).get('view') === 'menubar';
document.documentElement.dataset.view = menuBarView ? 'menubar' : 'app';

createRoot(document.getElementById('root')!).render(
  <StrictMode>{menuBarView ? <MenuBarApp /> : <FleetProvider><App /></FleetProvider>}</StrictMode>
);

if (!menuBarView && !window.fleetDesktop && 'serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/service-worker.js'); });
}
