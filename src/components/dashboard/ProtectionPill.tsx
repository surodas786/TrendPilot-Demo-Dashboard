import React from "react";
import { CircleDashedIcon, LockIcon, ShieldAlertIcon, ShieldCheckIcon, ShieldOffIcon, ShieldQuestionIcon, BoxIcon } from "lucide-react";
import { StatusPill, PillTone } from "../ui/StatusPill";
import { ManagedProtection } from "../../types/execution";
import { PROTECTION_LABELS } from "../../utils/protection";
const META: Record<ManagedProtection, {
  tone: PillTone;
  icon: BoxIcon;
}> = {
  confirmed: {
    tone: 'accent',
    icon: ShieldCheckIcon
  },
  pending: {
    tone: 'warn',
    icon: ShieldQuestionIcon
  },
  failed: {
    tone: 'loss',
    icon: ShieldOffIcon
  },
  unknown: {
    tone: 'loss',
    icon: ShieldAlertIcon
  },
  closed: {
    tone: 'neutral',
    icon: LockIcon
  },
  unmanaged: {
    tone: 'neutral',
    icon: CircleDashedIcon
  }
};
export function ProtectionPill({
  status,
  title




}: {status: ManagedProtection;label?: string;title?: string;}) {
  const meta = META[status];
  return <span title={title}>
      <StatusPill tone={meta.tone} icon={meta.icon}>
        {PROTECTION_LABELS[status]}
      </StatusPill>
    </span>;
}