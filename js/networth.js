/* ══════════════════════════════════════════════════════════════
   자산현황 계산 코어
   내부 표준단위: 만원(KRW). USD 항목은 fx로 환산.
   ══════════════════════════════════════════════════════════════ */

var ASSET_CATS = [
  { k:"현금성",   liq:"즉시",   note:"파킹통장·예금·CMA" },
  { k:"투자",     liq:"단기",   note:"주식·ETF·펀드" },
  { k:"연금",     liq:"제한",   note:"연금저축·IRP·퇴직연금" },
  { k:"보증금",   liq:"비유동", note:"거주 임차보증금" },
  { k:"부동산",   liq:"비유동", note:"보유 부동산 시세" },
  { k:"실물",     liq:"중기",   note:"차량·시계 등" },
  { k:"기타자산", liq:"중기",   note:"" }
];
var DEBT_CATS = [
  { k:"마이너스통장" }, { k:"신용대출" }, { k:"주택담보대출" },
  { k:"임대보증금" },   { k:"기타부채" }
];

/* 해외주식(종목 단위) 평가액 — 만원. 브라우저에선 holdings.js 전역 함수, Node에선 require */
function holdMan(data){
  var f = (typeof holdingsManwon === "function") ? holdingsManwon
        : (typeof require === "function" ? require("./holdings.js").holdingsManwon : null);
  return f ? f(data && data.holdings, data && data.fx) : 0;
}
function holdItems(data){
  var fx = Number(data && data.fx) || 0;
  return ((data && data.holdings) || []).filter(function(h){ return h && typeof h === "object"; })
    .map(function(h){
      var v = (Number(h.shares) || 0) * (Number(h.price) || 0) * fx / 10000;
      return { name: h.ticker || h.name || "종목", v: isFinite(v) ? v : 0 };
    });
}

/* USD·KRW → 만원 환산 */
function toManwon(amount, ccy, fx){
  var a = Number(amount) || 0;
  if(ccy === "USD") return a * (Number(fx) || 0) / 10000;
  return a;                                  // KRW는 이미 만원 단위
}

function catOf(list, cat, fx){
  return (list || []).reduce(function(s, x){
    return x.cat === cat ? s + toManwon(x.amount, x.ccy, fx) : s;
  }, 0);
}

/* ── 집계 ─────────────────────────────────────── */
function totals(data){
  var fx = Number(data.fx) || 0;
  var A = data.assets || [], D = data.debts || [];

  var assetByCat = {}, debtByCat = {};
  ASSET_CATS.forEach(function(c){ assetByCat[c.k] = catOf(A, c.k, fx); });
  DEBT_CATS.forEach(function(c){ debtByCat[c.k] = catOf(D, c.k, fx); });

  var totalAssets = A.reduce(function(s,x){ return s + toManwon(x.amount, x.ccy, fx); }, 0);
  var totalDebts  = D.reduce(function(s,x){ return s + toManwon(x.amount, x.ccy, fx); }, 0);

  var hm = holdMan(data);                    // 해외주식은 투자 분류로 합산
  if(isFinite(hm) && hm !== 0){ assetByCat["투자"] += hm; totalAssets += hm; }

  return {
    fx: fx,
    assetByCat: assetByCat,
    debtByCat: debtByCat,
    totalAssets: totalAssets,
    totalDebts: totalDebts,
    net: totalAssets - totalDebts
  };
}

/* ── 지표 ─────────────────────────────────────── */
function metrics(data, monthlyExpense){
  var t = totals(data);
  var fx = t.fx;
  var A = data.assets || [];

  var cash   = t.assetByCat["현금성"] || 0;
  var invest = t.assetByCat["투자"] || 0;
  var real   = t.assetByCat["실물"] || 0;

  var usd = A.reduce(function(s,x){
    return x.ccy === "USD" ? s + toManwon(x.amount, x.ccy, fx) : s;
  }, 0) + holdMan(data);

  var maxItem = null, maxVal = 0;
  A.forEach(function(x){
    var v = toManwon(x.amount, x.ccy, fx);
    if(v > maxVal){ maxVal = v; maxItem = x.name; }
  });
  holdItems(data).forEach(function(x){
    if(x.v > maxVal){ maxVal = x.v; maxItem = x.name; }
  });

  var exp = Number(monthlyExpense) || 0;

  return {
    debtRatio:    t.totalAssets > 0 ? t.totalDebts / t.totalAssets * 100 : 0,
    netDebt:      t.totalDebts - cash,
    liquidMonths: exp > 0 ? cash / exp : null,
    quickAssets:  cash + invest,
    usdShare:     t.totalAssets > 0 ? usd / t.totalAssets * 100 : 0,
    usdAmount:    usd,
    topName:      maxItem,
    topShare:     t.totalAssets > 0 ? maxVal / t.totalAssets * 100 : 0,
    topAmount:    maxVal,
    realShare:    t.totalAssets > 0 ? real / t.totalAssets * 100 : 0,
    cash:         cash,
    invest:       invest
  };
}

/* ── 유동성 구간 집계 ──────────────────────────── */
function liquidityBands(data){
  var t = totals(data);
  var band = { "즉시":0, "단기":0, "중기":0, "제한":0, "비유동":0 };
  ASSET_CATS.forEach(function(c){ band[c.liq] += t.assetByCat[c.k] || 0; });
  return band;
}

/* ── 스냅샷 ───────────────────────────────────── */
function makeSnapshot(data, ym){
  var t = totals(data);
  return {
    ym: ym,
    fx: t.fx,
    totalAssets: Math.round(t.totalAssets * 100) / 100,
    totalDebts:  Math.round(t.totalDebts * 100) / 100,
    net:         Math.round(t.net * 100) / 100,
    byCat: Object.assign({}, t.assetByCat),
    byDebt: Object.assign({}, t.debtByCat)
  };
}

/* 동일 연월이면 교체, 아니면 추가 후 연월 오름차순 정렬 */
function upsertSnapshot(list, snap){
  var out = (list || []).filter(function(s){ return s.ym !== snap.ym; });
  out.push(snap);
  out.sort(function(a,b){ return a.ym < b.ym ? -1 : (a.ym > b.ym ? 1 : 0); });
  return out;
}

/* 마지막 두 스냅샷 비교 */
function snapshotDiff(list){
  if(!list || list.length < 2) return null;
  var b = list[list.length-1], a = list[list.length-2];
  return {
    from: a.ym, to: b.ym,
    assets: b.totalAssets - a.totalAssets,
    debts:  b.totalDebts  - a.totalDebts,
    net:    b.net - a.net,
    netPct: a.net !== 0 ? (b.net - a.net) / Math.abs(a.net) * 100 : null
  };
}

if(typeof module !== "undefined")
  module.exports = { ASSET_CATS, DEBT_CATS, toManwon, totals, metrics, liquidityBands,
                     makeSnapshot, upsertSnapshot, snapshotDiff };
