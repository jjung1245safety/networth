/* ══════════════════════════════════════════════════════════════
   부채 상환 · 현금흐름 시뮬레이션 엔진
   단위: 만원 / 금리: 연 %
   ══════════════════════════════════════════════════════════════ */

function round2(x){ return Math.round(x * 100) / 100; }

/* 원리금균등 월 상환액 */
function pmt(principal, annualRatePct, months){
  if(months <= 0) return principal;
  var r = annualRatePct / 100 / 12;
  if(Math.abs(r) < 1e-12) return principal / months;
  return principal * r / (1 - Math.pow(1 + r, -months));
}

/* "2026-09" +n개월 → "2027-03" */
function ymAdd(ym, n){
  var p = String(ym).split("-");
  var y = parseInt(p[0], 10), m = parseInt(p[1], 10) - 1 + n;
  y += Math.floor(m / 12);
  m = ((m % 12) + 12) % 12;
  return y + "-" + String(m + 1).padStart(2, "0");
}
function ymIndex(ym){
  var p = String(ym).split("-");
  return parseInt(p[0], 10) * 12 + (parseInt(p[1], 10) - 1);
}

/* 해당 월에 유입되는 목돈 합계 */
function inflowAt(events, ym, startYm){
  var t = ymIndex(ym), s = ymIndex(startYm), sum = 0, list = [];
  (events || []).forEach(function(e){
    if(!e || !e.ym) return;
    var a = Number(e.amt) || 0;
    if(a === 0) return;
    var b = ymIndex(e.ym);
    if(b > t) return;
    var hit = false;
    if(e.repeat === "yearly"){
      if((t - b) % 12 === 0) hit = true;
    }else if(e.repeat === "monthly"){
      hit = true;
    }else{
      if(t === b) hit = true;
    }
    if(hit && t >= s){ sum += a; list.push({ memo: e.memo || "목돈", amt: a }); }
  });
  return { sum: sum, list: list };
}

