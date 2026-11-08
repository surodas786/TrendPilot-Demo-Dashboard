import React from "react";
import { Loader2Icon, BoxIcon } from "lucide-react";
import { cn } from "../../utils/cn";
type Variant = 'primary' | 'secondary' | 'danger' | 'warn' | 'ghost';
interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md';
  icon?: BoxIcon;
  loading?: boolean;
}
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:bg-accent/90 focus-visible:ring-accent/60',
  secondary: 'border border-line bg-inset text-ink hover:border-line-strong focus-visible:ring-accent/60',
  danger: 'border border-loss/50 bg-loss/10 text-loss hover:bg-loss/20 focus-visible:ring-loss/60',
  warn: 'border border-warn/45 bg-warn/10 text-warn hover:bg-warn/20 focus-visible:ring-warn/60',
  ghost: 'text-muted hover:bg-inset hover:text-ink focus-visible:ring-accent/60'
};
export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  loading = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return <button type={type} disabled={disabled || loading} className={cn('inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50', size === 'md' ? 'h-9 px-4 text-sm' : 'h-8 px-3 text-xs', variants[variant], className)} {...rest}>
      {loading ? <Loader2Icon className={cn('animate-spin', size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5')} aria-hidden /> : Icon && <Icon className={size === 'md' ? 'h-4 w-4' : 'h-3.5 w-3.5'} aria-hidden />}
      {children}
    </button>;
}