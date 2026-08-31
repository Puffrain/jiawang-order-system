import { Fragment, type ReactNode } from "react";

const COLOR_OPEN = /\[color=(#[0-9a-fA-F]{6})\]/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  while (cursor < text.length) {
    const boldStart = text.indexOf("**", cursor);
    COLOR_OPEN.lastIndex = cursor;
    const colorMatch = COLOR_OPEN.exec(text);
    const colorStart = colorMatch?.index ?? -1;
    const starts = [boldStart, colorStart].filter((value) => value >= 0);
    if (!starts.length) { nodes.push(text.slice(cursor)); break; }
    const next = Math.min(...starts);
    if (next > cursor) nodes.push(text.slice(cursor, next));
    if (next === boldStart) {
      const end = text.indexOf("**", boldStart + 2);
      if (end < 0) { nodes.push(text.slice(boldStart)); break; }
      nodes.push(<strong key={`${keyPrefix}-b-${key++}`}>{renderInline(text.slice(boldStart + 2, end), `${keyPrefix}-b`)}</strong>);
      cursor = end + 2;
    } else if (colorMatch) {
      const contentStart = colorStart + colorMatch[0].length;
      const end = text.indexOf("[/color]", contentStart);
      if (end < 0) { nodes.push(text.slice(colorStart)); break; }
      nodes.push(<span key={`${keyPrefix}-c-${key++}`} style={{ color: colorMatch[1] }}>{renderInline(text.slice(contentStart, end), `${keyPrefix}-c`)}</span>);
      cursor = end + 8;
    }
  }
  return nodes;
}

export default function FormattedDescription({ text, className }: { text: string; className?: string }) {
  return <div className={className}>{text.split(/\r?\n/).map((line, index) => <Fragment key={index}>{index > 0 && <br />}{renderInline(line, `line-${index}`)}</Fragment>)}</div>;
}
