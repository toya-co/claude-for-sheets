/**
 * Dashboard stylesheet.
 *
 * Split from the markup because it is long and changes for different reasons.
 * Zero dependencies, like the rest of the daemon — this is a template string,
 * not a build step.
 *
 * Themes: the page follows the OS. Every colour is a token defined once on
 * :root and redefined under prefers-color-scheme, so no rule anywhere else
 * needs to know which theme is active.
 */

const CSS = `
:root {
  --paper:#F6F7F5; --surface:#FFF; --surface-2:#EDEFEA; --rail:#F1F2EE;
  --fg:#191E24; --fg-dim:#5B665F; --fg-faint:#8B948D;
  --rule:#DCE0D9; --rule-soft:#E8EBE5;
  --live:#1B6B4A; --live-bg:#E4F0E9;
  --warn:#8A5300; --warn-bg:#F7EEDD;
  --bad:#A32B1F; --bad-bg:#F7E7E4;
  --on-accent:#FFF;
  --shadow:0 1px 2px rgba(25,30,36,.06), 0 4px 12px rgba(25,30,36,.04);
  --sans:"IBM Plex Sans",ui-sans-serif,system-ui,"Segoe UI",sans-serif;
  --serif:"IBM Plex Serif",ui-serif,Georgia,serif;
  --mono:"IBM Plex Mono",ui-monospace,"SF Mono",Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --paper:#0F1319; --surface:#161B22; --surface-2:#1C222B; --rail:#12171E;
    --fg:#E4E8E3; --fg-dim:#93A09A; --fg-faint:#66726C;
    --rule:#262E38; --rule-soft:#1E252E;
    --live:#5CC79B; --live-bg:#12281F;
    --warn:#E0A34A; --warn-bg:#2A2114;
    --bad:#EF8B7E; --bad-bg:#2C1815;
    --on-accent:#0F1319;
    --shadow:0 1px 2px rgba(0,0,0,.3), 0 4px 14px rgba(0,0,0,.25);
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--fg);font-family:var(--serif);
     font-size:16px;line-height:1.66;-webkit-font-smoothing:antialiased}

/* ---- shell ---- */
.app{display:flex;align-items:flex-start;min-height:100vh}
aside.rail{width:252px;flex:none;background:var(--rail);border-right:1px solid var(--rule);
           position:sticky;top:0;height:100vh;overflow-y:auto;padding:22px 0 40px}
.brand{display:flex;align-items:center;gap:9px;padding:0 20px 18px;margin-bottom:6px;
       border-bottom:1px solid var(--rule)}
.brand .name{font-family:var(--sans);font-weight:600;font-size:14.5px;letter-spacing:-.01em}
.brand .ver{font-family:var(--mono);font-size:10.5px;color:var(--fg-faint);margin-left:auto}
.navgroup{margin-top:20px}
.navgroup>.label{font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.13em;
                 text-transform:uppercase;color:var(--fg-faint);padding:0 20px 7px}
nav a{display:flex;align-items:center;gap:8px;font-family:var(--sans);font-size:13.5px;
      color:var(--fg-dim);text-decoration:none;padding:6px 20px 6px 19px;
      border-left:2px solid transparent;cursor:pointer}
nav a:hover{color:var(--fg);background:var(--surface-2)}
nav a.on{color:var(--fg);font-weight:600;border-left-color:var(--live);background:var(--surface-2)}
nav a:focus-visible{outline:2px solid var(--live);outline-offset:-2px}
nav a .badge{margin-left:auto;font-family:var(--mono);font-size:9.5px;font-weight:600;
             background:var(--warn);color:var(--on-accent);border-radius:9px;padding:1px 6px}
main{flex:1;min-width:0;padding:46px 46px 120px;max-width:900px}
section.page{display:none}
section.page.on{display:block}

/* ---- type ---- */
.eyebrow{font-family:var(--mono);font-size:10.5px;font-weight:500;letter-spacing:.14em;
         text-transform:uppercase;color:var(--fg-faint);margin:0 0 11px}
h1{font-family:var(--sans);font-weight:700;font-size:33px;line-height:1.1;
   letter-spacing:-.026em;margin:0 0 12px;text-wrap:balance}
.lede{font-size:17px;line-height:1.58;color:var(--fg-dim);max-width:62ch;margin:0 0 34px}
h2{font-family:var(--sans);font-weight:600;font-size:19px;letter-spacing:-.014em;
   margin:42px 0 14px;text-wrap:balance}
h3{font-family:var(--sans);font-weight:600;font-size:15px;margin:28px 0 7px}
p{margin:0 0 15px;max-width:66ch}
strong{font-weight:600}
code{font-family:var(--mono);font-size:.85em;background:var(--surface-2);
     padding:.1em .38em;border-radius:3px}
a{color:var(--live)}
.note{border-left:2px solid var(--rule);padding:1px 0 1px 17px;margin:20px 0 24px;
      color:var(--fg-dim);font-size:15px;max-width:64ch}
.note strong{color:var(--fg)}
.empty{color:var(--fg-faint);font-style:italic;font-family:var(--sans);font-size:14px}

/* ---- live ui ---- */
.statusbar{display:flex;align-items:center;gap:11px;flex-wrap:wrap;background:var(--surface);
           border:1px solid var(--rule);border-radius:7px;padding:13px 16px;margin-bottom:30px;
           font-family:var(--sans);font-size:13.5px;box-shadow:var(--shadow)}
.dot{width:8px;height:8px;border-radius:50%;background:var(--live);flex:none}
.dot.off{background:var(--bad)}
.sep{color:var(--rule)}
.m{font-family:var(--mono);font-size:11.5px;color:var(--fg-faint)}
.blockhead{display:flex;align-items:baseline;gap:10px;margin:34px 0 12px}
.blockhead h2{margin:0}
.blockhead .count{font-family:var(--mono);font-size:11px;color:var(--fg-faint)}
.card{border:1px solid var(--rule);border-radius:7px;padding:13px 15px;background:var(--surface);
      font-family:var(--sans);font-size:14px;line-height:1.45}
.card+.card{margin-top:8px}
.card.pend{border-color:var(--warn);background:var(--warn-bg)}
.card.fail{border-color:var(--bad)}
.card .t{font-weight:600}
/* The gap between a title and the grey meta that follows it, in one place.
   These rows are built by string concatenation, which — unlike the pages
   written as HTML — has no newline between the two spans to render as a
   space, so they ran together: "Budgetpaired Aug 19". */
.card .t+.m{margin-left:10px}
.card .head{cursor:pointer;border-radius:4px;margin:-4px;padding:4px}
.card .head:hover{background:var(--surface-2)}
.card .head:focus-visible{outline:2px solid var(--live);outline-offset:-1px}
.card.open{border-color:var(--fg-faint)}
.chev{color:var(--fg-faint);font-size:11px;flex:none;width:10px}
.card .m{margin-top:3px}
.row{display:flex;align-items:center;gap:13px}
.row .grow{flex:1;min-width:0}
button{font-family:var(--sans);font-size:12.5px;font-weight:500;border:1px solid var(--rule);
       border-radius:5px;padding:5px 12px;background:var(--surface);color:var(--fg);
       white-space:nowrap;cursor:pointer}
button:hover{border-color:var(--fg-faint)}
button:focus-visible{outline:2px solid var(--live);outline-offset:1px}
button.pri{background:var(--live);border-color:var(--live);color:var(--on-accent)}
button.danger{color:var(--bad)}
button[disabled]{opacity:.5;cursor:default}
select,input[type=text],textarea{font-family:var(--sans);font-size:13px;color:var(--fg);
  background:var(--paper);border:1px solid var(--rule);border-radius:5px;padding:5px 9px}
textarea{font-family:var(--mono);font-size:11.5px;width:100%;min-height:62px;
         resize:vertical;margin-top:7px;line-height:1.5}
.drawer{margin-top:13px;padding-top:12px;border-top:1px solid var(--rule-soft)}
.w-h{font-family:var(--sans);font-size:10.5px;font-weight:600;letter-spacing:.1em;
     text-transform:uppercase;color:var(--fg-faint);margin:0 0 7px}
.step{display:flex;align-items:flex-start;gap:12px;padding:11px 0;font-family:var(--sans);
      font-size:14px;border-bottom:1px solid var(--rule-soft)}
.step:last-child{border-bottom:0}
.step .mark{font-family:var(--mono);font-size:13px;flex:none;width:15px;line-height:1.5}
.step.done .mark{color:var(--live)}
.step.todo .mark{color:var(--warn)}
.step .grow{flex:1;min-width:0}
.step .h{font-weight:500}
.step .d{color:var(--fg-faint);font-size:12.5px;margin-top:1px}
.seg{display:inline-flex;border:1px solid var(--rule);border-radius:5px;overflow:hidden}
.seg button{border:0;border-radius:0;background:var(--surface)}
.seg button+button{border-left:1px solid var(--rule)}
.seg button.on{background:var(--live);color:var(--on-accent)}
.saved{font-family:var(--sans);font-size:12px;color:var(--live);opacity:0;transition:opacity .2s}
.saved.show{opacity:1}

/* ---- tables ---- */
.scroll{overflow-x:auto;margin:18px 0 26px}
table{border-collapse:collapse;width:100%;min-width:520px;font-family:var(--sans);font-size:13.5px}
th,td{text-align:left;padding:8px 14px 8px 0;border-bottom:1px solid var(--rule-soft);
      vertical-align:top}
th{font-family:var(--mono);font-size:10px;font-weight:500;letter-spacing:.09em;
   text-transform:uppercase;color:var(--fg-faint);border-bottom-color:var(--rule)}
td code{background:none;padding:0;color:var(--fg-dim)}
td.num{font-family:var(--mono);font-variant-numeric:tabular-nums;text-align:right;
       padding-right:0;color:var(--fg-dim)}

@media (max-width:860px){
  .app{flex-direction:column}
  aside.rail{width:100%;height:auto;position:static;border-right:0;
             border-bottom:1px solid var(--rule);padding-bottom:14px}
  .navgroup{margin-top:14px}
  nav{display:flex;flex-wrap:wrap;gap:2px;padding:0 12px}
  nav a{border-left:0;border-bottom:2px solid transparent;padding:6px 10px;border-radius:4px}
  nav a.on{border-left:0;border-bottom-color:var(--live)}
  main{padding:28px 20px 80px}
  h1{font-size:27px}
}
@media (prefers-reduced-motion: reduce){*{transition:none!important;animation:none!important}}
`;

module.exports = { CSS };
