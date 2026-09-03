// @ts-nocheck
/* Ported from Hooked-v3/index.html — imperative canvas FX. */

declare global {
  interface Window {
    __forceJackpot?: boolean;
    __pendingJackpot?: boolean;
    __pxStampDisk?: (...args: any[]) => void;
    __hookedBurst?: (x: number, y: number, pow?: number) => void;
    __bindSmiley?: (sv: SVGElement) => void;
    __showJackReveal?: () => void;
    __hideJackReveal?: () => void;
    __setJackRevealTarget?: (n: number) => void;
    __startLootDrop?: (drop: { pocketIndex: number; hookedOut: number; jackpot: boolean; jackpotUsd?: number }) => void;
    __startLootWaiting?: (info?: { targetRound?: number; ready?: boolean; confirming?: boolean }) => void;
    __setLootWaitingPhase?: (info: { targetRound?: number; ready?: boolean; confirming?: boolean }) => void;
    __closePlinko?: () => void;
  }
}

export const BASE_RATE = 1000;
export const JACKPOT_CHANCE = 0.01;
export const POCKETS = [
  { mult:0.9, tier:"meh",  label:"scratch", w:900, col:"#FF4D2E" },
  { mult:1.2, tier:"even", label:"plus",    w:80,  col:"#0B3D3A" },
  { mult:2.0, tier:"win",  label:"common",  w:17,  col:"#0B3D3A" },
  { mult:3.0, tier:"win",  label:"heat",    w:2,   col:"#00D4AA" },
  { mult:4.0, tier:"win",  label:"heat",    w:1,   col:"#00D4AA" },
];

export function pickPocket(){
  const t=POCKETS.reduce((s,p)=>s+p.w,0);
  let r=Math.random()*t;
  for(let i=0;i<POCKETS.length;i++){ r-=POCKETS[i].w; if(r<=0) return i; }
  return POCKETS.length-1;
}
export function rollJackpot(){
  return !!(window.__forceJackpot || Math.random()<JACKPOT_CHANCE);
}
function fmt(n){ return n.toLocaleString("en-US",{maximumFractionDigits:2}); }

let cleanups = [];
let homeFxStarted = false;

