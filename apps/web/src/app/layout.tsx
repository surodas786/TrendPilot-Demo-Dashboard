import type { Metadata } from 'next';
import { Toaster } from 'sonner';
import './globals.css';

export const metadata: Metadata = {
  title: 'TrendPilot',
  description: 'TrendPilot automated trading — investor settings'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Toaster
          theme="dark"
          position="bottom-right"
          toastOptions={{ style: { background: '#16213A', border: '1px solid #2A3A5C', color: '#E2E8F0' } }}
        />
      </body>
    </html>
  );
}
