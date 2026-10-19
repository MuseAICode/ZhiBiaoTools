import { useMemo, type KeyboardEvent, type ReactNode } from 'react';
import { renderMarkdownHtml } from '../markdown/renderMarkdownHtml';

type MarkdownImageMode = 'default' | 'preview' | 'lazy';
type MarkdownLinkMode = 'default' | 'external' | 'text';

interface MarkdownRendererProps {
  children: string;
  allowRawHtml?: boolean;
  enableGfm?: boolean;
  imageMode?: MarkdownImageMode;
  imageClassName?: string;
  linkMode?: MarkdownLinkMode;
  linkTextClassName?: string;
  previewImageTitle?: string;
  onPreviewImage?: (src: string, alt: string) => void;
}

function normalizeExternalUrl(value: string | undefined) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return /^www\./i.test(raw) ? `https://${raw}` : raw;
}

function isExternalHttpUrl(value: string) {
  return /^https?:\/\//i.test(value);
}

function openExternal(url: string) {
  if (window.appBridge?.openExternal) {
    void window.appBridge.openExternal(url);
    return;
  }

  window.open(url, '_blank', 'noopener,noreferrer');
}

// 以下白名单对 Markdown 生成的结构和原始 HTML 一律生效：只重建列出的标签和属性，
// 不保留 style、事件属性和任意 class，链接和图片地址只允许列出的协议。
const SAFE_LINK_URL = /^(?:https?:\/\/|mailto:|#)/i;
const SAFE_IMAGE_URL = /^(?:https?:\/\/|app-asset:\/\/|blob:|data:image\/(?:png|jpe?g|gif|webp|bmp);)/i;
const SAFE_CLASS_NAME = /^(?:task-list-item(?:-checkbox|-label)?|enabled|contains-task-list|language-[\w+-]{1,40})$/;
const SAFE_CHECKBOX_ID = /^task-item--?\d+$/;
const SAFE_DIMENSION = /^\d{1,4}(?:px|%)?$/;
// 这些标签连同内容一起丢弃，不作为文本显示。
const DROPPED_TAGS = new Set(['script', 'style', 'template', 'noscript', 'iframe', 'object', 'embed', 'title', 'textarea', 'select']);

function getElementClassName(element: Element) {
  const classNames = (element.getAttribute('class') || '').split(/\s+/).filter((name) => SAFE_CLASS_NAME.test(name));
  return classNames.length ? classNames.join(' ') : undefined;
}

function getSafeDimension(element: Element, name: 'width' | 'height') {
  const value = (element.getAttribute(name) || '').trim();
  return SAFE_DIMENSION.test(value) ? value : undefined;
}

function getSafeLinkUrl(value: string) {
  const url = value.trim();
  return SAFE_LINK_URL.test(url) ? url : '';
}

function getSafeImageUrl(value: string) {
  const url = value.trim();
  return SAFE_IMAGE_URL.test(url) ? url : '';
}

function childrenFromDom(nodes: ChildNode[], renderNode: (node: ChildNode, index: number) => ReactNode) {
  return nodes.map((node, index) => renderNode(node, index));
}

function MarkdownRenderer({
  children,
  allowRawHtml = false,
  enableGfm = true,
  imageMode = 'default',
  imageClassName,
  linkMode = 'external',
  linkTextClassName,
  previewImageTitle = '点击放大查看',
  onPreviewImage,
}: MarkdownRendererProps) {
  const html = useMemo(() => renderMarkdownHtml(children, { allowRawHtml, enableGfm }), [allowRawHtml, children, enableGfm]);

  const content = useMemo(() => {
    const document = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
    const root = document.body.firstElementChild;
    const renderNode = (node: ChildNode, index: number): ReactNode => {
      if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return null;

      const element = node as Element;
      const tag = element.tagName.toLowerCase();
      if (DROPPED_TAGS.has(tag)) return null;
      const childNodes = Array.from(element.childNodes);
      const renderedChildren = childrenFromDom(childNodes, renderNode);
      const className = getElementClassName(element);
      const key = `${tag}-${index}`;

      if (tag === 'br') return <br key={key} />;
      if (tag === 'hr') return <hr key={key} />;
      if (tag === 'a') {
        const externalUrl = normalizeExternalUrl(element.getAttribute('href') || '');
        const href = getSafeLinkUrl(externalUrl);
        if (linkMode === 'text' || !href) {
          return <span key={key} className={linkTextClassName}>{renderedChildren}</span>;
        }

        const isExternal = linkMode === 'external' && isExternalHttpUrl(href);
        return (
          <a
            key={key}
            className={className}
            href={href}
            rel={isExternal ? 'noreferrer' : undefined}
            target={isExternal ? '_blank' : undefined}
            onClick={(event) => {
              if (!isExternal) return;
              event.preventDefault();
              event.stopPropagation();
              openExternal(href);
            }}
          >
            {renderedChildren}
          </a>
        );
      }

      if (tag === 'img') {
        const src = getSafeImageUrl(element.getAttribute('src') || '');
        const alt = element.getAttribute('alt') || '正文图片';
        if (!src) return <span key={key}>[{alt}]</span>;
        const mergedClassName = [className, imageClassName].filter(Boolean).join(' ') || undefined;
        const previewEnabled = imageMode === 'preview' && Boolean(src) && Boolean(onPreviewImage);
        const handlePreview = () => {
          if (previewEnabled) onPreviewImage?.(src, alt);
        };
        const handleKeyDown = (event: KeyboardEvent<HTMLImageElement>) => {
          if (!previewEnabled || (event.key !== 'Enter' && event.key !== ' ')) return;
          event.preventDefault();
          handlePreview();
        };

        return (
          <img
            key={key}
            src={src}
            alt={alt}
            width={getSafeDimension(element, 'width')}
            height={getSafeDimension(element, 'height')}
            className={mergedClassName}
            loading={imageMode === 'lazy' ? 'lazy' : undefined}
            decoding={imageMode === 'lazy' ? 'async' : undefined}
            role={previewEnabled ? 'button' : undefined}
            tabIndex={previewEnabled ? 0 : undefined}
            title={previewEnabled ? previewImageTitle : undefined}
            onClick={previewEnabled ? handlePreview : undefined}
            onKeyDown={previewEnabled ? handleKeyDown : undefined}
          />
        );
      }

      if (tag === 'input' && (element.getAttribute('type') || '').toLowerCase() === 'checkbox') {
        return (
          <input
            key={key}
            id={SAFE_CHECKBOX_ID.test(element.getAttribute('id') || '') ? element.getAttribute('id') || undefined : undefined}
            type="checkbox"
            checked={element.hasAttribute('checked')}
            disabled
            readOnly
            className={className}
          />
        );
      }

      const props = { key, className };
      if (tag === 'p') {
        const isFigureCaption = /^图[:：]/.test((element.textContent || '').trim());
        return <p {...props} className={[className, isFigureCaption ? 'markdown-figure-caption' : ''].filter(Boolean).join(' ') || undefined}>{renderedChildren}</p>;
      }

      if (tag === 'h1') return <h1 {...props}>{renderedChildren}</h1>;
      if (tag === 'h2') return <h2 {...props}>{renderedChildren}</h2>;
      if (tag === 'h3') return <h3 {...props}>{renderedChildren}</h3>;
      if (tag === 'h4') return <h4 {...props}>{renderedChildren}</h4>;
      if (tag === 'h5') return <h5 {...props}>{renderedChildren}</h5>;
      if (tag === 'h6') return <h6 {...props}>{renderedChildren}</h6>;
      if (tag === 'strong') return <strong {...props}>{renderedChildren}</strong>;
      if (tag === 'b') return <b {...props}>{renderedChildren}</b>;
      if (tag === 'em') return <em {...props}>{renderedChildren}</em>;
      if (tag === 'i') return <i {...props}>{renderedChildren}</i>;
      if (tag === 'del') return <del {...props}>{renderedChildren}</del>;
      if (tag === 's') return <s {...props}>{renderedChildren}</s>;
      if (tag === 'ul') return <ul {...props}>{renderedChildren}</ul>;
      if (tag === 'ol') return <ol {...props}>{renderedChildren}</ol>;
      if (tag === 'li') return <li {...props}>{renderedChildren}</li>;
      if (tag === 'table') {
        return (
          <div key={key} className="markdown-table-scroll">
            <table className={className}>{renderedChildren}</table>
          </div>
        );
      }
      if (tag === 'thead') return <thead {...props}>{renderedChildren}</thead>;
      if (tag === 'tbody') return <tbody {...props}>{renderedChildren}</tbody>;
      if (tag === 'tr') return <tr {...props}>{renderedChildren}</tr>;
      if (tag === 'th') return <th {...props}>{renderedChildren}</th>;
      if (tag === 'td') return <td {...props}>{renderedChildren}</td>;
      if (tag === 'blockquote') return <blockquote {...props}>{renderedChildren}</blockquote>;
      if (tag === 'pre') return <pre {...props}>{renderedChildren}</pre>;
      if (tag === 'code') return <code {...props}>{renderedChildren}</code>;
      if (tag === 'mark') return <mark {...props}>{renderedChildren}</mark>;
      if (tag === 'small') return <small {...props}>{renderedChildren}</small>;
      if (tag === 'sub') return <sub {...props}>{renderedChildren}</sub>;
      if (tag === 'sup') return <sup {...props}>{renderedChildren}</sup>;
      if (tag === 'label') {
        const htmlFor = element.getAttribute('for') || '';
        return <label {...props} htmlFor={SAFE_CHECKBOX_ID.test(htmlFor) ? htmlFor : undefined}>{renderedChildren}</label>;
      }
      if (tag === 'span') return <span {...props}>{renderedChildren}</span>;
      if (tag === 'div') return <div {...props}>{renderedChildren}</div>;
      if (tag === 'section') return <section {...props}>{renderedChildren}</section>;
      if (tag === 'article') return <article {...props}>{renderedChildren}</article>;

      return <span key={key}>{renderedChildren}</span>;
    };

    return Array.from(root?.childNodes || []).map((node, index) => renderNode(node, index));
  }, [enableGfm, html, imageClassName, imageMode, linkMode, linkTextClassName, onPreviewImage, previewImageTitle]);

  return <>{content}</>;
}

export default MarkdownRenderer;
