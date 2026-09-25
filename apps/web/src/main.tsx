import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { createQueryClient } from './data/query-client';
import { App } from './routes';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Root element #root was not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <App queryClient={createQueryClient()} />
  </StrictMode>,
);
