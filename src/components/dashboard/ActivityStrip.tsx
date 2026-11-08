import React from "react";
import { CheckCircle2Icon, CircleSlashIcon, LogInIcon, LogOutIcon, ShieldAlertIcon, ShieldCheckIcon, TargetIcon, TrendingUpIcon, XCircleIcon, BoxIcon } from "lucide-react";
import { useDemo } from "../../contexts/DemoContext";
import { cn } from "../../utils/cn";
import { Card } from "../ui/Card";
import { ActivityEvent, ActivityKind } from "../../types/trading";
export const activityIcon: Record<ActivityKind, {
  icon: BoxIcon;
  tone: string;
}> = {
  entry: {
    icon: LogInIcon,
    tone: 'text-accent'
  },
  protection: {
    icon: ShieldCheckIcon,
    tone: 'text-accent'
  },
  'take-profit': {
    icon: TargetIcon,
    tone: 'text-gain'
  },
  exit: {
    icon: LogOutIcon,
    tone: 'text-muted'
  },
  'stop-loss': {
    icon: ShieldAlertIcon,
    tone: 'text-loss'
  },
  skip: {
    icon: CircleSlashIcon,
    tone: 'text-warn'
  },
  reject: {
    icon: XCircleIcon,
    tone: 'text-loss'
  },
  trailing: {
    icon: TrendingUpIcon,
    tone: 'text-accent'
  },
  close: {
    icon: CheckCircle2Icon,
    tone: 'text-gain'
  }
};
export function ActivityStrip({
  events


}: {events: ActivityEvent[];}) {
  const {
    accountName
  } = useDemo();
  return <Card className="flex flex-col lg:flex-row lg:items-stretch" labelledBy="activity-heading">
      <div className="flex items-center justify-between border-b border-line px-4 py-3 lg:w-40 lg:shrink-0 lg:flex-col lg:items-start lg:justify-center lg:border-b-0 lg:border-r">
        <h2 id="activity-heading" className="text-sm font-semibold text-ink">
          Recent activity
        </h2>
        <p className="text-xs text-subtle">Simulated events</p>
      </div>
      {events.length === 0 ? <p className="px-4 py-4 text-sm text-muted">No activity for this account and filter today.</p> : <ol className="scrollbar-thin flex flex-col divide-y divide-line lg:flex-row lg:divide-x lg:divide-y-0 lg:overflow-x-auto">
          {events.map((event) => {
        const {
          icon: Icon,
          tone
        } = activityIcon[event.kind];
        return <li key={event.id} className="flex gap-2.5 px-4 py-3 lg:min-w-[250px] lg:max-w-[290px]">
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', tone)} aria-hidden />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-ink">
                    {event.title} <span className="text-muted">· {event.pair}</span>
                  </p>
                  <p className="mt-0.5 truncate text-xs text-subtle">{event.detail}</p>
                  <p className="mt-0.5 text-xs tabular-nums text-subtle">
                    {accountName(event.accountId)} · {event.time}
                  </p>
                </div>
              </li>;
      })}
        </ol>}
    </Card>;
}