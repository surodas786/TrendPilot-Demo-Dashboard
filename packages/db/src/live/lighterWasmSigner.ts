import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { LIGHTER_TX_TYPE, type LighterOrderReq } from '@trendpilot/domain';
import { findRepoRoot } from '../env';
import { LighterSignerUnavailable, type LighterSignedTx, type LighterSigner } from './lighterPrivate';

/**
 * The Lighter signer: the official lighter-go v1.0.12 WASM build (`lighter-signer-web.wasm`) run in
 * THIS Node process with the matching Go 1.25.5 runtime shim (see vendor/lighter-signer/PROVENANCE.md).
 * Server-only: the files are read from disk at first use, never imported, so no bundle contains them.
 *
 *  - Integrity: both files must match their pinned SHA-256 before anything is instantiated.
 *  - Offline: the module signs and hashes only; nonces are always passed in (TrendPilot's nonce
 *    lease); it opens no connection.
 *  - Isolation: the module keeps one client per ACCOUNT INDEX, so every call re-creates the client
 *    from that connection's key and signs inside one serialised critical section — two
 *    connections can never sign with each other's key.
 *  - Secrets: the private key goes into the module only; the module's echo of it is dropped at once.
 *    Signed payloads are returned to the caller (sent once) and never logged. Errors carry the
 *    module's message, which never contains key material.
 *  - Any failure (missing or altered file, initialization, a signing error) throws: the operation
 *    stays blocked; nothing falls back.
 */

export const LIGHTER_SIGNER_ARTIFACT = {
  release: 'elliottech/lighter-go v1.0.12',
  wasm: { file: 'lighter-signer-web.wasm', sha256: '95c9dd38373405691498c52c0feb72338e6bb00e90362227efe59fb12523c5ae' },
  shim: { file: 'wasm_exec.js', sha256: '0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14', goVersion: 'go1.25.5' }
} as const;

export class LighterSignerError extends Error {
  constructor(operation: string, detail: string) {
    super(`LIGHTER_SIGNER_ERROR: ${operation}: ${detail.slice(0, 200)}`);
    this.name = 'LighterSignerError';
  }
}

type Fn = (...args: unknown[]) => () => Promise<Record<string, unknown>>;
interface Module {
  _createClientByPrv: Fn;
  _createAuthToken: Fn;
  _signCreateOrder: Fn;
  _signCreateGroupedOrders: Fn;
  _signModifyOrder: Fn;
  _signCancelOrder: Fn;
}
const REQUIRED = ['_createClientByPrv', '_createAuthToken', '_signCreateOrder', '_signCreateGroupedOrders', '_signModifyOrder', '_signCancelOrder'] as const;

/**
 * Where the vendored files are: the repository root found from the working directory (web server
 * and worker started inside the checkout), else next to this module's source (the tsx worker started
 * from anywhere). The bundled web server only uses the first. The files' hashes are checked anyway.
 */
export function lighterSignerDir(): string {
  const fromCwd = path.join(/* turbopackIgnore: true */ findRepoRoot(), 'packages/db/vendor/lighter-signer');
  if (existsSync(path.join(/* turbopackIgnore: true */ fromCwd, LIGHTER_SIGNER_ARTIFACT.wasm.file))) return fromCwd;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const fromModule = path.join(/* turbopackIgnore: true */ here, '..', '..', 'vendor', 'lighter-signer');
    if (existsSync(path.join(/* turbopackIgnore: true */ fromModule, LIGHTER_SIGNER_ARTIFACT.wasm.file))) return fromModule;
  } catch {
    // not a file URL (bundled): only the working-directory location applies
  }
  return fromCwd;
}

