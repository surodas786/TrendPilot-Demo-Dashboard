import React from 'react';
import { CalendarXIcon } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { REPORTING_DATE } from '../../data/mockData';
import { Card } from '../ui/Card';

interface NoRecordsNoticeProps {
  date: string;
  onBackToToday: () => void;
}

export function NoRecordsNotice({ date, onBackToToday }: NoRecordsNoticeProps) {
  return (
    <Card className="flex flex-col items-center px-6 py-16 text-center">
      <CalendarXIcon className="h-6 w-6 text-subtle" aria-hidden />
      <h2 className="mt-3 text-base font-semibold text-ink">
        No simulated records for {format(parseISO(date), 'EEE, MMM d, yyyy')}
      </h2>
      <p className="mt-1 max-w-md text-sm text-muted">
        This demo contains one simulated trading day ({format(parseISO(REPORTING_DATE), 'MMM d, yyyy')}). Historical daily
        reports arrive with Trade History in the next step.
      </p>
      <button
        type="button"
        onClick={onBackToToday}
        className="mt-5 h-9 rounded-lg bg-accent px-4 text-sm font-semibold text-accent-ink transition-colors duration-150 hover:bg-accent/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60">
        
        Back to today
      </button>
    </Card>);

}