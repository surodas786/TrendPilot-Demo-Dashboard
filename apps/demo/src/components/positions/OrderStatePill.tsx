import React from "react";
import { BanIcon, CheckCircle2Icon, CircleDashedIcon, ClockIcon, HelpCircleIcon, SendIcon, SplitIcon, XCircleIcon, BoxIcon } from "lucide-react";
import { STATE_LABELS } from "../../utils/orders";
import { StatusPill, PillTone } from "../ui/StatusPill";
import { OrderRecord, OrderState } from "../../types/execution";
const META: Record<OrderState, {
  tone: PillTone;
  icon: BoxIcon;
}> = {
  'pending-submission': {
    tone: 'warn',
    icon: ClockIcon
  },
  submitted: {
    tone: 'accent',
    icon: SendIcon
  },
  'partially-filled': {
    tone: 'warn',
    icon: SplitIcon
  },
  filled: {
    tone: 'gain',
    icon: CheckCircle2Icon
  },
  rejected: {
    tone: 'loss',
    icon: XCircleIcon
  },
  cancelled: {
    tone: 'neutral',
    icon: BanIcon
  },
  expired: {
    tone: 'neutral',
    icon: CircleDashedIcon
  },
  unknown: {
    tone: 'loss',
    icon: HelpCircleIcon
  }
};

/** Execution state, with the conditional trigger state shown separately where it applies. */
export function OrderStatePill({
  order


}: {order: OrderRecord;}) {
  const m = META[order.state];
  const showTrigger = order.triggerState && (order.state === 'submitted' || order.state === 'pending-submission' || order.state === 'partially-filled');
  return <span className="flex flex-wrap items-center gap-1">
      <StatusPill tone={m.tone} icon={m.icon}>
        {STATE_LABELS[order.state]}
      </StatusPill>
      {showTrigger && <StatusPill tone="neutral">{order.triggerState === 'triggered' ? 'Triggered' : 'Untriggered'}</StatusPill>}
    </span>;
}