export function initHomeFx(){
  if (homeFxStarted) return;
  homeFxStarted = true;
/* ===== HERO PIXEL FIELD — grid like original, fades below hero ===== */
(function(){
  const cv=document.getElementById("px-field");
  const ctx=cv.getContext("2d",{alpha:false}); if(!ctx) return;
  const hero=document.getElementById("hero");
  const heroHead=document.getElementById("heroHead");
  const swap=document.getElementById("swap");
  const marq=document.getElementById("marqHost");
  const TOUCH=!(window.matchMedia&&matchMedia("(hover:hover) and (pointer:fine)").matches);
  const DPR=Math.min(devicePixelRatio||1,2);
  const cell=9, BRUSH=10;
  let W=0,H=0,cols=0,rows=0,heat=null,t=0,SEED=Math.random()*1000;
  let mx=-1,my=-1,hov=false,waves=[],shake=0,pmx=-1,pmy=-1,lastMove=-9;
  let cursorZone="";
  let raf=0, lastTs=0;
  let layoutDirty=true, invW=1, invH=1, colCo=null, hshA=null;

  /* field serves hero + marquee + smiley heat — only pause when tab hidden */
  function want(){ return !document.hidden; }
  function kick(){
    if(raf||!want()) return;
    lastTs=0;
    raf=requestAnimationFrame(render);
  }
  function stop(){ if(raf){ cancelAnimationFrame(raf); raf=0; } }
  function sync(){ if(want()) kick(); else stop(); }
  document.addEventListener("visibilitychange", sync);

  const COL_DEEP="#0B3D3A", COL_MINT="#00D4AA", COL_GOLD="#FFC107", COL_CORAL="#FF4D2E";
  const BANDS=[[0.30,COL_DEEP],[0.48,COL_MINT],[0.66,COL_GOLD],[0.82,COL_CORAL]];
  const DRAW_COLS=[COL_DEEP,COL_MINT,COL_GOLD,COL_CORAL];
  const buckets=[[],[],[],[]];
  const COIN=[[1,0],[2,0],[0,1],[1,1],[2,1],[3,1],[0,2],[1,2],[2,2],[3,2],[1,3],[2,3]];

  function size(){
    W=innerWidth; H=innerHeight;
    invW=1/Math.max(1,W); invH=1/Math.max(1,H);
    cv.width=Math.round(W*DPR); cv.height=Math.round(H*DPR);
    ctx.setTransform(DPR,0,0,DPR,0,0);
    cols=Math.ceil(W/cell)+1; rows=Math.ceil(H/cell)+1;
    heat=new Float32Array(cols*rows);
    colCo=new Float32Array(cols);
    hshA=new Float32Array(cols);
    for(let c=0;c<cols;c++){
      colCo[c]=Math.max(0,(Math.sin(c*0.5+SEED)+Math.sin(c*0.21-SEED*1.3))*0.16+0.15);
      hshA[c]=hsh((c/2)|0,0);
    }
    layoutDirty=true;
  }
  function hsh(c,r){ const n=Math.sin(c*127.1+r*311.7+SEED*0.13)*43758.5453; return n-Math.floor(n); }
  let lastW=innerWidth; size();
  addEventListener("resize",()=>{ if(innerWidth!==lastW){ lastW=innerWidth; size(); }});

  function base(nx,ny,tt){
    let s=SEED; nx+=Math.sin(ny*5+tt*0.5+s)*0.05; ny+=Math.cos(nx*5-tt*0.4)*0.05;
    const v=Math.sin(nx*5.6+s*1.3+tt*0.3)*Math.cos(ny*4.7-s*0.7+tt*0.22)
      +Math.sin((nx*1.4+ny*1.7)*4.1-s+tt*0.16)+Math.sin(ny*9+s*2.1+nx*3)*0.5+Math.sin(nx*13-s*1.7)*0.28;
    return 0.5+0.5*(v/2.55);
  }
  function region(nx,ny,tt){
    return 0.5+0.5*Math.sin(nx*2.1+tt*0.12+SEED*0.7)*Math.cos(ny*1.8-tt*0.09+SEED*0.3);
  }
  function dep(x,y,amt,sig){
    const cc=x/cell,cr=y/cell,rad=Math.ceil(sig*1.6),inv=1/(2*sig*sig*0.18);
    for(let dr=-rad;dr<=rad;dr++) for(let dc=-rad;dc<=rad;dc++){
      const c=(cc+dc)|0,r=(cr+dr)|0; if(c<0||r<0||c>=cols||r>=rows) continue;
      const dx=c+.5-cc,dy=r+.5-cr,w=Math.exp(-(dx*dx+dy*dy)*inv); if(w<.02) continue;
      const id=r*cols+c; heat[id]=Math.min(1,heat[id]+amt*w);
    }
  }
  function follow(x,y,sig){
    if(pmx<0){pmx=x;pmy=y;}
    const dx=x-pmx,dy=y-pmy,dl=Math.hypot(dx,dy),steps=Math.max(1,Math.min(48,Math.round(dl/(cell*0.8))));
    for(let s=1;s<=steps;s++){ const f=s/steps; dep(pmx+dx*f,pmy+dy*f,0.16,sig); }
    pmx=x; pmy=y;
  }
  function stampDisk(cx,cy,rad,val){
    if(rad<3) return;
    const c0=Math.floor((cx-rad)/cell),c1=Math.ceil((cx+rad)/cell);
    const r0=Math.floor((cy-rad)/cell),r1=Math.ceil((cy+rad)/cell),rr=rad*rad;
    for(let r=r0;r<=r1;r++) for(let c=c0;c<=c1;c++){
      if(c<0||r<0||c>=cols||r>=rows) continue;
      const dx=(c+.5)*cell-cx,dy=(r+.5)*cell-cy; if(dx*dx+dy*dy>rr) continue;
      heat[r*cols+c]=val+0.02*(hsh(c,r)-0.5);
    }
  }
  function stampCoin(cx,cy){
    const S=2, bc=Math.round(cx/cell), br=Math.round(cy/cell), o=2*S;
    const tw=t*0.006;
    for(const p of COIN){
      for(let yy=0;yy<S;yy++) for(let xx=0;xx<S;xx++){
        const C=bc+p[0]*S+xx-o, R=br+p[1]*S+yy-o;
        if(C<0||R<0||C>=cols||R>=rows) continue;
        const id=R*cols+C, w=0.72+0.18*Math.sin((C*0.6+R*0.6)-tw);
        if(w>heat[id]) heat[id]=w;
      }
    }
  }

  /* idle roulette — coarser sampling, batch by color */
  const WHEEL_COLS=[COL_DEEP,COL_MINT,COL_GOLD,COL_CORAL,COL_MINT,COL_GOLD];
  const WHEEL_CELL=9;
  const wheelBuckets=[[],[],[],[],[],[]];
  function drawIdleRoulette(cx,cy,ang){
    const R=118, segs=18, CELL=WHEEL_CELL;
    for(let i=0;i<6;i++) wheelBuckets[i].length=0;
    for(let i=0;i<segs;i++){
      const a0=ang+i/segs*Math.PI*2;
      const a1=ang+(i+0.72)/segs*Math.PI*2;
      const bi=i%WHEEL_COLS.length;
      const bucket=wheelBuckets[bi];
      for(let u=0;u<1;u+=0.04){
        for(let rad=0.55;rad<=1;rad+=0.07){
          const a=a0+(a1-a0)*u;
          bucket.push(Math.round((cx+Math.cos(a)*R*rad)/CELL)*CELL, Math.round((cy+Math.sin(a)*R*rad*0.72)/CELL)*CELL, 0.35+rad*0.55);
        }
      }
    }
    for(let bi=0;bi<WHEEL_COLS.length;bi++){
      const bucket=wheelBuckets[bi], col=WHEEL_COLS[bi];
      for(let i=0;i<bucket.length;i+=3){
        ctx.globalAlpha=bucket[i+2];
        ctx.fillStyle=col;
        ctx.fillRect(bucket[i], bucket[i+1], CELL-1, CELL-1);
      }
    }
    const markerA=-ang*1.7;
    const hx=cx+Math.cos(markerA)*R*0.28;
    const hy=cy+Math.sin(markerA)*R*0.2;
    ctx.globalAlpha=1;
    ctx.fillStyle="#0A0A0A";
    ctx.fillRect(Math.round(hx/CELL)*CELL-CELL, Math.round(hy/CELL)*CELL-CELL, CELL*2-1, CELL*2-1);
    ctx.fillStyle=COL_GOLD;
    ctx.fillRect(Math.round(hx/CELL)*CELL, Math.round(hy/CELL)*CELL, CELL-1, CELL-1);
    for(let k=0;k<10;k++){
      const a=ang*2.1+k*0.7+Math.sin(ang*3+k);
      ctx.globalAlpha=0.4+0.4*Math.sin(ang*8+k);
      ctx.fillStyle=WHEEL_COLS[k%WHEEL_COLS.length];
      ctx.fillRect(Math.round((cx+Math.cos(a)*R*1.05)/CELL)*CELL, Math.round((cy+Math.sin(a)*R*0.78)/CELL)*CELL, CELL-1, CELL-1);
    }
    ctx.globalAlpha=1;
  }
  function pointArrow(x,y,ang,tt){
    const L=BRUSH*8.5, ca=Math.cos(ang), sa=Math.sin(ang), tipx=x+ca*L, tipy=y+sa*L;
    const pulse=(tt*0.9)%1, steps=Math.max(16,Math.round(L/(cell*0.5)));
    for(let i=0;i<=steps;i++){ const f=i/steps, hi=Math.exp(-Math.pow((f-pulse)*3.0,2)); dep(x+ca*L*f,y+sa*L*f,0.5+0.46*hi,0.95); }
    const hl=BRUSH*3.4;
    for(let s=-1;s<=1;s+=2){
      const ba=ang+Math.PI+s*0.62, bsteps=Math.max(8,Math.round(hl/(cell*0.5)));
      for(let j=0;j<=bsteps;j++){ const g=j/bsteps; dep(tipx+Math.cos(ba)*hl*g, tipy+Math.sin(ba)*hl*g, 0.72, 0.95); }
    }
  }

  /* waves: angular ring stamp — O(steps) not O(cells) */
  function stampWave(wv, age){
    const pw=wv.pow||1;
    const R=age*Math.hypot(W,H)*1.7;
    const sig=cell*5.5*pw;
    const amp=Math.max(0,1-age/1.5)*1.2*pw;
    if(amp<0.02||R<cell) return;
    const steps=Math.max(20, Math.min(96, Math.ceil(2*Math.PI*R/(cell*1.1))));
    const brush=Math.max(cell*0.7, sig*0.42);
    for(let i=0;i<steps;i++){
      const a=(i/steps)*Math.PI*2;
      dep(wv.x+Math.cos(a)*R, wv.y+Math.sin(a)*R, amp*0.9, brush);
    }
  }

  let coinOn=false, coinx=0, coiny=0, rang=0, lastScroll=-9;
  function wanderRoulette(restx,resty){
    if(!coinOn){ coinOn=true; coinx=restx; coiny=resty; rang=0; }
    rang+=0.012;
  }
  function isPageStill(ns){ return ns-lastScroll>0.35; }

  const headEls=[].slice.call(document.querySelectorAll("[data-blobarrow]"));
  const smileyEls=[].slice.call(document.querySelectorAll("#moods .smiley")).map(el=>{
    const base=el.getAttribute("data-base");
    return {el, val: base==="#FF4D2E"?0.9:(base==="#FFC107"?0.72:0.55)};
  });
  const L={cutY:0, heroBottom:0, swap:null, marq:null, heads:[], smileys:[]};

  function markLayout(){ layoutDirty=true; }
  function refreshLayout(){
    if(!layoutDirty) return;
    layoutDirty=false;
    const hb=hero?hero.getBoundingClientRect():{bottom:H};
    const hr=heroHead?heroHead.getBoundingClientRect():{bottom:0};
    L.cutY=Math.max(0, hr.bottom);
    L.heroBottom=hb.bottom;
    L.swap=swap?swap.getBoundingClientRect():null;
    L.marq=marq?marq.getBoundingClientRect():null;
    L.heads.length=0;
    for(const el of headEls){
      const r=el.getBoundingClientRect();
      if(r.width<2) continue;
      L.heads.push({l:r.left, r:r.right, t:r.top, b:r.bottom, cx:r.left+r.width*.5, cy:r.top+r.height*.5});
    }
    L.smileys.length=0;
    for(const s of smileyEls){
      const r=s.el.getBoundingClientRect();
      if(r.width<2) continue;
      L.smileys.push({cx:r.left+r.width*.5, cy:r.top+r.height*.5, w:r.width, top:r.top, bottom:r.bottom, val:s.val});
    }
  }

  function zoneOf(el){
    if(!el||!el.closest) return "";
    if(el.closest("#odds, #swap, .swap, #roulette")) return "coin";
    return "";
  }
  function nearHeadline(x,y){
    let best=null, bd=1e9, M=150;
    for(const h of L.heads){
      if(h.b<-40||h.t>H+40) continue;
      if(x<h.l-M||x>h.r+M||y<h.t-M||y>h.b+M) continue;
      const d=Math.hypot(x-h.cx,y-h.cy);
      if(d<bd){ bd=d; best=h; }
    }
    return best;
  }

  addEventListener("pointermove", e=>{
    if(TOUCH) return;
    lastMove=performance.now()/1000; coinOn=false;
    mx=e.clientX; my=e.clientY; hov=true;
    cursorZone=zoneOf(e.target);
  });
  addEventListener("scroll", ()=>{
    lastScroll=performance.now()/1000;
    lastMove=lastScroll;
    coinOn=false;
    markLayout();
  },{passive:true});
  addEventListener("resize", markLayout);
  addEventListener("dblclick", e=>{
    if(TOUCH) return;
    if(e.target.closest&&e.target.closest("a,button,input,.swap,.plinko")) return;
    waves.push({x:e.clientX,y:e.clientY,t0:performance.now()/1000,pow:2.4});
    dep(e.clientX,e.clientY,1,BRUSH*18); shake=2.0;
  });

  window.__pxStampDisk=stampDisk;
  window.__hookedBurst=(x,y,pow)=>{
    waves.push({x,y,t0:performance.now()/1000,pow:pow||2});
    dep(x,y,1,BRUSH*(8+pow*5)); shake=Math.max(shake,1.2);
  };

  /* scrolling marquee text into heat field */
  const TXT=" you might win · stay hooked · loot on every swap · ";
  const txtC=document.createElement("canvas"), txc=txtC.getContext("2d");
  let txtW=0, TXH=18, txtCols=null, txtScroll=0;
  function buildTxt(){
    txc.font='16px "Sneak",monospace';
    txtW=Math.max(8,Math.ceil(txc.measureText(TXT).width));
    txtC.width=txtW; txtC.height=TXH;
    txc.font='16px "Sneak",monospace'; txc.textBaseline="middle"; txc.fillStyle="#000";
    txc.clearRect(0,0,txtW,TXH); txc.fillText(TXT,0,TXH/2);
    const data=txc.getImageData(0,0,txtW,TXH).data;
    /* precompute solid pixel rows per column — skip empty alpha scans */
    txtCols=new Array(txtW);
    for(let mc=0;mc<txtW;mc++){
      const rows=[];
      for(let lr=0;lr<TXH;lr++){
        if(data[(lr*txtW+mc)*4+3]>80) rows.push(lr);
      }
      txtCols[mc]=rows;
    }
  }
  function stampText(cy){
    if(!txtCols) buildTxt();
    const so=Math.floor(txtScroll);
    const br=Math.round(cy/cell)-(TXH>>1);
    for(let lc=0;lc<cols;lc++){
      const mc=(((so+lc)%txtW)+txtW)%txtW;
      const solid=txtCols[mc];
      for(let i=0;i<solid.length;i++){
        const R=br+solid[i]; if(R<0||R>=rows) continue;
        const id=R*cols+lc, ww=0.78+0.14*Math.sin((lc*0.6+solid[i]*0.6)-t*0.006);
        if(ww>heat[id]) heat[id]=ww;
      }
    }
  }

  let introT=0;

  function render(ts){
    raf=0;
    if(!want()) return;
    if(!lastTs) lastTs=ts;
    const d=Math.min(48, ts-lastTs); lastTs=ts; t+=d; introT+=d/1000;
    const tt=t*0.001, ns=performance.now()/1000;
    refreshLayout();
    const cutY=L.cutY;
    const heroBottomScreen=L.heroBottom;

    for(let i=0;i<heat.length;i++){ const v=heat[i]*0.878; heat[i]=v<.003?0:v; }

    if(hov&&mx>0&&!TOUCH&&my>=cutY){
      const hd=nearHeadline(mx,my), idle=ns-lastMove, still=isPageStill(ns);
      if(hd){
        if(idle<2.4){ pointArrow(mx,my,Math.atan2(hd.cy-my,hd.cx-mx),ns); pmx=mx; pmy=my; }
        else if(still) wanderRoulette(mx,my);
        else coinOn=false;
      } else if(cursorZone==="coin"){
        follow(mx,my,BRUSH*0.85); stampCoin(mx,my);
        coinOn=false;
      } else {
        let sg=null, sp=0;
        for(const s of L.smileys){
          if(s.bottom<-40||s.top>H+40) continue;
          const GR=s.w*1.9;
          const qp=1-Math.hypot(mx-s.cx,my-s.cy)/GR;
          if(qp>sp){ sp=qp; sg={cx:s.cx,cy:s.cy,rad:s.w*0.46,val:s.val}; }
        }
        if(sg&&sp>0){
          const e=sp*sp*(3-2*sp);
          const bx=mx+(sg.cx-mx)*e, by=my+(sg.cy-my)*e;
          if(e<0.82) dep(bx,by,0.13,BRUSH*(1-0.5*e));
          if(sp>0.16) stampDisk(sg.cx,sg.cy,sg.rad*e,sg.val);
          pmx=mx; pmy=my;
          coinOn=false;
        } else if(idle>1.6 && still){
          wanderRoulette(mx,my);
        } else {
          coinOn=false;
          follow(mx,my, my>heroBottomScreen?BRUSH*0.45:BRUSH);
        }
      }
    } else if(my<cutY){
      pmx=-1; pmy=-1; coinOn=false;
    }

    for(let wi=waves.length-1;wi>=0;wi--){
      const wv=waves[wi], age=ns-wv.t0;
      if(age>1.5){ waves.splice(wi,1); continue; }
      stampWave(wv, age);
    }

    if(L.marq && L.marq.bottom>0 && L.marq.top<H){
      txtScroll+=0.16;
      stampText(L.marq.top+L.marq.height*0.55);
    }

    if(L.swap){
      const sr=L.swap, pad=12;
      const c0=Math.floor((sr.left-pad)/cell), c1=Math.ceil((sr.right+pad)/cell);
      const r0=Math.floor((sr.top-pad)/cell), r1=Math.ceil((sr.bottom+pad)/cell);
      for(let r=r0;r<=r1;r++) for(let c=c0;c<=c1;c++){
        if(c>=0&&r>=0&&c<cols&&r<rows) heat[r*cols+c]=0;
      }
    }
    {
      const r1=Math.ceil(cutY/cell);
      for(let r=0;r<=r1&&r<rows;r++){
        heat.fill(0, r*cols, r*cols+cols);
      }
    }

    ctx.save();
    if(shake>0.01){ shake*=0.9; ctx.translate((Math.random()-0.5)*shake*16,(Math.random()-0.5)*shake*16); } else shake=0;
    ctx.fillStyle="#fff"; ctx.fillRect(-40,-40,W+80,H+80);

    const sy=TOUCH?0:scrollY, off=sy-Math.floor(sy/cell)*cell, s=cell-1;
    const gridTop=Math.max(0, cutY);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, gridTop, W, H-gridTop+40);
    ctx.clip();
    ctx.strokeStyle="#fafafa"; ctx.lineWidth=1; ctx.beginPath();
    for(let gx=0;gx<=W;gx+=cell){ ctx.moveTo(gx+.5,gridTop); ctx.lineTo(gx+.5,H); }
    for(let gy=gridTop-(((gridTop+off)%cell+cell)%cell); gy<=H; gy+=cell){
      ctx.moveTo(0,gy+.5); ctx.lineTo(W,gy+.5);
    }
    ctx.stroke();

    const intro=Math.min(1,introT/1.6);
    const cutDoc=cutY+sy;
    const heroBottom=heroBottomScreen+sy;
    const fieldH=Math.max(1, heroBottom-cutDoc);
    const heroEnd=cutDoc+fieldH*0.72;
    const fadeSpan=Math.max(1, fieldH*0.28);
    const hAmp=H*0.14;
    const drStart=Math.floor((sy+gridTop)/cell)-1, drEnd=Math.floor((sy+H)/cell)+1;
    const tPulse=tt*1.7;
    for(let i=0;i<4;i++) buckets[i].length=0;

    for(let dr=drStart; dr<=drEnd; dr++){
      const vy=dr*cell-sy;
      if(vy+s<=gridTop) continue;
      const vr=Math.floor((vy+cell*0.5)/cell), inRow=(vr>=0&&vr<rows);
      const dd=dr*cell;
      const hRow=hsh(0,(dr/4)|0);
      for(let c2=0;c2<cols;c2++){
        const co=colCo[c2]+hshA[c2]*0.6*hRow;
        const depthN=dd+co*hAmp;
        const regThr=depthN<=cutDoc?1:(depthN<=heroEnd?0:Math.min(1,(depthN-heroEnd)/fadeSpan));

        let v=inRow?heat[vr*cols+c2]*0.9:0;
        if(regThr<1){
          const nx=c2*cell*invW, ny=dr*cell*invH;
          if(region(nx,ny,tt)>regThr && hsh(c2*1.7+11.3, dr*1.3+5.1)<intro){
            v+=base(nx,ny,tt)+(hsh(c2,dr)-0.5)*0.12+Math.sin((c2*0.6+dr*0.8)+tPulse)*0.045;
          }
        }
        if(v<0.30) continue;
        let bi=0;
        if(v>=BANDS[1][0]) bi=1;
        if(v>=BANDS[2][0]) bi=2;
        if(v>=BANDS[3][0]) bi=3;
        if(v>=0.86&&v<1.02) bi=2;
        buckets[bi].push(c2*cell, vy);
      }
    }
    for(let bi=0;bi<4;bi++){
      const b=buckets[bi];
      if(!b.length) continue;
      ctx.fillStyle=DRAW_COLS[bi];
      for(let i=0;i<b.length;i+=2) ctx.fillRect(b[i], b[i+1], s, s);
    }
    ctx.restore();

    if(coinOn){
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, gridTop, W, H-gridTop+40);
      ctx.clip();
      drawIdleRoulette(coinx, coiny, rang);
      ctx.restore();
    }
    ctx.restore();
    if(want()) raf=requestAnimationFrame(render);
  }
  kick();
})();

