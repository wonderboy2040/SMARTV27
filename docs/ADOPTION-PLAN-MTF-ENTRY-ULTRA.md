# Adoption & Upgrade Plan — MTF Entry Update + ULTRA

> Status: **analysis only** (koi code change nahi, koi commit nahi)
> Baseline: `E:\Smartv27\SMARTV27` — **v21.40.0** (294 test files / 5413 tests green)
> Sources analysed:
> - `C:\Users\SmartComp\Downloads\SMARTV27-MTF-Entry-Update\SMARTV27` (v21.38.0 + MTF entry feature branch)
> - `C:\Users\SmartComp\Downloads\SMARTV27-ULTRA-v21.39.0\SMARTV27` (v21.38.0 tree + ULTRA feature branch)
>
> Dono snapshots **v21.38.0** hain. Current site **v21.40.0** hai, isliye ye “upgrade” nahi — ye **parallel feature branches** hain. Inhe current repo par wholesale copy karna v21.39/v21.40 ke fixes delete kar dega.

---

## 1. Executive decision

| Snapshot | Core value | Verdict |
|---|---|---|
| **MTF Entry Update** | Market-qualified quote lanes, stale-price rejection, strong-setup evidence, synchronous commit guard, broker fill verification, tick-driven entry | **Surgically adopt** — highest value, real fill-realism + live-safety upgrade |
| **ULTRA v21.39.0** | Independent 4-TF tick engine, inversion audit, virtual paper book, live heat board | **Adopt as paper-only research + shadow veto** — never as a second execution engine |

**Golden rule:** dono snapshots se sirf **new modules + small integration hunks** port karo. `routes.js`, `mtfDualBoard.js`, `mtfAutoLink.js`, `mtf.js`, `signalRecheck.js`, `paperTrading.js`, `strategies/index.js`, `nseIndiaCandles.js` ko snapshot version se replace **mat** karo — current repo un files me newer fixes rakhta hai.

---

## 2. Snapshot facts

| Item | MTF Entry Update | ULTRA | Current v21.40.0 |
|---|---|---|---|
| package version | 21.38.0 | 21.38.0 (code/docs claim 21.39.0) | **21.40.0** |
| Unique files | 8 (4 server modules, 2 scripts, 4 docs, 3 tests) | 7 (4 server modules, 1 UI, 1 test, 1 doc) | — |
| New npm deps | none | none (`ws` already present) | — |
| New package scripts | none | none | — |
| Real order path | Haan (guarded live commit) | **Nahi — paper/veto only** | Existing MTF live lane |
| Evidence | Paper smoke + negative-expectancy replay | Deterministic unit tests, empty shipped ledger | 294/5413 tests |

### Critical truth
- MTF snapshot ke **3 new test suites me se 0 current repo par unmodified pass hote hain** (2 import fail, 1 guarded-contract assertions fail).
- ULTRA ke 19 tests core engine cover karte hain, lekin **routes/SSE/persistence/India/Binance-WS tests nahi hain**.
- MTF replay report khud kehti hai: 6 bps + 2 bps per leg ke baad **dono directions negative**, 80+ floor 75+ se worse. Ye edge ka proof nahi hai.

---

## 3. Feature matrix — kya add, kya upgrade, kya reject

### 3.1 MTF Entry Update

