# Lighter signer (vendored, pinned)

Server-side only. Loaded by `packages/db/src/live/lighterWasmSigner.ts`, which refuses to run unless
both files below match these SHA-256 values. Never served to browsers. Verified 2026-11-17.

## lighter-signer-web.wasm

| | |
|---|---|
| Project | elliottech/lighter-go (official Lighter Go SDK), license Apache-2.0 (`LICENSE-lighter-go`) |
| Release | `v1.0.12`, published 2026-10-19T16:48:50Z, not a pre-release; tag → commit `324c93b067f24ede24918f3ac10663605d5f11c3` |
| Source URL | https://github.com/elliottech/lighter-go/releases/download/v1.0.12/lighter-signer-web.wasm |
| Size | 7,584,174 bytes |
| SHA-256 (local) | `95c9dd38373405691498c52c0feb72338e6bb00e90362227efe59fb12523c5ae` |
| SHA-256 (upstream) | GitHub release-asset digest `sha256:95c9dd38…c5ae` — identical. It is computed by GitHub at upload; the maintainers publish no separate checksum file and no signature/attestation. |
| Built from | `./web-wasm` (justfile recipe `build-web-wasm`: `GOOS=js GOARCH=wasm go build -trimpath -buildvcs=false -ldflags="-s -w"`). Uploaded manually by the release author; the repository CI builds and tests a different entrypoint (`./wasm/`) and does not produce this asset. |
| Go toolchain | `go1.25.5` (embedded build version; `go.mod` itself pins toolchain go1.23.1) |
| API | `_createClientByPrv`, `_createAuthToken`, `_signCreateOrder`, `_signCreateGroupedOrders`, `_signModifyOrder`, `_signCancelOrder` (Promise-returning; offline; no network). This is the web front end's API, not the `./wasm/` API documented at docs.lighter.xyz. |

## wasm_exec.js (Go runtime shim)

| | |
|---|---|
| Project | golang/go, license BSD-3-Clause (`LICENSE-go`) |
| Version | `go1.25.5` (must match the toolchain that built the .wasm) |
| Source | `lib/wasm/wasm_exec.js` in https://go.dev/dl/go1.25.5.src.tar.gz |
| SHA-256 (local) | `0c949f4996f9a89698e4b5c586de32249c3b69b7baadb64d220073cc04acba14` |
| Upstream evidence | The source tarball's SHA-256 `22a5fd0a91efcd28a1b0537106b9959b2804b61f59c3758b51e8e5429c1a954f` equals the value published by go.dev/dl (JSON listing). The file extracted from it is byte-identical to `https://raw.githubusercontent.com/golang/go/go1.25.5/lib/wasm/wasm_exec.js`. No per-file checksum is published upstream. |

## Not covered by these checks

Signatures, transaction hashes and auth tokens produced by this build have been checked for shape,
nonce, account and key fields only. Acceptance by Lighter (that the signatures verify and the key
derivation matches a registered key) is observed only on the exchange.
