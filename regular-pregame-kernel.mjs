// Pure reuse of the existing Regular PA/base advancement and seeded RNG formulas.
// Regular runtime remains unchanged; the adapter supplies a frozen prior model.
export function createRegularPregameKernel(model) {
const safeDiv=(a,b)=>b?a/b:0;
function smooth(count,n,prior,weight){return (count+prior*weight)/(n+weight)}
function playerBatRates(p){
  const L=model.lb,W=120,n=p?.pa||0;
  if(!p) return L;
  return {s1:smooth(p.s1||0,n,L.s1,W),d2:smooth(p.d2||0,n,L.d2,W),t3:smooth(p.t3||0,n,L.t3,W),hr:smooth(p.hr||0,n,L.hr,W),
    bb:smooth(p.bb||0,n,L.bb,W),hbp:smooth(p.hbp||0,n,L.hbp,W),k:smooth(p.k||0,n,L.k,W),dp:smooth(p.dp||0,n,L.dp,W)};
}
function pitcherRates(p,team){
  if(p){
    const L=model.lp,W=180,n=p.bf;
    return {h:smooth(p.h,n,L.h,W),hr:smooth(p.hr,n,L.hr,W),bb:smooth(p.bb,n,L.bb,W),hbp:smooth(p.hbp,n,L.hbp,W),k:smooth(p.k,n,L.k,W)};
  }
  const t=model.teamP[team]||model.lp;
  return {h:t.h,hr:t.hr,bb:t.bb,hbp:t.hbp,k:t.k};
}
function eventProbs(batter,pitcher,defTeam){
  const L=model.lb, LP=model.lp, B=playerBatRates(batter), P=pitcherRates(pitcher,defTeam);
  const eps=1e-6, pNon=Math.max(eps,P.h-P.hr), lpNon=Math.max(eps,LP.h-LP.hr);
  const vals={
    '1B':L.s1*(B.s1/Math.max(eps,L.s1))*(pNon/lpNon),
    '2B':L.d2*(B.d2/Math.max(eps,L.d2))*(pNon/lpNon),
    '3B':L.t3*(B.t3/Math.max(eps,L.t3))*(pNon/lpNon),
    'HR':L.hr*(B.hr/Math.max(eps,L.hr))*(P.hr/Math.max(eps,LP.hr)),
    'BB':L.bb*(B.bb/Math.max(eps,L.bb))*(P.bb/Math.max(eps,LP.bb)),
    'HBP':L.hbp*(B.hbp/Math.max(eps,L.hbp))*(P.hbp/Math.max(eps,LP.hbp)),
    'K':L.k*(B.k/Math.max(eps,L.k))*(P.k/Math.max(eps,LP.k))
  };
  for(const k in vals) vals[k]=Math.max(0,Math.min(.55,vals[k]));
  let sumv=Object.values(vals).reduce((a,b)=>a+b,0);
  if(sumv>.92){const f=.92/sumv;for(const k in vals)vals[k]*=f;sumv=.92}
  vals.OUT=1-sumv;
  vals.dpCond=Math.min(.35, safeDiv(B.dp, Math.max(.01,vals.OUT)));
  return vals;
}
function pickEvent(pr,rng){
  let x=rng(),c=0;
  for(const k of ['1B','2B','3B','HR','BB','HBP','K','OUT']){c+=pr[k];if(x<c)return k}
  return 'OUT';
}
function forceWalk(b){
  let runs=0;
  const r1=!!(b&1),r2=!!(b&2),r3=!!(b&4);
  if(r1&&r2&&r3) runs++;
  let nb=b;
  if(r2&&r1) nb|=4;
  if(r1) nb|=2;
  nb|=1;
  return [nb,runs];
}
function applyEvent(event,b,o,rng,dpCond){
  let runs=0, nb=b, no=o;
  const r1=!!(b&1),r2=!!(b&2),r3=!!(b&4);
  if(event==='HR'){runs=1+(r1?1:0)+(r2?1:0)+(r3?1:0);nb=0}
  else if(event==='3B'){runs=(r1?1:0)+(r2?1:0)+(r3?1:0);nb=4}
  else if(event==='2B'){
    if(r3)runs++; if(r2)runs++;
    nb=2;
    if(r1){if(rng()<.55)runs++; else nb|=4}
  } else if(event==='1B'){
    if(r3)runs++;
    nb=1;
    if(r2){if(rng()<.62)runs++; else nb|=4}
    if(r1){if(rng()<.28)nb|=4; else nb|=2}
  } else if(event==='BB'||event==='HBP'){[nb,runs]=forceWalk(b)}
  else {
    if(event==='OUT' && r1 && o<2 && rng()<dpCond){no+=2;nb&=~1}
    else no++;
  }
  return {b:nb,o:Math.min(no,3),runs};
}
function xmur3(str){let h=1779033703^str.length;for(let i=0;i<str.length;i++){h=Math.imul(h^str.charCodeAt(i),3432918353);h=h<<13|h>>>19}return()=>{h=Math.imul(h^(h>>>16),2246822507);h=Math.imul(h^(h>>>13),3266489909);return(h^=h>>>16)>>>0}}
function mulberry32(a){return()=>{let t=a+=0x6D2B79F5;t=Math.imul(t^t>>>15,t|1);t^=t+Math.imul(t^t>>>7,t|61);return((t^t>>>14)>>>0)/4294967296}}
return Object.freeze({eventProbs,pickEvent,applyEvent,seeded:seed=>mulberry32(xmur3(seed)())});
}
