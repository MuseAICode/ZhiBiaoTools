// HTML 配图（AI 写的 HTML 转 PNG）的画布、页面与布局测量脚本：桌面版 Main（services/localImageRenderService.cjs）与
// Web 版 render-html 沙箱（server/sandbox/export/htmlImage.mjs，镜像构建时复制本文件）共用同一份，两端的画布尺寸、
// 页面包装与布局检查完全相同。脚本都由平台在页面中求值（桌面版 executeJavaScript，Web 版禁用页面脚本后由 Playwright
// 求值），不是页面自己的脚本。本文件只能依赖 Node 内置能力，不能引用 electron。
'use strict';

/** HTML 配图设计宽度，与生成 Prompt 一致；导出 Word 时再等比缩小 */
const HTML_DESIGN_WIDTH = 1240;
/** HTML 画布沿用正文画框比例，尺寸包含四周内边距 */
const HTML_FRAME_HEIGHTS = Object.freeze({ square: 1240, wide: 827, tall: 1653, panorama: 698 });
const HTML_CANVAS_PADDING = 40;
/** HTML 使用 2 倍像素输出，兼顾清晰度和长图内存占用 */
const HTML_CAPTURE_SCALE = 2;
/** HTML 中可见文字的最小设计字号，缩入 Word 后仍保持可读 */
const HTML_MIN_TEXT_FONT_SIZE = 24;
/** 布局尺寸连续不变这么久才算稳定。 */
const LAYOUT_SETTLE_MS = 120;
/** 等待布局稳定时的轮询间隔。 */
const LAYOUT_POLL_MS = 100;

/**
 * 页面资源与布局状态的测量脚本（在页面中求值，返回 { ready, width, height }）。
 * contentOnly：只量 #app-capture-root 内容包围盒，避免 body 固定宽导致右侧留白。
 */
function buildLayoutMetricsScript(minWidth, contentOnly = false) {
  const floorWidth = Math.max(1, Math.round(Number(minWidth) || 1));
  return `(() => {
    const contentOnly = ${contentOnly ? 'true' : 'false'};
    const root = document.documentElement;
    const body = document.body;
    const target = document.getElementById('app-capture-root') || body || root;
    if (!target) return { ready: false, width: 0, height: 0 };
    const images = Array.from(document.images || []);
    const imagesReady = images.every((img) => img.complete);
    const fontsReady = !document.fonts || document.fonts.status === 'loaded' || document.fonts.status === 'idle';
    const rect = target.getBoundingClientRect();
    let width;
    let height;
    if (contentOnly) {
      // 仅量捕获根节点（含 padding）；SVG 异常小时回退 viewBox / getBBox。
      width = Math.ceil(Math.max(rect.width, target.scrollWidth || 0, 1));
      height = Math.ceil(Math.max(rect.height, target.scrollHeight || 0, 1));
      const svg = target.querySelector && target.querySelector('svg');
      if (svg && (width < 24 || height < 24)) {
        let svgW = 0;
        let svgH = 0;
        const attrW = parseFloat(svg.getAttribute('width') || '');
        const attrH = parseFloat(svg.getAttribute('height') || '');
        if (Number.isFinite(attrW) && Number.isFinite(attrH) && attrW > 0 && attrH > 0) {
          svgW = attrW;
          svgH = attrH;
        } else {
          const vb = (svg.getAttribute('viewBox') || '').trim().split(/[\\s,]+/).map(Number);
          if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
            svgW = vb[2];
            svgH = vb[3];
          } else {
            try {
              const box = svg.getBBox();
              if (box && box.width > 0 && box.height > 0) {
                svgW = box.width;
                svgH = box.height;
              }
            } catch {}
          }
        }
        if (svgW > 0 && svgH > 0) {
          width = Math.ceil(svgW + 16);
          height = Math.ceil(svgH + 16);
        }
      }
    } else {
      width = Math.ceil(Math.max(
        rect.width,
        target.scrollWidth || 0,
        body?.scrollWidth || 0,
        root?.scrollWidth || 0,
        ${floorWidth},
      ));
      height = Math.ceil(Math.max(
        rect.height,
        target.scrollHeight || 0,
        body?.scrollHeight || 0,
        root?.scrollHeight || 0,
        1,
      ));
    }
    return { ready: imagesReady && fontsReady && width > 0 && height > 0, width, height };
  })()`;
}