let loading: Promise<Module> | null = null;
let loadedFrom: string | null = null;
let loads = 0;

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function instantiate(dir: string): Promise<Module> {
  let wasm: Buffer;
  let shim: Buffer;
  try {
    wasm = readFileSync(path.join(/* turbopackIgnore: true */ dir, LIGHTER_SIGNER_ARTIFACT.wasm.file));
    shim = readFileSync(path.join(/* turbopackIgnore: true */ dir, LIGHTER_SIGNER_ARTIFACT.shim.file));
  } catch (e) {
    throw new LighterSignerUnavailable(`signer files not readable (${(e as NodeJS.ErrnoException).code ?? 'error'})`);
  }
  if (sha256(wasm) !== LIGHTER_SIGNER_ARTIFACT.wasm.sha256) throw new LighterSignerUnavailable('signer WASM does not match its pinned SHA-256; refusing to load it');
  if (sha256(shim) !== LIGHTER_SIGNER_ARTIFACT.shim.sha256) throw new LighterSignerUnavailable('Go runtime shim does not match its pinned SHA-256; refusing to load it');
  // Minimal local types: this package's TypeScript lib does not include WebAssembly.
  type WasmInstance = object;
  const g = globalThis as unknown as {
    Go?: new () => { importObject: object; run(i: WasmInstance): Promise<void> };
    WebAssembly: { instantiate(bytes: Uint8Array, imports: object): Promise<{ instance: WasmInstance }> };
  } & Record<string, unknown>;
  // The shim defines globalThis.Go; it is evaluated (not imported) so no bundler ever traces it.
  if (!g.Go) runInThisContext(shim.toString('utf8'), { filename: 'lighter-signer/wasm_exec.js' });
  if (!g.Go) throw new LighterSignerUnavailable('Go runtime shim did not initialise');
  const go = new g.Go();
  const { instance } = await g.WebAssembly.instantiate(wasm, go.importObject);
  void go.run(instance); // the Go runtime stays alive; its exports are registered synchronously
  const missing = REQUIRED.filter((k) => typeof g[k] !== 'function');
  if (missing.length) throw new LighterSignerUnavailable(`signer module lacks ${missing.join(', ')}`);
  loads += 1;
  return g as unknown as Module;
}

/** The module, loaded once per process (a failed load is retried on the next call). */
export function loadLighterSigner(dir = lighterSignerDir()): Promise<Module> {
  if (loading && loadedFrom === dir) return loading;
  loadedFrom = dir;
  loading = instantiate(dir).catch((e) => {
    loading = null;
    loadedFrom = null;
    throw e instanceof LighterSignerUnavailable ? e : new LighterSignerUnavailable(`initialization failed: ${(e as Error).message.slice(0, 160)}`);
  });
  return loading;
}

/** Times the WASM module was instantiated in this process (0 = never: e.g. Paper-only work). */
export const lighterSignerLoads = () => loads;

/*
 * Key lifecycle (Step 5). The module keeps one client per ACCOUNT INDEX holding the last key bound
 * to it, for the life of the process. TrendPilot rebinds that client to a throwaway key after each
 * use it controls (verification, sync, rotation, disconnect): later calls cannot sign with the
 * investor's key from this process's module state. This does NOT zeroize memory — Go's heap may
 * still hold the old key bytes until reused. Only a process restart clears the module; only
 * revoking the API key on Lighter makes an old key (and any token it signed, ≤ 1 h) useless.
 */
/** A well-formed key that is registered nowhere (derived from a public test seed): used only to overwrite. */
const THROWAWAY_KEY = '213f363b0f4e5391fa190f50cfb616abaac317675b928f949c4c215a5718bb48c2d34d23a4f06571';
const bindings = new Map<number, 'BOUND' | 'SCRUBBED'>();

/** This process's module binding for an account index (diagnostics / tests): undefined = never bound here. */
export const lighterSignerBinding = (accountIndex: number) => bindings.get(accountIndex);

/**
 * Rebinds the module's client for `accountIndex` to the throwaway key. No-op when this process
 * never loaded the signer. Serialised with signing, so it never interleaves with a call in flight.
 */
export async function scrubLighterSignerAccount(accountIndex: number): Promise<'SCRUBBED' | 'NOT_LOADED'> {
  if (!loading) return 'NOT_LOADED';
  return serialised(async () => {
    const m = await loadLighterSigner(loadedFrom ?? undefined);
    const r = await m._createClientByPrv(THROWAWAY_KEY, 304, accountIndex, 0, 4)();
    delete (r as Record<string, unknown>).prv;
    bindings.set(accountIndex, 'SCRUBBED');
    return 'SCRUBBED' as const;
  });
}

/** One call at a time across every connection (see Isolation above). */
let queue: Promise<unknown> = Promise.resolve();
function serialised<T>(f: () => Promise<T>): Promise<T> {
  const run = queue.then(f, f);
  queue = run.catch(() => undefined);
  return run;
}

