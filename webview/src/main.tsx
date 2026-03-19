import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './styles.css';

type ErrorState = Readonly<{
  title: string;
  details: string;
}>;

const rootElement = document.getElementById('app');

if (!rootElement) {
  throw new Error('Missing #app root element');
}

const mountElement = rootElement;

function renderFatalError(error: ErrorState): void {
  mountElement.innerHTML = `
    <div style="min-height:100vh;padding:24px;background:hsl(218 52% 8%);color:hsl(210 40% 96%);font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
      <div style="max-width:920px;margin:0 auto;border:1px solid hsl(215 27% 24%);background:hsl(221 39% 13%);border-radius:16px;padding:20px;">
        <div style="font-size:12px;letter-spacing:.18em;text-transform:uppercase;color:hsl(215 20% 67%);margin-bottom:12px;">Galaxy Code Webview Error</div>
        <h1 style="font-size:24px;line-height:1.3;margin:0 0 12px;">${error.title}</h1>
        <pre style="white-space:pre-wrap;word-break:break-word;margin:0;font-size:13px;line-height:1.7;color:hsl(210 40% 96%);">${error.details}</pre>
      </div>
    </div>
  `;
}

window.addEventListener('error', (event) => {
  renderFatalError({
    title: 'Uncaught runtime error',
    details: event.error instanceof Error ? event.error.stack ?? event.error.message : String(event.message),
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  renderFatalError({
    title: 'Unhandled promise rejection',
    details: reason instanceof Error ? reason.stack ?? reason.message : String(reason),
  });
});

try {
  ReactDOM.createRoot(mountElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
} catch (error) {
  renderFatalError({
    title: 'Failed to render Galaxy Code',
    details: error instanceof Error ? error.stack ?? error.message : String(error),
  });
}
