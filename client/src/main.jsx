import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import PasswordGate from './components/PasswordGate.jsx';
import { toast } from './components/Toaster.jsx';
import './index.css';

// Every action reports its outcome as a toast: `meta.success` (string or fn of the result) on success,
// and the API error message on failure (forms still show field errors inline).
const errorText = (error) => (error?.fields ? Object.values(error.fields)[0] : error?.message) || 'Something went wrong';
const mutationCache = new MutationCache({
  onSuccess: (data, variables, _context, mutation) => {
    const { success } = mutation.meta ?? {};
    toast(typeof success === 'function' ? success(data, variables) : success);
  },
  onError: (error, _variables, _context, mutation) => {
    if (mutation.meta?.errorToast !== false) toast(errorText(error), 'error');
  },
});

const queryClient = new QueryClient({
  mutationCache,
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <PasswordGate>
          <App />
        </PasswordGate>
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
