import React from 'react';
import { Navigate } from 'react-router-dom';
import { useDemo } from '../../contexts/DemoContext';

/** Old module URLs (e.g. links inside the Dashboard) forward to the consolidated page for the current role. */
export function LegacyRedirect({ trader, admin }: {trader: string;admin: string;}) {
  const { state } = useDemo();
  return <Navigate to={state.role === 'admin' ? admin : trader} replace />;
}