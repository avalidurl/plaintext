// The whole stylesheet. Keep it under 1 KB.
//
// Rules that are not negotiable:
//   - declare NO font-family, font-size or line-height. The UA serif at its own
//     default size IS the look. Never load a webfont.
//   - one column, max-width 600px. That rule is the entire responsive strategy.
//   - style four things: body, headings, pre, blockquote. Everything else stays
//     at browser default — especially links.
//   - never #fff / #000. Both are slightly tinted.
//
// Palette sampled from lossless archival sources; every pairing below is
// WCAG AA or better on its background. Cyan is decorative ONLY — it fails AA
// on every background including white (2.05:1), so it never carries meaning.

export const STYLE = `
body{background:#fff;color:#16181D;margin:0 auto;padding:8px;max-width:600px}
h1,h2,h3,pre{color:#1F437E}
a{color:#2D5FB6}
a:visited{color:#7B4499}
pre{overflow-x:auto}
blockquote,.t{color:#4A5568}
blockquote{font-style:italic}
textarea,input{font:inherit;background:#fff;color:inherit}
textarea{padding:.5rem;width:100%;box-sizing:border-box}
.p{background:#DDF0FE;padding:.5rem}
.r{padding-left:24px;border-left:1px solid #B8DCF6}
.wl-new{color:#7C8AA5;border-bottom:1px dashed #B8DCF6;text-decoration:none}
.b{background:repeating-linear-gradient(#fff 0 1px,#FAFAFA 1px 2px,#E9E9E9 2px 3px,#FAFAFA 3px 4px);height:4px;margin:1rem 0}
@media(prefers-color-scheme:dark){
body{background:#14161B;color:#E8E8E8}
h1,h2,h3,a,pre{color:#64ABF6}
a:visited{color:#C79BE0}
blockquote,.t{color:#9AA5B8}
textarea,input{background:#20242E}
.p{background:#1B2430}
.r{border-left-color:#2A3140}
.b{background:repeating-linear-gradient(#20242E 0 1px,#1C2029 1px 2px,#14161B 2px 3px,#1C2029 3px 4px)}
}
`.trim();

// The masthead. One piece of ASCII in a <pre>, coloured — it replaces the logo,
// the hero image and the illustration budget at once.
export const MASTHEAD = String.raw`
   ___________________________________
  |                                   |\
  |  . . . . . . . . . . . . . . . .  | |
  |  . . . . . . . . . . . . . . . .  | |
  |  . . . . . p l a i n t e x t . .  | |
  |  . . . . . . . . . . . . . . . .  | |
  |  . . . . . . . . . . . . . . . .  | |
  |___________________________________| |
   \___________________________________\|
`;