/* ===== roulette pixel wheel ===== */
(function(){
  const cv=document.getElementById("roulette-cv");
  const ctx=cv&&cv.getContext("2d"); if(!ctx) return;
  const DPR=Math.min(devicePixelRatio||1,2), CELL=8;
  const COLS=["#0B3D3A","#00D4AA","#FFC107","#FF4D2E","#00D4AA","#FFC107"];
  let W=0,H=0,inView=true, ang=0, spin=0.01, pmx=0,pmy=0,pstr=0,ptgt=0, raf=0;

  function want(){ return inView && !document.hidden; }
  function kick(){ if(raf||!want()) return; raf=requestAnimationFrame(loop); }
  function stop(){ if(raf){ cancelAnimationFrame(raf); raf=0; } }
  function sync(){ if(want()) kick(); else stop(); }

  function size(){
    const r=cv.getBoundingClientRect(); if(r.width<2) return;
    W=r.width; H=r.height;
    cv.width=Math.round(W*DPR); cv.height=Math.round(H*DPR);
    ctx.setTransform(DPR,0,0,DPR,0,0);
  }
  size();
  if(window.ResizeObserver) new ResizeObserver(size).observe(cv);
  if("IntersectionObserver" in window)
    new IntersectionObserver(es=>{
      inView=es.some(e=>e.isIntersecting);
      sync();
    }).observe(cv);
  document.addEventListener("visibilitychange", sync);

  cv.addEventListener("pointermove", e=>{
    const r=cv.getBoundingClientRect();
    pmx=e.clientX-r.left; pmy=e.clientY-r.top; ptgt=1;
    spin=Math.min(0.045, spin+0.002);
  },{passive:true});
  cv.addEventListener("pointerleave",()=>{ ptgt=0; });

  function frame(){
    if(!W) return;
    ctx.clearRect(0,0,W,H);
    pstr+=(ptgt-pstr)*0.08;
    spin+=(0.01-spin)*0.02;
    ang+=spin;

    const cx=W*0.5, cy=H*0.55;
    const R=Math.min(W*0.38, H*0.7);
    const segs=24;

    for(let i=0;i<segs*2;i++){
      const a=ang*0.5+i/(segs*2)*Math.PI*2;
      const x=cx+Math.cos(a)*R*1.08;
      const y=cy+Math.sin(a)*R*0.7;
      ctx.globalAlpha=0.25+0.25*Math.sin(ang*4+i);
      ctx.fillStyle=COLS[i%COLS.length];
      ctx.fillRect(Math.round(x/CELL)*CELL, Math.round(y/CELL)*CELL, CELL-1, CELL-1);
    }

    for(let i=0;i<segs;i++){
      const a0=ang+i/segs*Math.PI*2;
      const a1=ang+(i+0.78)/segs*Math.PI*2;
      const col=COLS[i%COLS.length];
      for(let u=0;u<1;u+=0.035){
        for(let rad=0.42; rad<=1; rad+=0.065){
          const a=a0+(a1-a0)*u;
          let x=cx+Math.cos(a)*R*rad;
          let y=cy+Math.sin(a)*R*rad*0.68;
          if(pstr>0.02){
            const dx=x-pmx, dy=y-pmy, d=Math.hypot(dx,dy)+0.001;
            const RAD=Math.min(W,H)*0.26;
            if(d<RAD){
              const f=(1-d/RAD); const ff=f*f*pstr;
              x+=dx/d*ff*RAD*0.85; y+=dy/d*ff*RAD*0.85;
            }
          }
          ctx.globalAlpha=0.3+rad*0.5;
          ctx.fillStyle=col;
          ctx.fillRect(Math.round(x/CELL)*CELL, Math.round(y/CELL)*CELL, CELL-1, CELL-1);
        }
      }
    }

    const ma=-Math.PI/2;
    const bx=cx+Math.cos(ma)*R*1.02;
    const by=cy+Math.sin(ma)*R*0.68;
    ctx.globalAlpha=1;
    ctx.fillStyle="#0A0A0A";
    ctx.fillRect(Math.round(bx/CELL)*CELL-CELL, Math.round(by/CELL)*CELL-CELL, CELL*2-1, CELL*2-1);
    ctx.fillStyle="#FFC107";
    ctx.fillRect(Math.round(bx/CELL)*CELL, Math.round(by/CELL)*CELL, CELL-1, CELL-1);

    for(let r=0;r<3;r++){
      for(let a=0;a<8;a++){
        const ang2=a/8*Math.PI*2+ang*0.3;
        const x=cx+Math.cos(ang2)*CELL*(r+0.5);
        const y=cy+Math.sin(ang2)*CELL*(r+0.5)*0.7;
        ctx.globalAlpha=0.5;
        ctx.fillStyle=r===0?"#0A0A0A":COLS[a%COLS.length];
        ctx.fillRect(Math.round(x/CELL)*CELL, Math.round(y/CELL)*CELL, CELL-1, CELL-1);
      }
    }
    ctx.globalAlpha=1;
  }
  function loop(){
    raf=0;
    if(!want()) return;
    frame();
    if(want()) raf=requestAnimationFrame(loop);
  }
  kick();
})();

