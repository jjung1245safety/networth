/* ══════════════════════════════════════════════════════════════
   해외주식 · 양도세 계산
   단위: 원(KRW). 주가·평단은 USD.
   세율·공제는 증권사·은행 공개 안내 기준(GOALS.md 근거표).
   세액은 현재 환율을 양도일 환율 대용으로 쓰고 수수료를 빼지 않은 추정치.
   ══════════════════════════════════════════════════════════════ */

var EXEMPT = 2500000;      // 양도소득 기본공제 (인당 연)
var RATE   = 0.22;         // 양도소득세 20% + 지방소득세 2%

function num(v){
  if(v === null || v === undefined || v === "") return 0;
  var n = Number(v);
  return isFinite(n) ? n : 0;
}
function isObj(h){ return h && typeof h === "object"; }

function valueUSD(h){ return isObj(h) ? num(h.shares) * num(h.price) : 0; }
function valueKRW(h, fx){ return valueUSD(h) * num(fx); }
function costKRW(h){ return isObj(h) ? num(h.costKRW) : 0; }
function gainKRW(h, fx){ return isObj(h) ? valueKRW(h, fx) - costKRW(h) : 0; }

function gainPct(h, fx){
  var c = costKRW(h);
  return c > 0 ? gainKRW(h, fx) / c * 100 : null;
}
function gainUSD(h){
  if(!isObj(h) || !(num(h.avgUSD) > 0)) return null;
  return num(h.shares) * (num(h.price) - num(h.avgUSD));
}
function avgFx(h){
  if(!isObj(h)) return null;
  var base = num(h.shares) * num(h.avgUSD);
  return (base > 0 && costKRW(h) > 0) ? costKRW(h) / base : null;
}

/* 원화손익 = 주가효과(현재 환율로 본 달러손익) + 환율효과(매입원금에 대한 환율 변동)
   shares·price·fx − shares·avgUSD·avgFx
   = shares·(price−avgUSD)·fx + shares·avgUSD·(fx−avgFx) */
function decompose(h, fx){
  var af = avgFx(h);
  if(af === null) return null;
  var s = num(h.shares), a = num(h.avgUSD), f = num(fx);
  return { price: s * (num(h.price) - a) * f, fx: s * a * (f - af) };
}

/* ── 양도세 ─────────────────────────────────────── */
function taxOn(netGain){ return Math.max(0, num(netGain) - EXEMPT) * RATE; }

function budget(realized){
  var r = num(realized);
  return {
    realized: r,
    room: Math.max(0, EXEMPT - r),                       // 세금 없이 더 실현할 수 있는 이익
    usedPct: Math.min(100, Math.max(0, r) / EXEMPT * 100),
    tax: taxOn(r)
  };
}

/* 올해 실현손익이 realized일 때, 손익 g를 추가 실현하면 세액이 얼마나 변하는가 */
function marginalTax(realized, g){
  return taxOn(num(realized) + num(g)) - taxOn(num(realized));
}

/* ── 구성 ─────────────────────────────────────── */
function weights(list, fx){
  var L = (list || []).filter(isObj);
  var vals = L.map(function(h){ return valueKRW(h, fx); });
  var total = vals.reduce(function(a, b){ return a + b; }, 0);
  return {
    total: total,
    items: L.map(function(h, i){
      var pct = total > 0 ? vals[i] / total * 100 : 0;
      return { id: h.id, ticker: h.ticker, value: vals[i], pct: pct, small: vals[i] > 0 && pct < 5 };
    })
  };
}

function groups(list, fx){
  var L = (list || []).filter(isObj), m = {}, total = 0;
  L.forEach(function(h){
    var g = (h.group && String(h.group).trim()) || "미지정";
    var v = valueKRW(h, fx);
    m[g] = (m[g] || 0) + v; total += v;
  });
  return Object.keys(m).map(function(g){
    return { group: g, value: m[g], pct: total > 0 ? m[g] / total * 100 : 0 };
  }).sort(function(a, b){ return b.value - a.value; });
}

function summary(list, fx){
  var L = (list || []).filter(isObj), s = { valueKRW:0, costKRW:0, gainKRW:0, gainOnly:0, lossOnly:0 };
  L.forEach(function(h){
    var g = gainKRW(h, fx);
    s.valueKRW += valueKRW(h, fx);
    s.costKRW  += costKRW(h);
    s.gainKRW  += g;
    if(g > 0) s.gainOnly += g; else s.lossOnly += g;
  });
  return s;
}

/* 총자산 통합용 — 만원 단위 */
function holdingsManwon(list, fx){
  return (list || []).filter(isObj).reduce(function(s, h){ return s + valueKRW(h, fx); }, 0) / 10000;
}

if(typeof module !== "undefined")
  module.exports = { EXEMPT, RATE, num, valueUSD, valueKRW, costKRW, gainKRW, gainPct, gainUSD, avgFx,
                     decompose, taxOn, budget, marginalTax, weights, groups, summary, holdingsManwon };