| # | Feature | Snapshot value | Current gap | Decision | Priority |
|---|---|---|---|---|---|
| M1 | **Entry-eligible quote lanes** (`liveFeed` per-source `entryTicks`) | raw tick lane with `receivedAt/eventAt/transport/entryEligible` | display tick hi hai; paper `plan.entry` par fill karta hai | **ADD** | P0 |
| M2 | **Quote freshness + clock skew** | WS 3s / REST 5s, 1s skew | koi age gate nahi | **ADD** | P0 |
| M3 | **Price window** | through-SL/T1, chase >0.25R, adverse >0.15R, trigger lost >0.05R | pre-entry me partial, through-T1/trigger-loss missing | **ADD** | P0 |
| M4 | **Closed vs forming tape** | `splitMtfTape` + tick only on forming bar | forming tick closed evidence ko touch kar sakta hai | **ADD** | P0 |
| M5 | **Strong-setup review** | STRONG/ELITE ≥80, closed-bar fresh, dissent, 45s board age, deep veto | `entryReadiness` 75-floor + deep veto hai, lekin tape-age/dissent/board-age nahi | **UPGRADE existing `entryReadiness`** | P1 |
| M6 | **Synchronous commit guard + fresh-price qty cap** | `readMtfEntryGuard` + `cappedMtfEntryQty` | async recheck ke baad price drift possible | **ADD** | P1 |
| M7 | **Broker hardening** | `beforeSubmit`, `fillVerified`, idempotency key, strict exposure, `SUBMITTED_UNKNOWN`, no min-lot/alt-wallet retry | partial; live order `ok` par aage badhta hai | **UPGRADE `futures.js` / `indiaOrders.js`** | P1 |
| M8 | **Manual lane quote gate** | paper fill qualified quote par, live final quote re-check | manual paper `plan.entry` par fill; live `mtfLiveLtpFor` snapshot | **UPGRADE manual routes** | P1 |
| M9 | **Tick-driven entry engine + leases** | 5s/key pacing, single-flight, deterministic priority, telemetry | existing sniper notional-based, different API | **DEFER / REPLACE** | P3 |
| M10 | **Latency benchmark** | p50/p95/p99 in-process | nahi hai | **ADD** (tooling) | P2 |
| M11 | **Paper inversion replay** | Binance public data, fees/slippage, both modes | nahi hai | **ADD** (research only) | P2 |
| M12 | **Sniper telemetry UI** | watching/checked/dispatched/opened, quote age, p95 | live panel minimal | **ADD with M9 only** | P3 |

### 3.2 ULTRA

| # | Feature | Snapshot value | Current gap | Decision | Priority |
|---|---|---|---|---|---|
| U1 | **4-TF tick consensus** | 1m/5m/15m/1h weighted, ADX scale, tape flow, tiers 80/68/55/35 | nahi hai | **ADD paper-only** | P2 |
| U2 | **Independent inversion audit** | regression/SMA50/Donchian + plan geometry + 85% risk invalidation → CLEAN/INVERTED/RISK/FLAT | current deep lane alag hai | **ADD** | P2 |
| U3 | **Virtual paper book** | SL/TP1/TP2/trail/reversal/time-stop, 0.5% risk | existing MTF paper ledger alag | **ADD as research ledger after fixes** | P2/P3 |
| U4 | **ULTRA live board UI** | 4-TF heat, candidate, veto chips, audit, plan, latency | nahi hai | **ADD collapsible** | P2 |
| U5 | **API + SSE** | board/symbol/status/audit/stream/paper | nahi hai | **ADD behind flag** | P2 |
| U6 | **Fail-open veto into pre-entry** | manual + auto preEntryRecheck | nahi hai | **ADD shadow → enforce** | P3 |
| U7 | **MTF board overlay** | `payload.ultra = {live, topStrong, inverted}` | snapshot UI khud use nahi karta | **SKIP** (low value) | — |
| U8 | **Separate auto execution** | ULTRA khud order nahi bhejta | — | **KEEP PAPER-ONLY** | — |

### 3.3 Reject list (do NOT port)

- Snapshot `routes.js`, `mtfDualBoard.js`, `mtfAutoLink.js`, `mtf.js`, `nseIndiaCandles.js`, `signalRecheck.js`, `paperTrading.js`, `strategies/index.js` — current repo newer fixes hain (ELITE recheck, audit sourceMeta, futures-pair overlay, agreement formula).
- Snapshot defaults: `sniperMode: true`, `autoSyncSiteLive: false` — current safety posture ulta hai.
- `server/data/*` and `data/ultra-paper.json` — runtime state; `.env` kabhi commit nahi.
- Snapshot version strings (`21.38.0`, hardcoded `ULTRA_VERSION='21.39.0'`).
- ULTRA ko real order path dena, ya existing paper ledger ke saath mix karna.

---

## 4. Target architecture

### 4.1 One entry pipeline (single source of truth)