/* ===== smileys ===== */
(function(){
  const NS="http://www.w3.org/2000/svg";
  const COIN=[[1,0],[2,0],[0,1],[1,1],[2,1],[3,1],[0,2],[1,2],[2,2],[3,2],[1,3],[2,3]];
  const TOUCH=!(window.matchMedia&&matchMedia("(hover:hover) and (pointer:fine)").matches);
  const faces=[];
  let facesInView=true, raf=0;
  function want(){
    return !TOUCH && !document.hidden && facesInView && faces.length>0;
  }
  function kick(){ if(raf||!want()) return; raf=requestAnimationFrame(loop); }
  function stop(){ if(raf){ cancelAnimationFrame(raf); raf=0; } }
  function sync(){ if(want()) kick(); else stop(); }
  document.addEventListener("visibilitychange", sync);
  function coinSVG(){
    const s=document.createElementNS(NS,"svg"); s.setAttribute("viewBox","0 0 4 4"); s.setAttribute("width","18"); s.setAttribute("height","18");
    for(const p of COIN){ const r=document.createElementNS(NS,"rect"); r.setAttribute("x",p[0]); r.setAttribute("y",p[1]); r.setAttribute("width","1"); r.setAttribute("height","1"); r.setAttribute("fill","#FFC107"); s.appendChild(r); }
    return s;
  }
  let ptr={x:-1,y:-1};
  addEventListener("pointermove",e=>{
    ptr.x=e.clientX; ptr.y=e.clientY;
    if(want()) kick();
  },{passive:true});

  function bindSmiley(sv){
    if(!sv||sv.__hookedBound) return;
    sv.__hookedBound=true;
    const mood=sv.getAttribute("data-mood")||"happy";
    const g=document.createElementNS(NS,"g"); sv.appendChild(g);
    function rect(c,r,fill){
      const e=document.createElementNS(NS,"rect");
      e.setAttribute("x",c*12); e.setAttribute("y",r*12);
      e.setAttribute("width",12); e.setAttribute("height",12);
      e.setAttribute("fill",fill||"#0a0a0a"); g.appendChild(e); return e;
    }
    rect(4,5,"#FFC107"); rect(8,5,"#FFC107");
    const pupilL=rect(4,5), pupilR=rect(8,5);
    pupilL.setAttribute("width",6); pupilL.setAttribute("height",6); pupilL.setAttribute("x",4*12+3); pupilL.setAttribute("y",5*12+3);
    pupilR.setAttribute("width",6); pupilR.setAttribute("height",6); pupilR.setAttribute("x",8*12+3); pupilR.setAttribute("y",5*12+3);
    const blush=[];
    if(mood==="sad"){
      rect(5,7); rect(6,7); rect(7,7); rect(4,8); rect(8,8);
      [[3,7],[9,7]].forEach(p=>{ const e=rect(p[0],p[1],"#FF4D2E"); e.setAttribute("fill-opacity","0"); blush.push(e); });
    } else if(mood==="neutral"){
      rect(4,7); rect(5,7); rect(6,7); rect(7,7); rect(8,7);
    } else {
      rect(4,7); rect(8,7); rect(5,8); rect(6,8); rect(7,8);
    }
    const f={sv,g,pupilL,pupilR,blush,mood,lx:0,ly:0,shy:false,hot:false};
    faces.push(f);
    scheduleBlink(f);
    sync();
    if(TOUCH) return;
    if(mood==="sad"){
      sv.addEventListener("mouseenter",()=>{ f.shy=true; f.hot=true; sv.classList.add("sm-shy"); blush.forEach(e=>e.setAttribute("fill-opacity",".5")); });
      sv.addEventListener("mouseleave",()=>{ f.shy=false; f.hot=false; sv.classList.remove("sm-shy"); blush.forEach(e=>e.setAttribute("fill-opacity","0")); });
    } else {
      let busy=false;
      sv.addEventListener("mouseenter",()=>{
        f.hot=true; if(busy) return; busy=true; setTimeout(()=>busy=false,620);
        sv.classList.remove("sm-jump"); void sv.offsetWidth; sv.classList.add("sm-jump");
        const host=sv.closest(".face-slot, .c")||sv.parentNode;
        for(let i=0;i<4;i++) setTimeout(()=>{
          const h=coinSVG(); h.setAttribute("class","sm-coin");
          h.style.left=(38+Math.random()*52)+"%"; h.style.top="6px";
          host.appendChild(h); setTimeout(()=>h.remove(),1000);
        },i*90);
      });
      sv.addEventListener("mouseleave",()=>{ f.hot=false; });
    }
  }
  function blink(f){
    if(!f.sv.isConnected) return;
    f.pupilL.setAttribute("height",2); f.pupilR.setAttribute("height",2);
    setTimeout(()=>{ if(f.sv.isConnected){ f.pupilL.setAttribute("height",6); f.pupilR.setAttribute("height",6); } },110);
  }
  function scheduleBlink(f){
    setTimeout(()=>{ if(!f.sv.isConnected) return; blink(f); scheduleBlink(f); },2200+Math.random()*4200);
  }

  function loop(){
    raf=0;
    if(!want()) return;
    for(let i=faces.length-1;i>=0;i--){ if(!faces[i].sv.isConnected) faces.splice(i,1); }
    if(ptr.x>=0){
      for(const f of faces){
        const r=f.sv.getBoundingClientRect(); if(r.width<2) continue;
        const cx=r.left+r.width/2, cy=r.top+r.height/2;
        const dx=ptr.x-cx, dy=ptr.y-cy, d=Math.hypot(dx,dy)||1;
        let tx,ty;
        if(f.shy){ tx=-dx/d*7; ty=-dy/d*7+2.5; }
        else { const m=Math.min(1,d/420)*5.5; tx=dx/d*m; ty=dy/d*m; }
        f.lx+=(tx-f.lx)*0.15; f.ly+=(ty-f.ly)*0.15;
        f.g.setAttribute("transform",`translate(${f.lx.toFixed(2)},${f.ly.toFixed(2)})`);
        if(f.hot&&window.__pxStampDisk){
          const val=f.mood==="sad"?0.9:(f.mood==="neutral"?0.72:0.55);
          window.__pxStampDisk(cx,cy,r.width*0.48, val);
        }
      }
    }
    if(want()) raf=requestAnimationFrame(loop);
  }

  document.querySelectorAll("#moods .smiley").forEach(bindSmiley);
  window.__bindSmiley=bindSmiley;

  const moodRoot=document.getElementById("moods");
  const winsRoot=document.getElementById("winsList");
  if("IntersectionObserver" in window){
    const seen=new Map();
    const io=new IntersectionObserver(es=>{
      for(const e of es) seen.set(e.target, e.isIntersecting);
      facesInView=[...seen.values()].some(Boolean);
      sync();
    },{root:null, threshold:0, rootMargin:"40px 0px"});
    if(moodRoot){ seen.set(moodRoot,false); io.observe(moodRoot); }
    if(winsRoot){ seen.set(winsRoot,false); io.observe(winsRoot); }
  }
  kick();
})();

