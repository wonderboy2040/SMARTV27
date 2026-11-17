# v21.37.0 MTF.js Futures-Only Migration

## Summary
Converted `server/ai/mtf.js` from mixed spot+futures to **futures-only** for CRYPTO/FUTURES markets, while keeping INDIA on NSE MCP + Groww and METALS on futures chain.

## Changes Made

### 1. Futures-Only Crypto Chain (`_candlesFor`)
**Before:**
- CRYPTO/FUTURES → CoinDCX INR spot → Binance/Bybit USDT spot klines

**After:**
- CRYPTO/FUTURES → CoinDCX USDT-M futures REST + WS overlay → Binance USDT-M fapi fallback
- **NO SPOT PATH** - user explicitly requested
- Metals auto-detected via `isMetalsBase()`

### 2. Futures-Only `rawTfCandlesUsdt`
**Before:**
- Complex multi-leg with spot fallback
- 60+ lines with legacy comments

**After:**
- Clean 35-line implementation
- Metals chain: Binance fapi → COMEX Yahoo (with anchor rescale)
- Futures chain: CoinDCX futures REST → Binance fapi
- **Zero spot references**

### 3. Removed Duplicate `_indiaCandles`
- Eliminated the old Yahoo-based implementation (lines 197-243)
- Kept only the NSE MCP + Groww version (lines 100-131)
- Removed Yahoo cache (`_yfCache`, `YF_TTL`, `YF_CACHE_MAX`)

### 4. Cleaned Up Chart Cache Overlay
**Before:**
- Per-READ overlay for INDIA/GLOBALFUTURES (stale forming bar issue)

**After:**
- Overlay now baked into NSE MCP cache (zero extra reads)
- Futures overlay only for FUTURES/CRYPTO markets
- Removed cross-domain overlay risk

### 5. Removed Unused Imports
- `fetchCoinDcxCandles` (no longer called directly)
- `isNseOpen` (moved to nseIndiaCandles.js)
- `indiaOverlayCandles` (baked into NSE MCP)
- `cxSpotOverlayCandles` (no spot needed)

### 6. Added Helper Functions
- `clamp(v, lo, hi)` - safe numeric clamping
- `num(v)` - null-safe number extraction

## Data Flow (v21.37.0)

### INDIA Market
```
NSE MCP REST (fetchIndiaCandles)
    ↓
Groww SSE overlay (baked in cache)
    ↓
Staleness gate (NSE session aware)
    ↓
Final candles (INR)
```

### CRYPTO/FUTURES Market
```
CoinDCX USDT-M Futures REST (fetchFuturesCandles)
    ↓
CX Futures WS overlay (cxFutOverlayCandles)
    ↓ [fallback] Binance USDT-M fapi (fetchBinanceFutKlines)
    ↓ [fallback] Bybit USDT linear perp
    ↓
Final candles (USDT)
```

### METALS Market
```
Binance fapi XAUUSDT/XAGUSDT (fetchMetalsFapiCandles)
    ↓ [fallback] Yahoo COMEX GC=F/SI=F (fetchMetalsYahooCandles)
    ↓
Anchor rescale (if Yahoo + LTP provided)
    ↓
CX Futures overlay (cxFutOverlayCandles)
    ↓
Final candles (USDT)
```

### GLOBALFUTURES Market
```
CoinDCX futures (US equity perps)
    ↓ [fallback] Yahoo equity series (^NDX, etc.)
    ↓
Final candles
```

## Impact

### Breaking Changes
- **CRYPTO/FUTURES plans now use futures prices only** - no spot fallback
- Spot bid/ask data completely removed from auto-trade path
- Users relying on spot prices for crypto will see futures pricing

### Benefits
- ✅ Consistent futures pricing (no spot/futures basis divergence)
- ✅ Eliminates cross-domain overlay violations (v20.9.3 lesson)
- ✅ Cleaner separation: INDIA (NSE MCP), CRYPTO (futures), METALS (futures)
- ✅ Faster candle fetches (no Yahoo round-trips for INDIA)
- ✅ Reduced Yahoo dependency (only COMEX for metals fallback)

### Risk Mitigation
- Circuit breaker still active (6 failures → 10min blackout)
- Honest degrade: "candles unavailable" instead of stale spot data
- All TFs degrade independently (never blocks board build)

## Testing Checklist

- [ ] INDIA stocks: NSE MCP + Groww overlay working
- [ ] CRYPTO futures: CoinDCX USDT-M futures + WS overlay
- [ ] CRYPTO futures fallback: Binance fapi → Bybit fapi
- [ ] METALS: XAUUSDT/XAGUSDT via Binance fapi
- [ ] METALS fallback: COMEX Yahoo with anchor rescale
- [ ] GLOBALFUTURES: US equity perps + Yahoo indices
- [ ] Circuit breaker: 6 failures → 10min skip
- [ ] Chart cache: overlay only for correct markets
- [ ] No Yahoo calls for INDIA (verify in network tab)
- [ ] No spot calls for CRYPTO (verify in network tab)

## Migration Notes

### For Agents/Modules Calling mtf.js
No changes needed - all public APIs remain the same:
- `buildMTFSnapshot(symbol, market, opts)`
- `mtfWire6Payload(snapshot)`
- `rawTfCandlesUsdt(symbol, tf, opts)` (exported)

### For Futures Configuration
Ensure these are set in `futures.js`:
- `FUT_TF_RES` mapping (tf → CoinDCX pcode)
- `fetchFuturesCandles` (CoinDCX USDT-M futures REST)
- `cxFutOverlayCandles` (WS overlay)
- `fetchBinanceFutKlines` (Binance USDT-M fapi)
- `fetchMetalsFapiCandles` (Binance fapi for metals)
- `fetchMetalsYahooCandles` (COMEX Yahoo fallback)

## Version
v21.37.0 [FUTURES-ONLY MIGRATION]