```
Board row (quality)
  ├─ superScore >= configured floor (75) + tier + directionVerified + triggerFired
  ├─ plan geometry + closed-bar evidence fresh + strong dissent check + board age (45s)
  └─ deep verdict / trap / HTF / SVA / council vetoes
        ↓
Main AI-BOARD permission
  └─ same side + ACTION/STRONG/ELITE + confidence >= 60 + signal age
        ↓
Existing manual-lane parity (v21.39.0)
  └─ evaluateManualEntryGates: ATR stop floor, FADING, fidelity, churn, loss pause, caps
        ↓
preEntryRecheck (v21.38.0 + v21.40.0)
  └─ deep verdict, cluster/churn, real measured ATR
        ↓
Quote contract (NEW — single contract)
  ├─ entry-eligible source + transport
  ├─ WS 3s / REST 5s age + 1s clock skew
  └─ price window: through-SL/T1, chase <=0.25R, adverse <=0.15R, trigger lost <=0.05R
        ↓
Direction certificate + direction lock + risk sizing
        ↓
Commit guard (NEW — final synchronous read)
  ├─ fresh quote re-read, side unchanged
  ├─ qty = min(maxQty, riskBudget/|px-SL|, notionalCap/px)  [sizing policy configurable]
  └─ idempotency key: MTF:<feedKey>:<mode>:<side>:<triggerClosedAt>
        ↓
LIVE: broker beforeSubmit guard → fillVerified===true → journal
PAPER: open at qualified quote → ledger + telemetry
```

**Important:** quote contract do baar chalega — pehle UX/pre-check ke liye, phir **final authoritative** commit ke just pehle. Dono baar **same thresholds** use honge, isliye ye “double gate” nahi, ek hi contract ka fresh read hai.

### 4.2 Score floors — over-blocking se bachao

- `autoEligible` = ACTION floor 65 (display contract) — **unchanged**.
- `entryReadiness` = configured floor (`cfg.minScore`, default 75) — **authoritative view**.
- Snapshot ka `MTF_STRONG_MIN = 80` ko **hard gate mat banao**. Current problem hi “entries nahi fire ho rahi” hai; 80 floor aur tighten kar dega.
  - 80+ ko sirf **“strong badge / priority”** banao.
  - Entry floor **75** hi rahe; strong-setup ke evidence checks (closed tape, 45s age, dissent) floor se independent hain.
  - Agar user stricter chahe to `MTF_STRONG_FLOOR=80` optional flag.

### 4.3 Ledger separation

| Ledger | Authority | Purpose |
|---|---|---|
| `server/data/paper-trades.json` | **authoritative** | Existing MTF manual/auto paper + live mirror |
| `data/ultra-paper.json` | **research only** | ULTRA virtual book; never mixed into main PnL/equity |
| `server/data/mtf-auto-state.json` | authoritative | auto events/skip reasons |

ULTRA ka paper book sirf “engine behaviour evidence” ke liye; main paper desk ka PnL isse compare hoga, merge nahi.

---

## 5. Detailed specs

### 5.1 M1/M2/M3/M4 — Quote lanes + tape

**New files**
- `server/ai/mtfEntryFeed.js`
- `server/ai/lib/mtfCandleTape.js`

**`server/liveFeed.js` changes**
- `setTick(key, data, source, opts)` me add: `receivedAt`, `receivedMono`, `eventAt`, `transport`, `entryEligible`.
- Per-source map: `_entryTicks: Map<key, Map<source, tick>>` (cap 500 keys × 8 sources).
- Monotonic guard: same/replayed print ya backward clock reject.
- New exports: `entryTicks(key)`, `subscribeEntryTicks(fn)`, `__resetLiveFeedForTests()`.

**Producer changes** (display path untouched)
- `server/ai/cxRtStream.js` — WS `transport:'ws'`, REST `transport:'rest'`, `entryEligible` sirf exact `B-<base>_USDT` + `eventAt>0`.
- `server/ai/binanceFutWs.js` — `paperOnly` source, `entryEligible` sirf `time>0`.
- `server/ai/growwStream.js` / `growwQuote.js` — SSE/REST, `eventAt` normalise, `entryEligible` stamp.
- `server/inStream.js` — headless entry ke liye `_entryRefs` hold + timestamped REST qualification.
- `server/ai/globalFutures.js` — `eventAt` stamp.

**Board integration**
- `mtfDualBoard.js`: `splitMtfTape(raw, tfMin, now)` se `closed` + `forming`; tick sirf forming bar par.
- `latestMtfQuote(spec)` + `checkMtfPriceWindow(row, price)` board row par **telemetry** ke roop me lagao (block sirf enforce mode me).
- Snapshot `{overlay:false}` plumbing ko current `mtf.js` par port karo — current `futuresPairFor` + `cxFutOverlayCandles` **preserve** karke.

