import React from 'react';
import { Building2Icon } from 'lucide-react';
import { exchanges } from '../../data/mockData';
import { useDemo } from '../../contexts/DemoContext';
import { SelectMenu } from '../ui/SelectMenu';

export function ExchangeSelect({ align = 'right' }: {align?: 'left' | 'right';}) {
  const { state, setExchange } = useDemo();
  return (
    <SelectMenu
      label="Exchange"
      heading="Exchange"
      icon={Building2Icon}
      align={align}
      value={state.exchangeId}
      onChange={setExchange}
      options={exchanges.map((e) => ({
        value: e.id,
        label: e.name,
        disabled: !e.enabled,
        tag: e.enabled ? undefined : 'Coming soon',
        description: e.enabled ? 'USDT perpetual futures · paper mode' : undefined
      }))} />);


}