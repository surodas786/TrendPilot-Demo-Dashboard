// The position-mode wording on Live Trading and My Account: Hedge is a supported mode, not a blocker.
import { describe, expect, it } from 'vitest';
import { positionModeLabel } from '@/components/live/connectionLabels';

describe('positionModeLabel', () => {
  it('One-way and Hedge are both shown as verified modes; only an unchecked mode is neutral', () => {
    expect(positionModeLabel('ONE_WAY')).toEqual({ text: 'One-way', tone: 'gain' });
    expect(positionModeLabel('HEDGE')).toEqual({ text: 'Hedge', tone: 'gain' });
    expect(positionModeLabel(null)).toEqual({ text: 'Not checked yet', tone: 'neutral' });
    expect(positionModeLabel('HEDGE').text).not.toMatch(/One-way/);
  });
});
