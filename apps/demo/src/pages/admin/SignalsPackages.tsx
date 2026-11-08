import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { PageContainer } from '../../components/layout/PageContainer';
import { TabBar } from '../../components/ui/TabBar';
import { CommonSignalsTab } from '../../components/platform/CommonSignalsTab';
import { StrategyPackagesTab } from '../../components/platform/StrategyPackagesTab';

type Tab = 'signals' | 'packages';

export function SignalsPackages() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'packages' ? 'packages' : 'signals';
  return (
    <PageContainer title="Signals & Strategy Packages" description="Manage the common signal webhook and the opening strategy packages subscribers can choose from.">
      <TabBar<Tab>
        label="Signals and strategy packages"
        value={tab}
        onChange={(t) => setParams({ tab: t }, { replace: true })}
        tabs={[
        { id: 'signals', label: 'Common Signals' },
        { id: 'packages', label: 'Strategy Packages' }]
        } />
      
      {tab === 'signals' ? <CommonSignalsTab /> : <StrategyPackagesTab />}
    </PageContainer>);

}