**Acceptance**
- Stale/display tick entry ke liye reject ho; same venue ka fresh WS tick accept ho.
- Out-of-order tick venue price ko overwrite na kare.
- Closed candle tick se mutate na ho.
- `quoteAgeMs`, `exchangeToReceiveMs`, `source`, `ws` row par visible.

### 5.2 M5 — Strong setup, merged into `entryReadiness`

**New file:** `server/ai/mtfTrendQuality.js`

`reviewMtfTrend(row, { minScore = cfgFloor, now })` se ye evidence checks lo:
- plan geometry + orderSide match
- `directionVerified` + `trendDir` + `triggerDir` aligned
- `triggerFired`
- 10 counter/exhaustion/trap flags
- closed bar side + `2× timeframe width` freshness
- strong dissent: opposite strategy side + confidence ≥65 + ≥2 opposing families
- board row age ≤45s
- deep `HOLD/STAND_ASIDE/CONFLICT/veto/SUPPRESSED/opposite side`

**Do NOT** hardcode `scoreFloor = max(80, minScore)`. Use:
- `strongFloor = max(75, cfg.minScore)` for badge;
- optional `MTF_STRONG_FLOOR` for hard gate (default off).

**Merge into `computeEntryReadiness`**
- Current `entryReadiness` shape (`eligible`, `blockers`, `primary`, `stage`) **unchanged**.
- Add `strongSetup: { ready, blockers, strongDissent, supporting, opposing, tapeAge, boardAge }` as detail, not a second boolean.
- `entryReadiness.eligible` enforce mode me `strongSetup.ready && quote ok` bhi consider kare; shadow mode me sirf telemetry.
- `dedupeEntryBlockers` same rahe — ek hi blocker list, source tags ke saath.

**UI**
- `MTFDualBoardPanel.tsx`: row par `strongSetup` chip + block reasons; `quoteAge` + source.
- `types.ts` me fields add.

### 5.3 M6/M7 — Commit guard + broker hardening

**New file:** `server/ai/mtfEntryCommit.js`
- `mtfEntryVeto(reason)` → typed 409 `{code:'MTF_ENTRY_VETO'}`.
- `readMtfEntryGuard(entryGuard, side)` — synchronous, side changed/price invalid → throw.
- `cappedMtfEntryQty({side, price, stopLoss, t1, t2, maxQty, riskBudget, notionalCap})` — fresh price par min of three caps.

**`server/ai/futures.js`**
- `createFuturesOrder(..., beforeSubmit)`: final guard **submit se pehle**, exposure read ke baad.
- `strict:true` exposure read; guarded path me alternate-wallet/min-lot retry **band**.
- Ambiguous outcome → `SUBMITTED_UNKNOWN`; naked protection order mat bhejo; retry block.
- `fillVerified` field return karo.

**`server/ai/indiaOrders.js`**
- Same `beforeSubmit` guard + `SUBMITTED_UNKNOWN` + fill verification.

**`server/ai/routes.js`**
- Manual LIVE: `entryGuard = () => mtfEntryCheck(row, {live:true,...})`; `fillVerified===true` required; idempotency key.
- Manual PAPER: final quote par fill; `sourceMeta` me `feedSource`, `quoteAgeMs`, `exchangeToReceiveMs`, `entryGate:'MTF_QUOTE_V1'`.
- Auto lane: `mtfAutoLink` ko `entryCheck` inject; **sizing policy preserve** (neeche).

**Sizing decision (important)**
- Current live auto = 100% wallet deployment; snapshot checked-feed path = risk-capped.
- Default: **wallet policy preserve** (`MTF_ENTRY_SIZING=wallet`), hard `maxNotionalPerTrade` ceiling ke saath.
- Optional `MTF_ENTRY_SIZING=risk` for risk-capped mode; dono me fresh-price caps.

### 5.4 M9 — Tick-driven entry (defer)

- Snapshot `sniperEntryEngine.js` live API (`startSniper/stopSniper/sniperStatus`) se **incompatible** hai.
- Do engines ek saath nahi chalenge. Approach:
  1. Pehle current sniper ko `MTF_REALTIME_ENTRY=off` par retire karo (compat wrapper).
  2. Naya `makeMtfRealtimeEntry` add karo; `sniperStatus` shape backward-compatible rakho.
  3. Feed leases, 5s/key pacing, single-flight, pending priority.
  4. UI TICK ENTRY toggle + telemetry.