/* button pixel flicker */
(function(){
  const ACC=["#00D4AA","#FFC107","#FF4D2E","#0a0a0a"], CELL=9;
  const b=document.getElementById("swapBtn"); if(!b) return;
  const fx=b.querySelector(".pxfx"); let cells=[], timer=null;
  function build(){
    fx.textContent=""; cells=[];
    const cols=Math.ceil(b.offsetWidth/CELL)||1, rows=Math.ceil(b.offsetHeight/CELL)||1;
    fx.style.gridTemplateColumns=`repeat(${cols},${CELL}px)`; fx.style.gridAutoRows=`${CELL}px`;
    for(let i=0;i<cols*rows;i++) cells.push(fx.appendChild(document.createElement("i")));
  }
  build(); if(window.ResizeObserver) new ResizeObserver(build).observe(b);
  function tick(){ for(const c of cells) c.style.background=Math.random()<0.14?ACC[(Math.random()*ACC.length)|0]:"transparent"; }
  function clear(){ for(const c of cells) c.style.background="transparent"; }
  b.addEventListener("mouseenter",()=>{ if(timer)return; tick(); timer=setInterval(tick,120); });
  b.addEventListener("mouseleave",()=>{ clearInterval(timer); timer=null; clear(); });
})();

/* ===== PIXEL PLINKO ===== */
let plinkoEl, pcv, pctx, pkPhase, pkMult, pkAmt, pkClose, plinkoLive, plinkoBox;
let pkAnim=null;
function bindPlinkoDom(){
  plinkoEl=document.getElementById("plinko");
  pcv=document.getElementById("plinko-cv");
  pctx=pcv&&pcv.getContext("2d");
  pkPhase=document.getElementById("pkPhase");
  pkMult=document.getElementById("pkMult");
  pkAmt=document.getElementById("pkAmt");
  pkClose=document.getElementById("pkClose");
  plinkoLive=document.getElementById("plinkoLive");
  plinkoBox=plinkoEl&&plinkoEl.querySelector(".plinko-box");
  return !!(plinkoEl&&pcv&&pctx&&plinkoBox&&pkPhase&&pkMult&&pkAmt&&pkClose&&plinkoLive);
}
if(!bindPlinkoDom()) {
  window.__startLootDrop = function(){};
  window.__startLootWaiting = function(){};
  window.__setLootWaitingPhase = function(){};
  window.__closePlinko = function(){};
} else {

function clearJackHit(){
  if(!plinkoBox||!pkPhase) return;
  plinkoBox.classList.remove("jack-hit");
  pkPhase.classList.remove("jack");
}

function resetPlinkoUi(phase, live, waiting){
  if(!bindPlinkoDom()) return;
  plinkoEl.classList.add("on");
  plinkoBox.classList.toggle("is-wait", !!waiting);
  clearJackHit();
  pkMult.className="mult"; pkMult.textContent="—";
  pkAmt.className="amt"; pkAmt.textContent="";
  pkClose.className="again";
  pkPhase.className=waiting?"phase wait":"phase";
  pkPhase.textContent=phase;
  plinkoLive.textContent=live;
}

const PK_CELL=8;
const PK_PEG_ROWS=17;

function sizePlinkoCanvas(){
  const dpr=Math.min(devicePixelRatio||1,2);
  const cssW=Math.min(460, plinkoBox.clientWidth||460);
  const cssH=Math.round(cssW*1.18);
  pcv.width=Math.round(cssW*dpr);
  pcv.height=Math.round(cssH*dpr);
  pcv.style.width=cssW+"px";
  pcv.style.height=cssH+"px";
  pctx.setTransform(dpr,0,0,dpr,0,0);
  return {W:cssW, H:cssH};
}

function layoutPlinkoBoard(W, H){
  const nPockets=POCKETS.length;
  const marginX=20, boardTop=22, boardBot=H-78;
  const pegCols=Math.max(10, nPockets*2);
  const pocketW=(W-marginX*2)/nPockets;
  const pegs=[];
  const pegSpanY=boardBot-boardTop-56;
  for(let row=0;row<PK_PEG_ROWS;row++){
    const even=row%2===0;
    const n=even?pegCols:pegCols-1;
    const y=boardTop+20+row*(pegSpanY/(PK_PEG_ROWS-1));
    const offset=even?0:((W-marginX*2)/pegCols)/2;
    const span=(W-marginX*2)-(even?0:(W-marginX*2)/pegCols);
    for(let i=0;i<n;i++) pegs.push({x:marginX+offset+(i+0.5)*span/n, y});
  }
  return {W, H, nPockets, marginX, boardTop, boardBot, pocketW, pegs};
}

function drawPlinkoField(board, activeIndex){
  const {W, H, nPockets, marginX, boardBot, pocketW, pegs}=board;
  const CELL=PK_CELL;
  pctx.clearRect(0,0,W,H);
  pctx.fillStyle="#fff"; pctx.fillRect(0,0,W,H);
  pctx.strokeStyle="#f3f3f3"; pctx.lineWidth=1; pctx.beginPath();
  for(let x=0;x<=W;x+=CELL){ pctx.moveTo(x+.5,0); pctx.lineTo(x+.5,H); }
  for(let y=0;y<=H;y+=CELL){ pctx.moveTo(0,y+.5); pctx.lineTo(W,y+.5); }
  pctx.stroke();
  for(const p of pegs){
    pctx.fillStyle="#0A0A0A";
    pctx.fillRect(Math.round(p.x/CELL)*CELL, Math.round(p.y/CELL)*CELL, Math.max(3, CELL-4), Math.max(3, CELL-4));
  }
  for(let i=0;i<nPockets;i++){
    const x0=marginX+i*pocketW;
    const x1=marginX+(i+1)*pocketW;
    const active=activeIndex!=null&&i===activeIndex;
    const col=POCKETS[i].col;
    const c0=Math.floor(x0/CELL), c1=Math.floor((x1-0.001)/CELL);
    for(let yy=0;yy<36;yy+=CELL){
      for(let c=c0;c<=c1;c++){
        pctx.fillStyle=active?col:"#f0f0f0";
        pctx.globalAlpha=active?0.88:1;
        pctx.fillRect(c*CELL, Math.round((boardBot+yy)/CELL)*CELL, CELL-1, CELL-1);
      }
    }
    pctx.globalAlpha=1;
    pctx.fillStyle="#0A0A0A";
    pctx.font='500 10px "Sneak",sans-serif';
    pctx.textAlign="center";
    pctx.fillText(POCKETS[i].mult+"×", (x0+x1)/2, boardBot+24);
    pctx.fillStyle=col;
    pctx.globalAlpha=active?1:0.85;
    pctx.fillRect(Math.round(((x0+x1)/2-4)/CELL)*CELL, Math.round((boardBot+30)/CELL)*CELL, CELL-1, CELL-1);
    pctx.globalAlpha=1;
  }
}

function lootWaitLive(info){
  const round=info&&info.targetRound>0?Math.floor(info.targetRound):0;
  if(info&&info.confirming) return "confirm settle…";
  if(info&&info.ready) return "waiting for settle…";
  if(round) return `waiting for oracle round ${round}…`;
  return "waiting for oracle…";
}

function showPlinkoWaiting(info){
  cancelAnimationFrame(pkAnim);
  resetPlinkoUi("settling on-chain…", lootWaitLive(info), true);
  if(!bindPlinkoDom()) return;
  const {W, H}=sizePlinkoCanvas();
  drawPlinkoField(layoutPlinkoBoard(W, H), null);
}

function setPlinkoWaitingPhase(info){
  if(!bindPlinkoDom()||!plinkoEl.classList.contains("on")||!plinkoBox.classList.contains("is-wait")) return;
  plinkoLive.textContent=lootWaitLive(info);
}

function runPlinko(drop){
  if(!bindPlinkoDom()) return;
  const pocketIndex=Math.max(0, Math.min(POCKETS.length-1, drop.pocketIndex|0));
  const result=POCKETS[pocketIndex];
  const out=Number.isFinite(drop.hookedOut)?drop.hookedOut:0;
  const jackUsd=Number(drop.jackpotUsd)||0;
  window.__pendingJackpot=!!drop.jackpot;
  resetPlinkoUi("ball in play…","falling…", false);

  const {W, H}=sizePlinkoCanvas();
  const board=layoutPlinkoBoard(W, H);
  const {nPockets, marginX, boardTop, boardBot, pocketW, pegs}=board;
  const CELL=PK_CELL;
  const ballR=3.6, pegR=2.0;
  /* gentler gravity + softer hits — denser steps feel smoother */
  const G=0.085, DRAG=0.9988, REST=0.68, WALL=0.78;
  const pocketFloor=boardBot+20;

  const targetX=marginX+(pocketIndex+0.5)*pocketW;
  const nearLines=["almost…","come on…","drift…","hold…","so close…","stay…"];

  function mulberry32(a){
    return function(){
      a|=0; a=a+0x6D2B79F5|0;
      let t=Math.imul(a^a>>>15,1|a);
      t=t+Math.imul(t^t>>>7,61|t)^t;
      return ((t^t>>>14)>>>0)/4294967296;
    };
  }

  function appendSink(trail, fromX, fromY){
    /* ease into pocket center, then drop through the basket floor */
    const steps=42;
    for(let i=1;i<=steps;i++){
      const t=i/steps;
      const easeX=1-Math.pow(1-Math.min(1,t*1.15),3);
      const fall=t*t*(0.55+0.45*t);
      const bob=t>0.72?Math.sin((t-0.72)*18)*1.2*(1-t):0;
      trail.push({
        x:fromX+(targetX-fromX)*easeX,
        y:fromY+(pocketFloor-fromY)*fall+bob,
        sink:t>0.35?1:0
      });
    }
  }

  /* honest gravity + elastic peg hits; optional bias only on impact (search), never a magnet */
  function simulate(rng, bias){
    let x=W*0.5+(rng()-0.5)*22;
    let y=14;
    let vx=(rng()-0.5)*0.85;
    let vy=0.2;
    const trail=[];
    const maxSteps=2200;
    const hitMin=ballR+pegR;

    for(let s=0;s<maxSteps;s++){
      /* 2 substeps → smoother arcs between recorded points */
      for(let sub=0;sub<2;sub++){
        vy+=G*0.5;
        vx*=Math.sqrt(DRAG); vy*=Math.sqrt(DRAG);
        x+=vx*0.5; y+=vy*0.5;

        if(x<marginX+ballR){ x=marginX+ballR; vx=Math.abs(vx)*WALL; }
        if(x>W-marginX-ballR){ x=W-marginX-ballR; vx=-Math.abs(vx)*WALL; }

        for(let pi=0;pi<pegs.length;pi++){
          const p=pegs[pi];
          const dx=x-p.x, dy=y-p.y;
          const dist=Math.hypot(dx,dy);
          if(dist>=hitMin||dist<1e-4) continue;
          const nx=dx/dist, ny=dy/dist;
          x=p.x+nx*hitMin;
          y=p.y+ny*hitMin;
          const vn=vx*nx+vy*ny;
          if(vn<0){
            vx-=(1+REST)*vn*nx;
            vy-=(1+REST)*vn*ny;
          }
          const want=Math.sign(targetX-x)||(rng()<0.5?1:-1);
          if(rng()<bias){
            const kick=0.28+rng()*0.55;
            if(Math.sign(vx)!==want||Math.abs(vx)<0.28) vx=want*kick;
            else vx+=want*0.12;
          } else {
            vx+=(rng()-0.5)*0.38;
          }
        }
      }

      trail.push({x,y,sink:0});

      if(y>=boardBot-ballR){
        x=Math.max(marginX+ballR, Math.min(W-marginX-ballR, x));
        y=boardBot-ballR;
        const landIdx=Math.max(0, Math.min(nPockets-1, Math.floor((x-marginX)/pocketW)));
        return {trail, landIdx, landX:x, landY:y};
      }
    }
    const landIdx=Math.max(0, Math.min(nPockets-1, Math.floor((x-marginX)/pocketW)));
    return {trail, landIdx, landX:x, landY:y};
  }

  function findPath(){
    let best=null, bestDist=1e9;
    for(let attempt=0; attempt<180; attempt++){
      const rng=mulberry32((Math.random()*0x7fffffff)|0);
      const bias=Math.min(0.9, attempt*0.009);
      const sim=simulate(rng, bias);
      const dist=Math.abs(sim.landX-targetX);
      if(sim.landIdx===pocketIndex){
        appendSink(sim.trail, sim.landX, sim.landY);
        return sim.trail;
      }
      if(dist<bestDist){ bestDist=dist; best=sim; }
    }
    const trail=(best&&best.trail.length)?best.trail.slice():[{x:W/2,y:14,sink:0}];
    const last=trail[trail.length-1];
    appendSink(trail, last.x, last.y||boardBot-ballR);
    return trail;
  }

  const path=findPath();
  let ball={x:path[0].x, y:path[0].y, trail:[], sink:0};
  let settled=false, settleT=0, shown=false, tick=0;
  const reduceMotion=matchMedia("(prefers-reduced-motion: reduce)").matches;
  const rain=[];
  let rainUntil=0;
  const fallStart=performance.now();
  const FALL_MS=reduceMotion?900:Math.max(3400, Math.min(5200, path.length*5.2));

  function samplePath(t){
    const maxI=path.length-1;
    const u=Math.max(0, Math.min(1, t))*maxI;
    const i0=u|0;
    const i1=Math.min(maxI, i0+1);
    const f=u-i0;
    const e=f*f*(3-2*f);
    return {
      x:path[i0].x+(path[i1].x-path[i0].x)*e,
      y:path[i0].y+(path[i1].y-path[i0].y)*e,
      sink:(path[i0].sink||0)*(1-e)+(path[i1].sink||0)*e,
      done:t>=1
    };
  }

  function px(x,y,col,size=CELL-1){
    pctx.fillStyle=col;
    pctx.fillRect(Math.round(x/CELL)*CELL, Math.round(y/CELL)*CELL, size, size);
  }

  function spawnRain(n){
    for(let i=0;i<n;i++){
      const dieY=Math.max(boardTop+80, Math.min(H-6, boardBot+(Math.random()*2-1)*56));
      const fadeLen=(boardBot-boardTop)*(0.35+Math.random()*0.35);
      rain.push({
        x:(Math.random()*1.35-0.175)*W,
        y:-CELL-(Math.random()*H*0.55),
        vx:(Math.random()-0.5)*2.8,
        vy:1.2+Math.random()*4.2,
        col:Math.random()<0.75?"#FFC107":"#0A0A0A",
        dieY,
        fadeStart:dieY-fadeLen,
        life:1
      });
    }
  }

  function startJackRain(){
    if(reduceMotion||rainUntil) return;
    rainUntil=performance.now()+5000;
    spawnRain(28);
  }

  function tickRain(){
    if(!rainUntil && !rain.length) return;
    const now=performance.now();
    const spawning=now<rainUntil;
    if(spawning && tick%2===0) spawnRain(4);
    for(let i=rain.length-1;i>=0;i--){
      const p=rain[i];
      p.x+=p.vx;
      p.y+=p.vy;
      const t=Math.max(0, Math.min(1, (p.y-p.fadeStart)/Math.max(1,p.dieY-p.fadeStart)));
      p.life=1-t*t;
      if(!spawning) p.life-=0.006;
      if(p.y>=p.dieY||p.life<=0.04) rain.splice(i,1);
    }
    if(!spawning && !rain.length) rainUntil=0;
  }

  function draw(){
    tick++;
    drawPlinkoField(board, settled?pocketIndex:null);

    for(let i=0;i<ball.trail.length;i++){
      const tr=ball.trail[i];
      pctx.globalAlpha=i/ball.trail.length*0.35;
      px(tr.x, tr.y, settled?result.col:"#0A0A0A", Math.max(3, CELL-4));
    }
    pctx.globalAlpha=1;

    /* smaller ball — continuous coords for smooth motion */
    const bs=CELL-1;
    const sink=ball.sink||0;
    const squash=1+sink*0.2;
    const bx=ball.x, by=ball.y;
    pctx.fillStyle=settled?result.col:"#0A0A0A";
    pctx.fillRect(bx-bs*0.5*squash, by-bs*0.5/squash, bs*squash, bs/squash);
    pctx.fillStyle="#FFC107";
    pctx.fillRect(bx-1, by-bs*0.5/squash+1, 2, 2);

    for(let i=0;i<rain.length;i++){
      const p=rain[i];
      pctx.globalAlpha=Math.max(0,Math.min(1,p.life));
      px(p.x, p.y, p.col);
    }
    pctx.globalAlpha=1;
  }

  function step(){
    if(!settled){
      const t=(performance.now()-fallStart)/FALL_MS;
      const s=samplePath(t);
      ball.x=s.x; ball.y=s.y; ball.sink=s.sink;
      const last=ball.trail[ball.trail.length-1];
      if(!last || Math.hypot(ball.x-last.x, ball.y-last.y)>CELL*0.45){
        ball.trail.push({x:ball.x,y:ball.y});
        if(ball.trail.length>32) ball.trail.shift();
      }

      const depth=Math.min(1,(ball.y-boardTop)/Math.max(1,boardBot-boardTop));
      if(depth>0.35&&depth<0.92&&s.sink<0.2){
        if(Math.random()<0.02) plinkoLive.textContent=nearLines[(Math.random()*nearLines.length)|0];
        else plinkoLive.textContent="falling…";
      }
      if(s.sink>0.45) plinkoLive.textContent="in…";

      if(s.done){
        ball.x=targetX; ball.y=pocketFloor; ball.sink=1;
        settled=true; settleT=performance.now();
        plinkoLive.textContent="locked";
        pkPhase.textContent="landed";
      }
    } else if(!shown && performance.now()-settleT>180){
      shown=true;
      pkMult.textContent=`${result.mult}×`;
      pkMult.className=`mult show ${result.tier}`;
      pkAmt.textContent=`${fmt(out)} $HOOKED`;
      pkAmt.className="amt show";
      if(window.__hookedBurst){
        const r=plinkoBox.getBoundingClientRect();
        window.__hookedBurst(r.left+r.width/2, r.top+r.height*0.55, window.__pendingJackpot?2.2:1.6);
      }
      if(window.__pendingJackpot){
        window.__pendingJackpot=false;
        /* let multiplier + amount read, then fullscreen jack */
        setTimeout(()=>{
          if(jackUsd>0) window.__setJackRevealTarget?.(jackUsd);
          window.__showJackReveal && window.__showJackReveal();
        }, 700);
      } else {
        pkClose.className="again show";
      }
    }
    tickRain();
    draw();
    pkAnim=requestAnimationFrame(step);
  }
  cancelAnimationFrame(pkAnim);
  pkAnim=requestAnimationFrame(step);
}

// swap click handled by React
function closePlinko(){
  bindPlinkoDom();
  if(plinkoEl) plinkoEl.classList.remove("on");
  if(plinkoBox) plinkoBox.classList.remove("is-wait");
  if(pkPhase) pkPhase.classList.remove("wait");
  clearJackHit();
  cancelAnimationFrame(pkAnim);
  window.dispatchEvent(new CustomEvent("hooked:plinko-closed"));
}
document.addEventListener("click",e=>{
  const t=e.target;
  if(!(t instanceof Element)) return;
  if(t.closest("#pkClose")) closePlinko();
  else if(t.id==="plinko") closePlinko();
});
addEventListener("keydown",e=>{
  if(e.key!=="Escape") return;
  const el=document.getElementById("plinko");
  if(el&&el.classList.contains("on")) closePlinko();
});

/* ===== JACKPOT FULLSCREEN REVEAL ===== */
(function(){
  const el=document.getElementById("jackReveal");
  const amtEl=document.getElementById("jrAmt");
  const cv=document.getElementById("jrPixels");
  if(!el||!amtEl||!cv) return;
  const ctx=cv.getContext("2d");
  if(!ctx) return;
  let TARGET=26838;
  window.__setJackRevealTarget=function(n){ if(n>0) TARGET=n; };
  let raf=0;

  function size(){
    const dpr=Math.min(devicePixelRatio||1,2);
    cv.width=Math.round(innerWidth*dpr);
    cv.height=Math.round(innerHeight*dpr);
    cv.style.width=innerWidth+"px";
    cv.style.height=innerHeight+"px";
    ctx.setTransform(dpr,0,0,dpr,0,0);
  }

  function paintPixels(elapsedMs){
    const W=innerWidth, H=innerHeight, CELL=10;
    const t=elapsedMs*0.001;
    ctx.clearRect(0,0,W,H);
    const cols=["#FFC107","#00D4AA","#FF4D2E","#0B3D3A"];
    for(let y=0;y<H;y+=CELL){
      for(let x=0;x<W;x+=CELL){
        const cx=x/CELL|0, cy=y/CELL|0;
        const h=((Math.sin(cx*12.9898+cy*78.233)*43758.5453)%1+1)%1;
        const nx=x/W-0.5, ny=y/H-0.5;
        const d=Math.hypot(nx*1.4, ny);
        const wave=Math.sin((x+y)*0.04+t*2.4)+Math.sin(x*0.02-t*1.7)+Math.sin(y*0.03+t*1.1);
        if(d>0.2+wave*0.1 && h>0.42) continue;
        ctx.globalAlpha=0.22+0.48*Math.max(0,1-d*1.5);
        ctx.fillStyle=cols[(cx+cy+(t*6|0))%cols.length];
        ctx.fillRect(x,y,CELL-1,CELL-1);
      }
    }
    ctx.globalAlpha=1;
  }

  function fmtMoney(n){
    return "$"+Math.round(n).toLocaleString("en-US");
  }

  window.__showJackReveal=function(){
    size();
    el.classList.add("on");
    amtEl.innerHTML=`<span class="sel">$0</span>`;
    const t0=performance.now();
    const COUNT_MS=4000;
    cancelAnimationFrame(raf);
    function frame(now){
      if(!el.classList.contains("on")) return;
      const elapsed=now-t0;
      paintPixels(elapsed);
      const tc=Math.min(1, Math.max(0,(elapsed-350)/COUNT_MS));
      /* ease-in, a bit snappier than cubic */
      const e=tc*tc;
      amtEl.innerHTML=`<span class="sel">${fmtMoney(TARGET*e)}</span>`;
      if(tc>=1) amtEl.innerHTML=`<span class="sel">${fmtMoney(TARGET)}</span>`;
      raf=requestAnimationFrame(frame);
    }
    raf=requestAnimationFrame(frame);
  };

  window.__hideJackReveal=function(){
    el.classList.remove("on");
    cancelAnimationFrame(raf);
  };

  function dismissJack(){
    window.__hideJackReveal();
    closePlinko();
  }
  const okBtn=document.getElementById("jrOk");
  if(okBtn) okBtn.addEventListener("click", e=>{ e.stopPropagation(); dismissJack(); });
  addEventListener("keydown",e=>{
    if(e.key==="Escape"&&el.classList.contains("on")) dismissJack();
  });
  addEventListener("resize",()=>{ if(el.classList.contains("on")) size(); });
})();


  window.__startLootWaiting = showPlinkoWaiting;
  window.__setLootWaitingPhase = setPlinkoWaitingPhase;
  window.__startLootDrop = function(drop){
    runPlinko(drop);
  };
  window.__closePlinko = closePlinko;
  }
}

