import React from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { MotionConfig } from 'framer-motion';
import { Toaster } from 'sonner';
import { DemoProvider } from './contexts/DemoContext';
import { PlatformProvider } from './contexts/PlatformContext';
import { AppShell } from './components/layout/AppShell';
import { RoleGate } from './components/layout/RoleGate';
import { Dashboard } from './pages/Dashboard';
import { ExchangeConnections } from './pages/ExchangeConnections';
import { TradeSettings } from './pages/subscriber/TradeSettings';
import { Holdings } from './pages/subscriber/Holdings';
import { Users } from './pages/admin/Users';
import { SignalsPackages } from './pages/admin/SignalsPackages';
import { TradingPairs } from './pages/admin/TradingPairs';
import { LegacyRedirect } from './components/layout/LegacyRedirect';
import { TradeHistory } from './pages/TradeHistory';
import { FundsFunding } from './pages/FundsFunding';
import { Reports } from './pages/Reports';
import { Signals } from './pages/Signals';
import { Settings } from './pages/Settings';
import { Logs } from './pages/Logs';
import { DemoCenter } from './pages/DemoCenter';
import { AdminWorkspace } from './pages/AdminWorkspace';
import { AccountSetup } from './pages/account/AccountSetup';
import { PasswordReset } from './pages/account/PasswordReset';

export function App() {
  return (
    <DemoProvider>
      <PlatformProvider>
      <MotionConfig reducedMotion="user">
        <BrowserRouter>
          <Routes>
            {/* Simulated email-link screens (standalone, outside the app shell). */}
            <Route path="account/setup/:linkId" element={<AccountSetup />} />
            <Route path="account/reset/:linkId" element={<PasswordReset />} />
            <Route element={<AppShell />}>
              <Route index element={<Dashboard />} />

              {/* Subscriber */}
              <Route path="exchange-connections" element={<RoleGate role="trader"><ExchangeConnections /></RoleGate>} />
              <Route path="trade-settings" element={<RoleGate role="trader"><TradeSettings /></RoleGate>} />
              <Route path="holdings" element={<RoleGate role="trader"><Holdings /></RoleGate>} />

              {/* Administrator */}
              <Route path="admin/users" element={<RoleGate role="admin"><Users /></RoleGate>} />
              <Route path="admin/signals" element={<RoleGate role="admin"><SignalsPackages /></RoleGate>} />
              <Route path="admin/pairs" element={<RoleGate role="admin"><TradingPairs /></RoleGate>} />

              {/* Restored original menus */}
              <Route path="trade-history" element={<RoleGate role="trader"><TradeHistory /></RoleGate>} />
              <Route path="funds-funding" element={<RoleGate role="trader"><FundsFunding /></RoleGate>} />
              <Route path="reports" element={<RoleGate role="trader"><Reports /></RoleGate>} />
              <Route path="signals" element={<RoleGate role="trader"><Signals /></RoleGate>} />
              <Route path="settings" element={<RoleGate role="trader"><Settings /></RoleGate>} />
              <Route path="logs" element={<Logs />} />
              <Route path="demo-center" element={<DemoCenter />} />
              <Route path="admin" element={<RoleGate role="admin"><AdminWorkspace /></RoleGate>} />

              {/* Consolidated module URLs forward to their new pages. */}
              <Route path="strategies" element={<LegacyRedirect trader="/trade-settings" admin="/admin/signals?tab=packages" />} />
              <Route path="trading-risk" element={<LegacyRedirect trader="/trade-settings" admin="/admin/pairs" />} />
              <Route path="exit-settings" element={<LegacyRedirect trader="/trade-settings" admin="/admin/pairs" />} />
              <Route path="positions-orders" element={<LegacyRedirect trader="/holdings" admin="/" />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Routes>
        </BrowserRouter>
        <Toaster
            theme="dark"
            position="bottom-right"
            toastOptions={{
              style: { background: '#16213A', border: '1px solid #2A3A5C', color: '#E2E8F0' }
            }} />
          
      </MotionConfig>
      </PlatformProvider>
    </DemoProvider>);

}