- **Trigger:** sirf tab jab phase 1-4 ke baad measured latency (p95) justify kare. Warna current 2s board + 5s tick kaafi hai.

### 5.5 U1/U2/U3 — ULTRA core + paper (research)

**New files:** `server/ai/lib/ultraCore.js`, `server/ai/lib/ultraPaper.js`, `server/ai/ultraLive.js`, `server/ai/ultraRoutes.js`.

Port karo, lekin ye fixes pehle:
1. **Paper fills:** SL/TP1/TP2 par observed tick price use karo (gap-through), resting level nahi.
2. **Daily loss stop:** `dayPnl/dayKey` persist + restore; restart par reset na ho.
3. **Notional cap:** `maxNotionalPct` (e.g. 20% equity) add karo; tight SL se huge qty na bane.
4. **Keying:** positions `MARKET:SYMBOL` se key karo, sirf `symbol` se nahi.
5. **Rescale:** open positions ko rescale par reject/reset karo; false SL/TP hit na ho.
6. **Autostart:** `ULTRA_ENGINE=off` par routes 503 de, engine start na ho; `ULTRA_AUTOSTART=0` route-hit par bhi start na kare.
7. **Version:** `ULTRA_VERSION` app version se derive karo, hardcode nahi.
8. **Tier floor:** paper default STRONG=68; research ledger clearly label.

**Paper rules (snapshot):** 0.5% risk, 5 max open, 60s cooldown, 3% daily loss stop, 90m time stop, TP1 50% + BE, 1R trail.

### 5.6 U4/U5 — UI + API

- `UltraLiveBoard.tsx` add; **collapsible**, default collapsed.
- Mount: `CoinDcxTab.tsx` MTF panel ke upar, `IndiaIntradayTab.tsx` MTF panel ke upar.
- One SSE per visible desk; `EventSource` reconnect backoff; paper poll sirf expanded state me.
- Routes: `/api/ai/ultra/{board,symbol/:sym,status,audit,stream,paper,paper/toggle,paper/reset}`; parent auth inherited.
- Global SSE cap 12; 429 JSON; UI cap error par exponential backoff.

### 5.7 U6 — ULTRA veto (shadow → enforce)

- `preEntryGate.js`: optional `ultra = null`; `ultra.known && ultra.veto` par:
  - `ULTRA_VETO_MODE=shadow` → warn + telemetry only;
  - `enforce` → block `ULTRA_INVERSION`.
- `mtfAutoLink.js` auto pre-entry call me `ultraGateFor(baseSym, side, market)` pass.
- `routes.js` manual `mtfPreEntryVerdict` me same.
- `ultraGateFor` **fail-open** rahe: unknown/stale → `{known:false}`.
- Enforce promotion criteria: ≥100 known samples, veto precision measured, no valid entry lost without opposite live consensus evidence.

---

## 6. Phased implementation

### Phase 0 — Baseline & flags (0.5 day)
- `docs/FLAG-HISTORY.md` me naye flags record karo.
- Feature flags (defaults safe):
  - `MTF_ENTRY_QUOTE_MODE=off|shadow|enforce` → default `shadow`
  - `MTF_STRONG_SETUP_MODE=off|shadow|enforce` → default `shadow`
  - `MTF_LIVE_COMMIT_GUARD=off|shadow|enforce` → default `shadow`
  - `MTF_REALTIME_ENTRY=off|shadow|on` → default `off`
  - `ULTRA_ENGINE=off|paper` → default `off`
  - `ULTRA_VETO_MODE=off|shadow|enforce` → default `off`
- No behavior change; full suite green.

### Phase 1 — MTF quote foundation (2–3 days)
- `liveFeed` entry lanes + producers metadata.
- `mtfEntryFeed.js`, `lib/mtfCandleTape.js`.
- Board tape split + quote telemetry (shadow).
- Tests: lane monotonicity, stale WS/REST, clock skew, venue separation, closed/forming tape.
- **Exit:** quote rejection reasons visible on board; zero entry behavior change.