const ok = (op: string, r: Record<string, unknown> | undefined): Record<string, unknown> => {
  if (!r || typeof r !== 'object') throw new LighterSignerError(op, 'no result');
  if (typeof r.error === 'string' && r.error) throw new LighterSignerError(op, r.error);
  return r;
};
const signed = (op: string, txType: number, r: Record<string, unknown>): LighterSignedTx => {
  const res = ok(op, r);
  if (typeof res.txInfo !== 'string' || typeof res.txHash !== 'string' || !/^[0-9a-f]+$/i.test(res.txHash)) throw new LighterSignerError(op, 'malformed signed transaction');
  return { txType, txInfo: res.txInfo, txHash: res.txHash.toLowerCase() };
};

export interface WasmSignerKey {
  accountIndex: number;
  apiKeyIndex: number;
  chainId: number;
  /** Hex, no 0x (validated as 40 bytes by the module). */
  apiPrivateKey: string;
}

/** A LighterSigner for ONE connection's key, backed by the pinned WASM module. */
export function wasmLighterSigner(key: WasmSignerKey, o: { dir?: string } = {}): LighterSigner {
  const withClient = <T>(op: string, f: (m: Module) => Promise<T>) =>
    serialised(async () => {
      const m = await loadLighterSigner(o.dir);
      // Re-bind the module's client for this account to THIS key (nonce argument unused here).
      const c = ok(op, await m._createClientByPrv(key.apiPrivateKey, key.chainId, key.accountIndex, 0, key.apiKeyIndex)());
      bindings.set(key.accountIndex, 'BOUND');
      const pk = typeof c.pk === 'string' ? c.pk.toLowerCase() : '';
      delete c.prv; // the module echoes the private key: never kept
      if (!/^[0-9a-f]{80}$/.test(pk)) throw new LighterSignerError(op, 'client creation returned no public key');
      return f(m);
    });
  const orderArgs = (x: LighterOrderReq) => [x.MarketIndex, x.ClientOrderIndex, String(x.BaseAmount), String(x.Price), x.IsAsk, x.Type, x.TimeInForce, x.ReduceOnly, String(x.TriggerPrice), x.OrderExpiry];
  return {
    publicKey: () =>
      serialised(async () => {
        const m = await loadLighterSigner(o.dir);
        const c = ok('publicKey', await m._createClientByPrv(key.apiPrivateKey, key.chainId, key.accountIndex, 0, key.apiKeyIndex)());
        bindings.set(key.accountIndex, 'BOUND');
        delete c.prv;
        const pk = typeof c.pk === 'string' ? c.pk.toLowerCase() : '';
        if (!/^[0-9a-f]{80}$/.test(pk)) throw new LighterSignerError('publicKey', 'no public key');
        return pk;
      }),
    // The module sets its own deadline (one hour); a caller's shorter deadline is still covered.
    createAuthToken: () =>
      withClient('createAuthToken', async (m) => {
        const r = ok('createAuthToken', await m._createAuthToken(key.accountIndex, key.apiKeyIndex)());
        if (typeof r.token !== 'string' || !r.token.startsWith(`${String(r.deadline)}:${key.accountIndex}:${key.apiKeyIndex}:`)) throw new LighterSignerError('createAuthToken', 'malformed token');
        return r.token;
      }),
    signCreateOrder: (x, nonce) => withClient('signCreateOrder', async (m) => signed('signCreateOrder', LIGHTER_TX_TYPE.CREATE_ORDER, await m._signCreateOrder(key.accountIndex, ...orderArgs(x), nonce)())),
    signCreateGroupedOrders: (g, nonce) =>
      withClient('signCreateGroupedOrders', async (m) => signed('signCreateGroupedOrders', LIGHTER_TX_TYPE.CREATE_GROUPED_ORDERS, await m._signCreateGroupedOrders(key.accountIndex, g.groupingType, g.orders.length, ...g.orders.flatMap(orderArgs), nonce)())),
    signModifyOrder: (x, nonce) =>
      withClient('signModifyOrder', async (m) => signed('signModifyOrder', LIGHTER_TX_TYPE.MODIFY_ORDER, await m._signModifyOrder(key.accountIndex, x.marketIndex, String(x.index), Number(x.baseAmount), Number(x.price), Number(x.triggerPrice), nonce)())),
    signCancelOrder: (x, nonce) => withClient('signCancelOrder', async (m) => signed('signCancelOrder', LIGHTER_TX_TYPE.CANCEL_ORDER, await m._signCancelOrder(key.accountIndex, x.marketIndex, String(x.index), nonce)()))
  };
}
