// Lighter Step 4A: the pinned lighter-go v1.0.12 WASM signer, run in Node. Offline only; the keys
// below are THROWAWAY test keys derived from the public test seeds "ab"×32 and "cd"×32 with the same
// module (never real credentials, never registered anywhere).
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { buildOpenWithStop, buildReduceOnlyClose, LIGHTER_ENVIRONMENTS } from '@trendpilot/domain';
import { LIGHTER_SIGNER_ARTIFACT, LighterSignerError, lighterSignerDir, lighterSignerLoads, loadLighterSigner, wasmLighterSigner } from '../src/live/lighterWasmSigner';
import { LighterSignerUnavailable } from '../src/live/lighterPrivate';

const KEY_A = { prv: '213f363b0f4e5391fa190f50cfb616abaac317675b928f949c4c215a5718bb48c2d34d23a4f06571', pk: 'eb6764ee89c7be4545860c16cc8c47b7a55642cfa6817b7b8b99486824fc9ba13130f4147e5be3a4' };
const KEY_B = { prv: '36b47d9563c941f59823c9be0432d158021f10c719771e1edfa3df20f55c47b0dcaec80e327e3837', pk: '5a22e05737046117a760f8ba03cfb9102a22934712c58b7c82f32df5b68a7a5536cd4402e90c210f' };
const chainId = LIGHTER_ENVIRONMENTS.MAINNET.chainId;
const A = wasmLighterSigner({ accountIndex: 4242, apiKeyIndex: 5, chainId, apiPrivateKey: KEY_A.prv });
const B = wasmLighterSigner({ accountIndex: 5151, apiKeyIndex: 6, chainId, apiPrivateKey: KEY_B.prv });
const RULES = { marketId: 92, sizeDecimals: 4, priceDecimals: 2, minBaseAmount: '0.0015', minQuoteAmount: '10', maxQuoteAmount: null };
const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('pinned artifact', () => {
  it('the vendored files are exactly the verified release files', () => {
    const sha = (f: string) => createHash('sha256').update(readFileSync(path.join(lighterSignerDir(), f))).digest('hex');
    expect(sha(LIGHTER_SIGNER_ARTIFACT.wasm.file)).toBe('95c9dd38373405691498c52c0feb72338e6bb00e90362227efe59fb12523c5ae');
    expect(sha(LIGHTER_SIGNER_ARTIFACT.shim.file)).toBe('0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14');
  });

  it('finds the vendored files when the process starts outside the checkout (Step 4B packaging fix)', () => {
    const inside = lighterSignerDir();
    const before = process.cwd();
    const outside = mkdtempSync(path.join(tmpdir(), 'lighter-cwd-'));
    tmp.push(outside);
    try {
      process.chdir(outside);
      expect(path.resolve(lighterSignerDir())).toBe(path.resolve(inside));
    } finally {
      process.chdir(before);
    }
  });

  it('refuses an altered or missing artifact before instantiating anything', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'lighter-signer-'));
    tmp.push(dir);
    const before = lighterSignerLoads();
    await expect(loadLighterSigner(dir)).rejects.toBeInstanceOf(LighterSignerUnavailable);
    copyFileSync(path.join(lighterSignerDir(), LIGHTER_SIGNER_ARTIFACT.shim.file), path.join(dir, LIGHTER_SIGNER_ARTIFACT.shim.file));
    const wasm = readFileSync(path.join(lighterSignerDir(), LIGHTER_SIGNER_ARTIFACT.wasm.file));
    wasm[wasm.length - 1] = (wasm[wasm.length - 1] ?? 0) ^ 0xff;
    writeFileSync(path.join(dir, LIGHTER_SIGNER_ARTIFACT.wasm.file), wasm);
    await expect(loadLighterSigner(dir)).rejects.toThrow(/does not match its pinned SHA-256/);
    const x = wasmLighterSigner({ accountIndex: 1, apiKeyIndex: 5, chainId, apiPrivateKey: KEY_A.prv }, { dir });
    await expect(x.signCreateOrder(buildReduceOnlyClose({ positionSide: 'LONG', marketId: 92, baseAmount: '10', worstPrice: '1', clientOrderIndex: 1 }), 1)).rejects.toBeInstanceOf(LighterSignerUnavailable);
    expect(lighterSignerLoads()).toBe(before);
  });
});

describe('key verification and auth token', () => {
  it('derives the registered public key from the private key (match) and a different key from another (mismatch)', async () => {
    expect(await A.publicKey()).toBe(KEY_A.pk);
    expect(await B.publicKey()).toBe(KEY_B.pk);
    expect(KEY_A.pk).not.toBe(KEY_B.pk);
  });

  it('rejects a malformed key with a clear error that never contains the key', async () => {
    const bad = wasmLighterSigner({ accountIndex: 7, apiKeyIndex: 5, chainId, apiPrivateKey: KEY_A.prv.slice(0, 40) });
    const e = await bad.publicKey().catch((x: Error) => x);
    expect(e).toBeInstanceOf(LighterSignerError);
    expect((e as Error).message).toMatch(/invalid private key length/);
    expect((e as Error).message).not.toContain(KEY_A.prv.slice(0, 40));
  });

  it('auth token: {deadline}:{account}:{key}:{signature}, about one hour ahead', async () => {
    const t = await A.createAuthToken(0);
    const [deadline, account, key, sig] = t.split(':');
    expect([account, key]).toEqual(['4242', '5']);
    expect(Number(deadline) - Math.floor(Date.now() / 1000)).toBeGreaterThan(3500);
    expect(sig).toMatch(/^[0-9a-f]{100,}$/);
    expect(t).not.toContain(KEY_A.prv);
  });
});