### Phase 2 — Strong setup + readiness merge (2 days)
- `mtfTrendQuality.js`; merge into `computeEntryReadiness`.
- Board `strongSetup` detail, counts (`strongReady`), UI chips.
- Tests: 75/79/80/85 rows, stale tape, dissent, board age, deep veto, dedupe.
- **Exit:** 65–74 rows still not ready; 75+ clean rows ready; no duplicate blockers.

### Phase 3 — Manual paper fill realism (1–2 days)
- `mtfEntryCheck` route wrapper; paper fill at qualified quote.
- Preserve `evaluateManualEntryGates` + pre-entry + certificate.
- `sourceMeta` telemetry; `entryGate:'MTF_QUOTE_V1'`.
- Tests: missing/stale quote → 409, side flip → 409, fresh quote → fill at quote, ledger fields.
- **Exit:** paper fill price = qualified quote (not plan entry); no gate vocabulary duplication.

### Phase 4 — Live commit hardening (3–5 days)
- `beforeSubmit` in futures/indiaOrders; strict exposure; no min-lot/alt-wallet retry; `SUBMITTED_UNKNOWN`; idempotency key; `fillVerified`.
- Manual LIVE route uses guard + fill verification.
- Auto lane `entryCheck` injection (wallet sizing default).
- Tests: port `mtfBrokerCommit` adapted; guard-after-exposure, insufficient balance, no min-lot, opposite quote, ambiguous outcome.
- **Exit:** shadow live dry-run tests green; no live order without verified fill; duplicate guard key blocks retry.

### Phase 5 — Tick-driven entry (optional, 3–4 days)
- Replace/retire old sniper; add `makeMtfRealtimeEntry`, leases, telemetry, UI toggle.
- Latency benchmark (`mtf-entry-latency.mjs`).
- **Exit:** p95 local check within budget; no queue growth; one engine only; fallback 5s tick works.

### Phase 6 — ULTRA paper engine (3–4 days)
- Add core/paper/live/routes with accounting fixes.
- Flag `ULTRA_ENGINE=paper`; autostart/kill semantics.
- Tests: port 19 + gap fill, daily loss persistence, notional cap, market key, India, routes.
- **Exit:** paper-only; ledger separate; no real order imports.

### Phase 7 — ULTRA UI (2 days)
- `UltraLiveBoard.tsx`, collapsible, SSE, filters, paper panel.
- Mount both tabs; lazy load; no extra polling when collapsed.
- **Exit:** one SSE per visible desk; 429 handled; mobile layout OK.

### Phase 8 — ULTRA veto shadow (2–3 days)
- `preEntryGate` optional ultra; manual + auto pass; telemetry.
- **Exit:** `ULTRA_VETO_MODE=shadow` data collected; zero blocks; audit report.
- Enforce only after promotion criteria.

### Phase 9 — Release & monitoring (2 days)
- Full suite + typecheck/lint/build/check:version/check:routes.
- Paper monitor 60+ min: opens/closes, quote rejects, strongSetup counts, 409 dedupe, ledger unchanged expectation.
- Docs: `CHANGES.md`, `FLAG-HISTORY.md`, feature doc.
- Version **21.41.0** (feature minor). Commit/push only after approval.

**Total:** P0/P1 (Phase 0–4) ≈ **2 weeks**; full plan ≈ **3–4 weeks**.

---

## 7. Test & acceptance strategy

### MTF
- Port + adapt: `mtfRealtimeEntry.test.ts`, `mtfEntryRoutes.test.ts`, `mtfBrokerCommit.test.ts`.
- New: `mtfEntryFeedV21410.test.ts`, `mtfTrendQualityV21410.test.ts`, `mtfCommitGuardV21410.test.ts`.
- Regression locks: current `manualLaneParityV21390.test.ts`, `gateConsolidationV21400.test.ts`, `preEntryGateV21380.test.ts` must stay green.
- Invariants: side never flips; quote source/transport allow-list; age/skew; price window; closed tape immutability; qty never exceeds risk/notional caps; one idempotency key = one order.

### ULTRA
- Port `ultraEngine.test.ts` (fix `__ultraBookForTest().reset` no-op).
- New: route/SSE tests, paper gap-through, daily-loss persistence, notional cap, market key, India seeding, `ULTRA_ENGINE=off` no-start.
- Invariants: plan geometry per side; tier/ADX caps; vetoes downgrade; fail-open gate; no order imports.

