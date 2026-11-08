import { useMemo, useState } from 'react';
import { useDemo } from '../contexts/DemoContext';
import { usePlatform } from '../contexts/PlatformContext';
import { leverageChoices } from '../data/leverageChoices';
import { simNow } from '../utils/clock';
import { activationBlocker, blockFromDraft, draftFromBlock, exitDefaults, hasDraftErrors, newDraft, validateDraft } from '../utils/tokenBlocks';
import { userTimezone } from '../utils/tradingDays';
import type { TokenBlock, TokenBlockDraft } from '../types/tradeSettings';

/** Draft state and save logic for one token order block (new or existing). */
export function useTokenBlockForm(existing: TokenBlock | undefined) {
  const { currentUser, accounts } = useDemo();
  const { platform, connectionFor, saveTokenBlock } = usePlatform();
  const enabledPairs = platform.pairs.filter((p) => p.enabled);
  const activePackages = platform.packages.filter((p) => p.status === 'active');
  const firstFor = (mode: TokenBlockDraft['mode']) => accounts.find((a) => a.environment === mode)?.id ?? '';

  // Every block belongs to the signed-in investor's My Account for its mode; there is no account choice.
  const [draft, setDraft] = useState<TokenBlockDraft>(() => {
    const d = existing ? draftFromBlock(existing) : newDraft(enabledPairs[0], activePackages[0]?.id ?? '', firstFor('paper'));
    return { ...d, accountId: d.accountId && accounts.some((a) => a.id === d.accountId && a.environment === d.mode) ? d.accountId : firstFor(d.mode) };
  });
  const [exitsTouched, setExitsTouched] = useState(Boolean(existing));
  const [touched, setTouched] = useState(false);

  const locked = Boolean(existing && existing.openPositions > 0);
  const duplicate = platform.tokenBlocks.some((b) => b.id !== existing?.id && b.subscriberId === currentUser.id && b.symbol === draft.symbol && b.mode === draft.mode);
  const errors = validateDraft(draft, duplicate);
  const invalid = hasDraftErrors(errors);
  const connection = connectionFor(currentUser.id);
  const pair = platform.pairs.find((p) => p.symbol === draft.symbol);
  const pkg = platform.packages.find((p) => p.id === draft.packageId);
  const blocker = activationBlocker(draft, { pairs: platform.pairs, packages: platform.packages, connection, subscriberActive: currentUser.status === 'active', accounts });

  // Existing blocks keep their current pair/package selectable even if later disabled/inactive.
  const pairOptions = useMemo(() => {
    const list = enabledPairs.map((p) => ({ value: p.symbol, label: `${p.base}/${p.quote}` }));
    if (existing && !list.some((o) => o.value === existing.symbol)) list.unshift({ value: existing.symbol, label: `${existing.symbol} (disabled)` });
    return list;
  }, [enabledPairs, existing]);
  const packageOptions = useMemo(() => {
    const list = activePackages.map((p) => ({ value: p.id, label: p.name }));
    const cur = existing && platform.packages.find((p) => p.id === existing.packageId);
    if (existing && !list.some((o) => o.value === existing.packageId)) list.unshift({ value: existing.packageId, label: `${cur?.name ?? 'Removed package'} (inactive)` });
    return list;
  }, [activePackages, existing, platform.packages]);

  const update = (patch: Partial<TokenBlockDraft>) =>
  setDraft((d) => {
    const next = { ...d, ...patch };
    // Changing mode never keeps an account of the other mode.
    if (patch.mode && patch.mode !== d.mode) {
      const stillValid = accounts.some((a) => a.id === next.accountId && a.environment === patch.mode);
      if (!stillValid) next.accountId = firstFor(patch.mode);
    }
    return next;
  });
  const updateExits = (patch: Partial<TokenBlockDraft>) => {
    setExitsTouched(true);
    update(patch);
  };

  /** Changing pair revalidates leverage; new untouched drafts re-prefill exits from the new pair's defaults. */
  const changePair = (symbol: string) => {
    const next = platform.pairs.find((p) => p.symbol === symbol);
    const choices = leverageChoices(symbol);
    setDraft((d) => ({
      ...d,
      symbol,
      leverage: d.leverage !== null && choices.includes(d.leverage) ? d.leverage : null,
      ...(exitsTouched ? {} : exitDefaults(next))
    }));
  };

  const restoreDefaults = () => {
    setExitsTouched(true);
    update(exitDefaults(pair));
  };

  /** Returns the saved block, or null when validation fails. Never opens a position. */
  const save = (activate: boolean): TokenBlock | null => {
    setTouched(true);
    if (invalid || activate && blocker) return null;
    const at = simNow();
    const block = blockFromDraft(
      draft,
      {
        id: existing?.id ?? `tb-${currentUser.id}-${at.toString(36)}`,
        subscriberId: currentUser.id,
        // Saving never silently pauses; a block that loses a requirement shows Blocked instead.
        active: activate ? true : existing?.active ?? false,
        openPositions: existing?.openPositions ?? 0,
        version: existing?.version ?? 1,
        createdAt: existing?.createdAt ?? at
      },
      at
    );
    saveTokenBlock(block);
    return block;
  };

  const timezone = userTimezone(currentUser);

  return { draft, timezone, update, updateExits, changePair, restoreDefaults, errors, touched, invalid, blocker, locked, pair, pkg, connection, pairOptions, packageOptions, save };
}