export type LootWaitInfo = { targetRound?: number; ready?: boolean; confirming?: boolean }

export function startLootWaiting(info?: LootWaitInfo){
  window.__startLootWaiting?.(info);
}

export function setLootWaitingPhase(info: LootWaitInfo){
  window.__setLootWaitingPhase?.(info);
}

export function startLootDrop(drop: { pocketIndex: number; hookedOut: number; jackpot: boolean; jackpotUsd?: number }){
  window.__startLootDrop?.(drop);
}

export function closeLootDrop(){
  window.__closePlinko?.();
}

export function destroyHomeFx(){
  for (const fn of cleanups) try { fn(); } catch {}
  cleanups = [];
}

export function initDemoJack(){
/* ===== DEMO CINEMATIC (?demo=jack) ===== */
(function(){
  const params=new URLSearchParams(location.search);
  if(params.get("demo")!=="jack") return;

  const cursor=document.getElementById("demo-cursor");
  document.body.classList.add("demo-run");
  window.__forceJackpot=true;
  cursor.classList.add("on");

  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  function setCursor(x,y){
    cursor.style.left=x+"px";
    cursor.style.top=y+"px";
  }
  async function moveTo(el, ms=900){
    const r=el.getBoundingClientRect();
    const tx=r.left+r.width*0.55;
    const ty=r.top+Math.min(r.height*0.55, 28);
    const from=cursor.getBoundingClientRect();
    const x0=from.left||innerWidth*0.35;
    const y0=from.top||innerHeight*0.4;
    const t0=performance.now();
    await new Promise(resolve=>{
      function step(now){
        const u=Math.min(1,(now-t0)/ms);
        const e=u*u*(3-2*u);
        setCursor(x0+(tx-x0)*e, y0+(ty-y0)*e);
        if(u<1) requestAnimationFrame(step); else resolve();
      }
      requestAnimationFrame(step);
    });
  }
  async function clickPulse(){
    cursor.classList.add("click");
    await sleep(120);
    cursor.classList.remove("click");
  }
  const amountEl=document.getElementById("amount");
  const swapBtn=document.getElementById("swapBtn");
  if(!amountEl||!swapBtn||!cursor) return;

  async function typeAmount(str){
    amountEl.focus();
    /* progressive full strings — number inputs drop "0." if appended char-by-char */
    const steps=[];
    for(let i=1;i<=str.length;i++) steps.push(str.slice(0,i));
    for(const v of steps){
      amountEl.value=v;
      amountEl.dispatchEvent(new Event("input",{bubbles:true}));
      await sleep(160+Math.random()*60);
    }
  }

  async function run(){
    await sleep(900);
    setCursor(innerWidth*0.42, innerHeight*0.38);
    await sleep(400);
    await moveTo(amountEl, 1100);
    await sleep(200);
    await clickPulse();
    amountEl.value="";
    amountEl.dispatchEvent(new Event("input",{bubbles:true}));
    amountEl.focus();
    await sleep(280);
    await typeAmount("0.02");
    await sleep(450);
    await moveTo(swapBtn, 1000);
    await sleep(500);
    await clickPulse();
    swapBtn.click();
    const reveal=document.getElementById("jackReveal");
    const ok=document.getElementById("jrOk");
    for(let i=0;i<200;i++){
      if(reveal&&reveal.classList.contains("on")) break;
      await sleep(100);
    }
    /* wait through count-up, then land cursor on Nice — end of take */
    await sleep(4800);
    if(ok){
      await moveTo(ok, 1100);
      ok.classList.add("is-hover");
      await sleep(900);
    }
  }

  if(document.readyState==="complete") run();
  else addEventListener("load", ()=>run());
})();

}
