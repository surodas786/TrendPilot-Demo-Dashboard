import React from "react";
import { CheckIcon, ChevronDownIcon, BoxIcon } from "lucide-react";
import { Popover } from "./Popover";
import { cn } from "../../utils/cn";
export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  tag?: string;
}
interface SelectMenuProps {
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  icon?: BoxIcon;
  align?: 'left' | 'right';
  heading?: string;
  triggerClassName?: string;
}
export function SelectMenu({
  label,
  value,
  options,
  onChange,
  icon: Icon,
  align = 'right',
  heading,
  triggerClassName
}: SelectMenuProps) {
  const selected = options.find((o) => o.value === value) ?? options[0];
  return <Popover triggerLabel={`${label}: ${selected.label}`} align={align} panelClassName="w-72" triggerClassName={cn('flex h-9 items-center gap-2 whitespace-nowrap rounded-lg border border-line bg-inset px-3 text-sm text-ink transition-colors duration-150 hover:border-line-strong', triggerClassName)} triggerContent={<>
          {Icon && <Icon className="h-4 w-4 shrink-0 text-subtle" aria-hidden />}
          <span className="truncate font-medium">{selected.label}</span>
          <ChevronDownIcon className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
        </>}>
      {(close) => <div role="menu" aria-label={label}>
          {heading && <p className="px-2.5 pb-1.5 pt-1 text-xs text-subtle">{heading}</p>}
          {options.map((option) => {
        const isSelected = option.value === value;
        return <button key={option.value} type="button" role="menuitemradio" aria-checked={isSelected} disabled={option.disabled} onClick={() => {
          onChange(option.value);
          close();
        }} className={cn('flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors duration-150', option.disabled ? 'cursor-not-allowed opacity-60' : 'hover:bg-inset')}>
                <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                  {isSelected && <CheckIcon className="h-4 w-4 text-accent" aria-hidden />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className={cn('text-sm', isSelected ? 'font-semibold text-ink' : 'text-ink')}>
                      {option.label}
                    </span>
                    {option.tag && <span className="rounded-full border border-line px-2 py-0.5 text-[11px] text-subtle">
                        {option.tag}
                      </span>}
                  </span>
                  {option.description && <span className="mt-0.5 block text-xs text-subtle">{option.description}</span>}
                </span>
              </button>;
      })}
        </div>}
    </Popover>;
}