/* ── 본 시뮬레이션 ─────────────────────────────────────────── */
function simulate(cfg){
  var months   = Math.max(1, Math.min(600, Number(cfg.months) || 36));
  var startYm  = cfg.startYm || "2026-09";
  var income   = Number(cfg.incomeM)  || 0;
  var expense  = Number(cfg.expenseM) || 0;
  var other    = Number(cfg.otherAssets) || 0;

  var mt = { bal:Number(cfg.mtong.bal)||0, limit:Number(cfg.mtong.limit)||0, rate:Number(cfg.mtong.rate)||0 };
  var ln = { bal:Number(cfg.loan.bal)||0,  rate:Number(cfg.loan.rate)||0,
             type:cfg.loan.type || "원리금균등", term:Number(cfg.loan.termMonths)||0 };
  var pk = { bal:Number(cfg.park.bal)||0,  rate:Number(cfg.park.rate)||0,
             tax:!!cfg.park.tax, target:Number(cfg.park.target)||0 };
  var iv = { bal:Number(cfg.invest.bal)||0, rate:Number(cfg.invest.rate)||0 };

  var priority = (cfg.priority && cfg.priority.length) ? cfg.priority.slice()
               : ["mtong","park","loan","invest"];
  ["mtong","park","loan","invest"].forEach(function(k){
    if(priority.indexOf(k) === -1) priority.push(k);
  });

  var basePmt = (ln.type === "원리금균등" && ln.bal > 0 && ln.term > 0)
              ? pmt(ln.bal, ln.rate, ln.term) : 0;

  var pkRate = pk.rate * (pk.tax ? (1 - 0.154) : 1);   // 이자소득세 15.4%

  var rows = [];
  var totIntMt = 0, totIntLn = 0, totGainPk = 0, totGainIv = 0, totInflow = 0;
  var mtClear = null, lnClear = null, pkHit = null;
  var warn = { overLimit:null, maturity:null, negative:0 };

  for(var i = 0; i < months; i++){
    var ym = ymAdd(startYm, i);

    /* 1. 이자 · 수익 반영 */
    var iMt = mt.bal * mt.rate / 100 / 12;
    mt.bal += iMt; totIntMt += iMt;

    var gPk = pk.bal * pkRate / 100 / 12;
    pk.bal += gPk; totGainPk += gPk;

    var gIv = iv.bal * iv.rate / 100 / 12;
    iv.bal += gIv; totGainIv += gIv;

    var iLn = ln.bal * ln.rate / 100 / 12;
    totIntLn += iLn;

    /* 2. 신용대출 필수 납입 */
    var due = 0;
    if(ln.bal > 0){
      if(ln.type === "원리금균등"){
        due = Math.min(basePmt, ln.bal + iLn);
      }else{
        due = iLn;                                  // 만기일시: 이자만
      }
      ln.bal = ln.bal + iLn - due;
      if(ln.bal < 0.005) ln.bal = 0;
    }

    /* 3. 만기 도래 처리(만기일시상환) */
    if(ln.type === "만기일시" && ln.term > 0 && i + 1 === ln.term && ln.bal > 0){
      var need = ln.bal;
      var fromPk = Math.min(pk.bal, need); pk.bal -= fromPk; need -= fromPk;
      if(need > 0){ mt.bal += need; }               // 부족분은 마통으로 흡수
      ln.bal = 0;
      if(!warn.maturity) warn.maturity = ym;
    }

    /* 4. 가용 현금 */
    var inf = inflowAt(cfg.events, ym, startYm);
    totInflow += inf.sum;
    var cash = income - expense - due + inf.sum;

    if(cash < 0){                                   // 적자 → 마통 인출
      mt.bal += -cash;
      warn.negative++;
      cash = 0;
    }

    /* 5. 우선순위 배분 */
    var alloc = { mtong:0, park:0, loan:0, invest:0 };
    for(var p = 0; p < priority.length && cash > 0.0001; p++){
      var k = priority[p];
      if(k === "mtong"){
        var a = Math.min(cash, mt.bal);
        mt.bal -= a; cash -= a; alloc.mtong += a;
      }else if(k === "park"){
        var short = Math.max(0, pk.target - pk.bal);
        var b = Math.min(cash, short);
        pk.bal += b; cash -= b; alloc.park += b;
      }else if(k === "loan"){
        var c = Math.min(cash, ln.bal);
        ln.bal -= c; cash -= c; alloc.loan += c;
      }else if(k === "invest"){
        iv.bal += cash; alloc.invest += cash; cash = 0;
      }
    }
    if(cash > 0.0001){ pk.bal += cash; alloc.park += cash; cash = 0; }  // 잔여는 파킹통장

    if(mt.bal < 0.005) mt.bal = 0;
    if(ln.bal < 0.005) ln.bal = 0;

    /* 6. 마일스톤 · 경고 */
    if(mtClear === null && mt.bal === 0) mtClear = ym;
    if(lnClear === null && ln.bal === 0) lnClear = ym;
    if(pkHit  === null && pk.target > 0 && pk.bal >= pk.target - 0.005) pkHit = ym;
    if(!warn.overLimit && mt.limit > 0 && mt.bal > mt.limit) warn.overLimit = ym;

    var debt = mt.bal + ln.bal;
    rows.push({
      i:i+1, ym:ym,
      inflow:inf.sum, inflowList:inf.list,
      due:due, intMt:iMt, intLn:iLn,
      alloc:alloc,
      mtong:mt.bal, loan:ln.bal, park:pk.bal, invest:iv.bal,
      debt:debt,
      net: pk.bal + iv.bal + other - debt
    });
  }

  var last = rows[rows.length - 1];
  return {
    rows: rows,
    basePmt: basePmt,
    kpi: {
      mtClear: mtClear, lnClear: lnClear, pkHit: pkHit,
      totalInterest: totIntMt + totIntLn,
      intMt: totIntMt, intLn: totIntLn,
      gainPark: totGainPk, gainInvest: totGainIv,
      totalInflow: totInflow,
      endDebt: last.debt, endNet: last.net,
      endPark: last.park, endInvest: last.invest
    },
    warn: warn
  };
}

if(typeof module !== "undefined") module.exports = { pmt, ymAdd, ymIndex, inflowAt, simulate, round2 };
