import React from 'react';
import { cn } from '../../utils/cn';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  as?: 'section' | 'div' | 'aside';
  labelledBy?: string;
}

export function Card({ children, className, as: Tag = 'section', labelledBy }: CardProps) {
  return (
    <Tag aria-labelledby={labelledBy} className={cn('rounded-xl border border-line bg-surface', className)}>
      {children}
    </Tag>);

}