describe('offline signing of the Step 4 order shapes', () => {
  it('OTO entry + reduce-only stop: one grouped transaction with our fields, nonce, account and key', async () => {
    const g = buildOpenWithStop({ side: 'LONG', rules: RULES, baseAmount: '100', entryWorstPrice: '241210', stopTrigger: '230000', stopWorstPrice: '225400', entryClientOrderIndex: 1001, stopClientOrderIndex: 1002, nowMs: Date.now() });
    const s = await A.signCreateGroupedOrders(g, 7);
    expect(s.txType).toBe(28);
    expect(s.txHash).toMatch(/^[0-9a-f]{80}$/);
    const info = JSON.parse(s.txInfo);
    expect(info).toMatchObject({ AccountIndex: 4242, ApiKeyIndex: 5, GroupingType: 1, Nonce: 7 });
    expect(info.Orders).toEqual([
      expect.objectContaining({ MarketIndex: 92, ClientOrderIndex: 1001, BaseAmount: 100, Price: 241210, IsAsk: 0, Type: 1, TimeInForce: 0, ReduceOnly: 0, TriggerPrice: 0, OrderExpiry: 0 }),
      expect.objectContaining({ MarketIndex: 92, ClientOrderIndex: 1002, BaseAmount: 0, Price: 225400, IsAsk: 1, Type: 2, TimeInForce: 0, ReduceOnly: 1, TriggerPrice: 230000 })
    ]);
    expect(info.Sig).toBeTruthy();
    expect(s.txInfo).not.toContain(KEY_A.prv);
  });

  it('the old shape (child sized like the parent) is refused by Lighter’s own validation', async () => {
    const g = buildOpenWithStop({ side: 'SHORT', rules: RULES, baseAmount: '100', entryWorstPrice: '238790', stopTrigger: '250000', stopWorstPrice: '255000', entryClientOrderIndex: 1, stopClientOrderIndex: 2, nowMs: Date.now() });
    g.orders[1].BaseAmount = '100';
    await expect(A.signCreateGroupedOrders(g, 1)).rejects.toThrow(/BaseAmount should be nil/);
  });

  it('reduce-only close, stop resize (modify) and cancel', async () => {
    const c = JSON.parse((await A.signCreateOrder(buildReduceOnlyClose({ positionSide: 'SHORT', marketId: 92, baseAmount: '50', worstPrice: '241210', clientOrderIndex: 1003 }), 8)).txInfo);
    expect(c).toMatchObject({ ClientOrderIndex: 1003, BaseAmount: 50, IsAsk: 0, ReduceOnly: 1, Type: 1, Nonce: 8 });
    const m = await A.signModifyOrder({ marketIndex: 92, index: 1002, baseAmount: '50', price: '225400', triggerPrice: '230000' }, 9);
    expect(m.txType).toBe(17);
    expect(JSON.parse(m.txInfo)).toMatchObject({ MarketIndex: 92, Index: 1002, BaseAmount: 50, TriggerPrice: 230000, Nonce: 9 });
    const x = await A.signCancelOrder({ marketIndex: 92, index: 1002 }, 10);
    expect([x.txType, JSON.parse(x.txInfo).Nonce]).toEqual([15, 10]);
  });

  it('concurrent calls from two connections never sign with each other’s key or account', async () => {
    const order = (i: number) => buildReduceOnlyClose({ positionSide: 'LONG', marketId: 92, baseAmount: '10', worstPrice: '200000', clientOrderIndex: 5000 + i });
    const jobs = Array.from({ length: 40 }, (_, i) => (i % 2 ? B : A).signCreateOrder(order(i), 100 + i).then((s) => ({ i, info: JSON.parse(s.txInfo), hash: s.txHash })));
    const keys = Array.from({ length: 10 }, (_, i) => (i % 2 ? B : A).publicKey().then((pk) => ({ i, pk })));
    const [signedAll, pks] = await Promise.all([Promise.all(jobs), Promise.all(keys)]);
    for (const { i, info } of signedAll) expect([info.AccountIndex, info.ApiKeyIndex, info.Nonce, info.ClientOrderIndex]).toEqual(i % 2 ? [5151, 6, 100 + i, 5000 + i] : [4242, 5, 100 + i, 5000 + i]);
    for (const { i, pk } of pks) expect(pk).toBe(i % 2 ? KEY_B.pk : KEY_A.pk);
    expect(new Set(signedAll.map((s) => s.hash)).size).toBe(40);
  }, 20_000); // 50 serialised WASM calls: allow for a loaded machine

  it('a signing failure is an error (the operation stays blocked), and the signer keeps working afterwards', async () => {
    await expect(A.signCreateOrder({ ...buildReduceOnlyClose({ positionSide: 'LONG', marketId: 92, baseAmount: '10', worstPrice: '1', clientOrderIndex: 1 }), BaseAmount: 'x' }, 1)).rejects.toBeInstanceOf(LighterSignerError);
    expect(await A.publicKey()).toBe(KEY_A.pk);
    expect(lighterSignerLoads()).toBe(1);
  });
});