// 在最终截图前，用浏览器实际排版结果检查模型生成 HTML 中可客观识别的文字和画布问题。
// 只检查文字的 transform；writing-mode 不在检查范围内，竖排文字保持允许。
function buildHtmlLayoutProbeScript() {
  return `(() => {
    const root=document.body;
    if(!root)return ['未找到截图画布'];
    const issues=[];
    const add=(value)=>{if(value&&!issues.includes(value)&&issues.length<12)issues.push(value)};
    const visible=(element)=>{const style=getComputedStyle(element);return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity||1)>0};
    const label=(element)=>{const tag=(element.tagName||'元素').toLowerCase();const className=String(element.className||'').trim().split(/\\s+/).filter(Boolean).slice(0,2).join('.');return className?tag+'.'+className:tag};
    const related=(left,right)=>left===right||left.contains(right)||right.contains(left);
    const canvasRect=root.getBoundingClientRect();
    const padding=getComputedStyle(root);
    const rootRect={left:canvasRect.left+parseFloat(padding.paddingLeft),right:canvasRect.right-parseFloat(padding.paddingRight),top:canvasRect.top+parseFloat(padding.paddingTop),bottom:canvasRect.bottom-parseFloat(padding.paddingBottom)};
    const minFontSize=${HTML_MIN_TEXT_FONT_SIZE};
    const textEntries=[];
    const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
    let node;
    while((node=walker.nextNode())){
      if(!node.nodeValue||!node.nodeValue.trim())continue;
      const element=node.parentElement;
      if(!element||!visible(element)||['script','style','noscript'].includes(element.tagName.toLowerCase()))continue;
      const range=document.createRange();range.selectNodeContents(node);
      const rects=Array.from(range.getClientRects()).filter((rect)=>rect.width>0&&rect.height>0);
      if(rects.length)textEntries.push({element,rects});
    }
    const hasInvalidTransform=(transform)=>{
      if(!transform||transform==='none')return false;
      const match=transform.match(/^matrix\\(([^)]+)\\)$/);
      if(match){const values=match[1].split(',').map(Number);return values.length!==6||Math.abs(values[1])>.01||Math.abs(values[2])>.01||values[0]<0||values[3]<0||Math.abs(Math.abs(values[0])-1)>.01||Math.abs(Math.abs(values[3])-1)>.01}
      const matrix3d=transform.match(/^matrix3d\\(([^)]+)\\)$/);
      if(matrix3d){const values=matrix3d[1].split(',').map(Number);return values.length!==16||Math.abs(values[1])>.01||Math.abs(values[4])>.01||Math.abs(values[0]-1)>.01||Math.abs(values[5]-1)>.01||values[0]<0||values[5]<0}
      return true;
    };
    for(const entry of textEntries){
      for(let element=entry.element;element&&element!==root.parentElement;element=element.parentElement){
        const style=getComputedStyle(element);
        if(hasInvalidTransform(style.transform)){add('文字存在旋转、倒置、镜像或缩放变形：'+label(element));break}
        if(style.position==='fixed'||style.position==='sticky'){add('文字使用固定或粘性定位，截图布局不稳定：'+label(element));break}
      }
      const fontSize=parseFloat(getComputedStyle(entry.element).fontSize||'0');
      if(fontSize>0&&fontSize<minFontSize)add('文字字号过小：'+label(entry.element)+' 为 '+fontSize+'px，至少需要 '+minFontSize+'px');
      for(const rect of entry.rects){
        if(rect.left<rootRect.left-1||rect.right>rootRect.right+1||rect.top<rootRect.top-1||rect.bottom>rootRect.bottom+1){add('文字超出截图画布：'+label(entry.element));break}
        for(let element=entry.element;element&&element!==root.parentElement;element=element.parentElement){
          const style=getComputedStyle(element);
          const clipsX=['hidden','clip','scroll','auto'].includes(style.overflowX);
          const clipsY=['hidden','clip','scroll','auto'].includes(style.overflowY);
          const box=element.getBoundingClientRect();
          if((clipsX&&(rect.left<box.left-1||rect.right>box.right+1))||(clipsY&&(rect.top<box.top-1||rect.bottom>box.bottom+1))){add('文字被容器裁切：'+label(element));break}
          if(style.textOverflow==='ellipsis'&&element.scrollWidth>element.clientWidth+1){add('文字被省略截断：'+label(element));break}
        }
      }
    }
    for(let index=0;index<textEntries.length;index+=1){
      for(let next=index+1;next<textEntries.length;next+=1){
        const left=textEntries[index];const right=textEntries[next];
        if(related(left.element,right.element)||left.element===right.element)continue;
        const overlaps=left.rects.some((a)=>right.rects.some((b)=>{
          const width=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));
          const height=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));
          return width*height>=Math.max(8,Math.min(a.width*a.height,b.width*b.height)*.2);
        }));
        if(overlaps)add('文字内容发生重叠：'+label(left.element)+' 与 '+label(right.element));
      }
    }
    for(const entry of textEntries){
      const rect=entry.rects[0];
      const points=[[rect.left+rect.width/2,rect.top+rect.height/2],[rect.left+Math.min(3,rect.width/2),rect.top+rect.height/2]];
      for(const [x,y] of points){
        if(x<rootRect.left||x>rootRect.right||y<rootRect.top||y>rootRect.bottom)continue;
        const top=document.elementsFromPoint(x,y).find((element)=>element!==document.documentElement&&element!==document.body);
        if(!top||related(top,entry.element)||!visible(top))continue;
        const style=getComputedStyle(top);
        const background=style.backgroundImage!=='none'||!/^rgba?\\([^)]*,\\s*0\\)$/.test(style.backgroundColor)||['img','svg','canvas','video'].includes(top.tagName.toLowerCase());
        if(background){add('文字被前景元素遮挡：'+label(entry.element)+' 被 '+label(top)+' 覆盖');break}
      }
    }
    for(const element of root.querySelectorAll('*')){
      if(!visible(element))continue;
      const rect=element.getBoundingClientRect();
      if(rect.width>0&&rect.height>0&&(rect.left<rootRect.left-1||rect.right>rootRect.right+1||rect.top<rootRect.top-1||rect.bottom>rootRect.bottom+1)){add('元素超出画布内容区域：'+label(element));}
    }
    if(!textEntries.length&&!root.querySelector('img,svg,canvas,video'))add('截图画布没有可见内容');
    return issues;
  })()`;
}

