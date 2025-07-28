import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Index from './pages/Index';
import CreateSession from './pages/CreateSession';
import JoinSession from './pages/JoinSession';
import ExecuteSession from './pages/ExecuteSession';
import ExecuteServer from './pages/ExecuteServer';
import ExecuteClient from './pages/ExecuteClient';
import NotFound from './pages/NotFound';
import QuickSessionUpload from './pages/QuickSessionUpload';
import SessionReady from './pages/SessionReady';
import JoinSessionUpload from './pages/JoinSessionUpload';
import JoinSessionReady from './pages/JoinSessionReady';

const queryClient = new QueryClient();

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Index />} />
          <Route path="/create" element={<CreateSession />} />
          <Route path="/session/:sessionId" element={<QuickSessionUpload />} />
          <Route path="/session/:sessionId/ready" element={<SessionReady />} />
          <Route
            path="/session/:sessionId/execute"
            element={<ExecuteSession />}
          />
          <Route
            path="/execute/server/:sessionId"
            element={<ExecuteServer />}
          />
          <Route
            path="/execute/client/:sessionId"
            element={<ExecuteClient />}
          />
          <Route path="/join/:sessionId?" element={<JoinSession />} />
          <Route
            path="/join/:sessionId/upload"
            element={<JoinSessionUpload />}
          />
          <Route path="/join/:sessionId/ready" element={<JoinSessionReady />} />
          <Route path="/join/:sessionId/execute" element={<ExecuteSession />} />

          <Route path="*" element={<NotFound />} />
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