### Release gates
- `npx vitest run` — 294/5413 + new all green.
- `npm run typecheck`, `lint` (0 errors), `build`, `check:version`, `check:routes`.
- Paper smoke: 0 unintended opens; quote reject reasons correct; ledger fields present.
- Live: **no live test until Phase 4 unit/integration green + explicit user approval**.

---

## 8. Rollout, flags, rollback

| Flag | Off | Shadow | Enforce |
|---|---|---|---|
| `MTF_ENTRY_QUOTE_MODE` | no quote gate | log/telemetry | block stale/chase |
| `MTF_STRONG_SETUP_MODE` | no strong check | badge only | gate on strong evidence |
| `MTF_LIVE_COMMIT_GUARD` | old submit | log guard result | block fill-unverified |
| `ULTRA_ENGINE` | no engine | — | paper only |
| `ULTRA_VETO_MODE` | no veto | warn | block opposite live consensus |

**Rollback:** har phase independent commit; flag off = old behavior. ULTRA engine off = no WS/seeding. Live guard off = current path, but keep telemetry.

**Monitoring:**
- Quote rejection histogram (stale/skew/through-SL/through-T1/chase/adverse/trigger-lost).
- `strongSetup` ready vs `entryReadiness` ready counts.
- 409 blocker dedupe (no repeated identical lines).
- Paper fill slippage vs plan entry (expect real quote, not synthetic entry).
- ULTRA audit counts, veto counts, paper gap metrics.
- Latency p50/p95 (tick → dispatch; board build).

---

## 9. Risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Wholesale copy deletes v21.39/21.40 fixes | High | Only add modules + re-apply small hunks; keep current files |
| Two sniper engines fight | High | Retire old or compat wrapper; one subscription |
| 80 floor over-blocks | High | Keep 75 authoritative; 80 badge only; optional flag |
| Quote gate blocks all entries in paper | Medium | Shadow first; tune chase/adverse; monitor |
| `beforeSubmit` merge incomplete | High | Land adapter + route + guard together; tests before live |
| ULTRA paper ledger misleading | Medium | Research-only label; fix gap/daily-loss/notional; never mix PnL |
| ULTRA boot side effects | Medium | `ULTRA_ENGINE=off` full kill; no route-triggered start |
| SSE cap/token exposure | Medium | 12 cap, backoff, existing `?session=` pattern, document |
| India feed timestamp gaps | Medium | `groww-sse` + `groww-live` lanes; 5s REST fallback |
| Version drift | Low | One release version; remove hardcoded ULTRA version |

---

## 10. Explicit non-goals

- ULTRA ko real order execution dena.
- Existing paper ledger ko ULTRA ledger se replace karna.
- Snapshot `routes.js`/`mtfDualBoard.js`/`mtfAutoLink.js` ko current files par overwrite karna.
- `sniperMode: true` / `autoSyncSiteLive: false` defaults copy karna.
- 80+ floor ko bina data hard enforce karna.
- Snapshot data files ya `.env` commit karna.

---

## 11. Open decisions (user confirmation)

1. **Sizing:** 100% wallet preserve (recommended, current spec) vs risk-capped checked-feed mode? → default wallet + hard ceiling.
2. **ULTRA ledger:** separate research ledger (recommended) vs merge into `paper-trades.json`? → separate.
3. **Tick engine:** defer until Phase 1–4 data (recommended) vs build now? → defer.
4. **ULTRA veto:** shadow first (recommended) vs enforce immediately? → shadow.
5. **Version:** 21.41.0 (recommended) vs 22.0.0? → 21.41.0.
6. **UI:** ULTRA board collapsed by default (recommended) vs always open? → collapsed.

---

## 12. Bottom line

- **Karna hai:** MTF quote lanes + freshness + price window + closed tape + commit guard + broker fill verification; ULTRA 4-TF board + inversion audit as paper-only/shadow.
- **Upgrade karna hai:** `entryReadiness` (strong evidence merge), manual paper/live routes (quote fill), auto sniper (single guarded engine), `preEntryGate` (ULTRA veto), broker adapters (beforeSubmit/fill/idempotency).
- **Nahi karna:** wholesale snapshot copy, 80 hard floor, separate real execution, duplicate ledger authority, snapshot defaults/data/version.