// body 本身作为固定画布，保留生成源码的 Flex/Grid 父子关系。
function buildHtmlDocument(html, height) {
  const source = String(html || '').trim();
  const styleTag = `<style id="app-capture-style">
html, body {
  margin: 0 !important;
  width: ${HTML_DESIGN_WIDTH}px !important;
  min-width: ${HTML_DESIGN_WIDTH}px !important;
  max-width: ${HTML_DESIGN_WIDTH}px !important;
  height: ${height}px !important;
  min-height: ${height}px !important;
  max-height: ${height}px !important;
  overflow: visible !important;
  box-sizing: border-box !important;
}
html { padding: 0 !important; background: #ffffff; }
body { padding: ${HTML_CANVAS_PADDING}px !important; }
*, *::before, *::after { box-sizing: border-box; }
img, svg, canvas, video { max-width: 100%; height: auto; }
</style>`;
  if (/<html[\s>]/i.test(source)) {
    if (/<\/head>/i.test(source)) return source.replace(/<\/head>/i, `<meta charset="utf-8">${styleTag}</head>`);
    return source.replace(/<html([^>]*)>/i, `<html$1><head><meta charset="utf-8">${styleTag}</head>`);
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${styleTag}</head><body>${source}</body></html>`;
}

module.exports = {
  HTML_CANVAS_PADDING,
  HTML_CAPTURE_SCALE,
  HTML_DESIGN_WIDTH,
  HTML_FRAME_HEIGHTS,
  HTML_MIN_TEXT_FONT_SIZE,
  LAYOUT_POLL_MS,
  LAYOUT_SETTLE_MS,
  buildHtmlDocument,
  buildHtmlLayoutProbeScript,
  buildLayoutMetricsScript,
};
