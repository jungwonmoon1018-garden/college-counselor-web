// markdown.jsx — the safe markdown renderer for model replies (no raw HTML;
// tables, lists, inline emphasis and links only). Moved out of App.jsx on
// 2026-09-20.
function renderInlineMarkdown(text, keyPrefix) {
  const parts = [];
  const pattern = /\*\*(.+?)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s]+)/g;
  let lastIndex = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[1]) parts.push(<strong key={`${keyPrefix}-b-${match.index}`}>{match[1]}</strong>);
    else if (match[2] && match[3]) parts.push(<a key={`${keyPrefix}-l-${match.index}`} href={match[3]} target="_blank" rel="noreferrer" style={{color:"#8ec5ff"}}>{match[2]}</a>);
    else if (match[4]) parts.push(<a key={`${keyPrefix}-u-${match.index}`} href={match[4]} target="_blank" rel="noreferrer" style={{color:"#8ec5ff"}}>{match[4]}</a>);
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length ? parts : text;
}

function renderMarkdownText(text) {
  return String(text || "").split("\n").map((line, idx) => (
    line.trim()
      ? <div key={`line-${idx}`}>{renderInlineMarkdown(line, `line-${idx}`)}</div>
      : <div key={`line-${idx}`} style={{ height:10 }} />
  ));
}

// ═══════════════════════════════════════════════════════════
// FIX UX-4: MARKDOWN RENDERER
// ═══════════════════════════════════════════════════════════
// FIX P1-XSS: Pure React renderer — NO dangerouslySetInnerHTML, NO raw HTML injection.
// All model output is escaped by React's default JSX rendering. We only apply
// structural formatting (bold, italic, lists) through React elements.
export function renderMarkdownSafe(text) {
  if (!text) return null;
  const lines = normalizeMarkdownArtifacts(String(text)).split("\n");

  // First pass: collect consecutive | ... | lines into table blocks
  // and render everything else line-by-line.
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const cur = lines[i];
    if (/^\s*\|.*\|\s*$/.test(cur)) {
      const tableLines = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        tableLines.push(lines[i].trim());
        i++;
      }
      if (tableLines.length >= 2) {
        out.push(renderMdTable(tableLines, out.length));
        continue;
      }
      for (const tl of tableLines) out.push(renderMdLine(tl, out.length));
      continue;
    }
    out.push(renderMdLine(cur, out.length));
    i++;
  }
  return out;
}

// Strip LaTeX-ish math markers and fix orphan-asterisk formatting
// before the line-by-line renderer runs.
function normalizeMarkdownArtifacts(text) {
  let s = text;
  const REP = [
    [/\$\\rightarrow\$/g, "→"], [/\$\\Rightarrow\$/g, "⇒"],
    [/\$\\leftarrow\$/g,  "←"], [/\$\\Leftarrow\$/g,  "⇐"],
    [/\$\\leftrightarrow\$/g, "↔"],
    [/\$\\to\$/g, "→"], [/\$\\gets\$/g, "←"],
    [/\$\\cdot\$/g, "·"], [/\$\\times\$/g, "×"], [/\$\\div\$/g, "÷"],
    [/\$\\pm\$/g, "±"], [/\$\\approx\$/g, "≈"],
    [/\$\\geq\$/g, "≥"], [/\$\\leq\$/g, "≤"], [/\$\\neq\$/g, "≠"],
    [/\$\\infty\$/g, "∞"], [/\$\\degree\$/g, "°"],
    [/\$\\alpha\$/g, "α"], [/\$\\beta\$/g, "β"],
    [/\$\\gamma\$/g, "γ"], [/\$\\delta\$/g, "δ"],
    [/\$\\sigma\$/g, "σ"], [/\$\\mu\$/g, "μ"], [/\$\\pi\$/g, "π"],
    [/\$([^$\n]{1,30})\$/g, "$1"],
  ];
  for (const [re, rep] of REP) s = s.replace(re, rep);
  // Orphan trailing asterisk "Idea:*" -> "**Idea:**"
  s = s.replace(/([A-Za-z0-9][^*\n]{0,80}?):\*(\s|$)/g, "**$1:**$2");
  // Orphan leading asterisk "*Idea: foo" -> "**Idea:** foo"
  s = s.replace(/^\*([A-Za-z][^*\n]{0,80}?:)\s/gm, "**$1** ");
  return s;
}

function renderMdLine(line, key) {
  const li = `m${key}`;
  if (!line.trim()) return <div key={li} style={{height:10}} />;

  // Headers: ####, ###, ##, # — drop hashes; size by depth.
  const hMatch = line.match(/^(#{1,6})\s+(.+?)\s*$/);
  if (hMatch) {
    const depth = hMatch[1].length;
    const txt = hMatch[2].replace(/^\**|\**$/g, "");
    const sizes = { 1: 20, 2: 17, 3: 15, 4: 14, 5: 13, 6: 12 };
    const tops  = { 1: 14, 2: 12, 3: 10, 4: 8,  5: 6,  6: 4  };
    return (
      <div key={li} style={{
        fontSize: sizes[depth] || 14,
        fontWeight: 700,
        color: depth <= 2 ? "#e8e6e3" : "#cfe5ff",
        margin: `${tops[depth] || 6}px 0 4px`,
        lineHeight: 1.35,
      }}>{renderInlineSafe(txt)}</div>
    );
  }

  return renderMdLineLegacy(line, key);
}

function renderMdTable(lines, key) {
  const rows = lines
    .map(l => l.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map(c => c.trim()))
    .filter(cells => !cells.every(c => /^:?-+:?$/.test(c)));
  if (rows.length === 0) return null;
  const [header, ...body] = rows;
  return (
    <div key={`t${key}`} style={{margin:"8px 0", overflowX:"auto"}}>
      <table style={{
        borderCollapse:"collapse",
        fontSize:12,
        color:"#e8e6e3",
        border:"1px solid rgba(255,255,255,0.08)",
        borderRadius:6,
      }}>
        <thead>
          <tr style={{background:"rgba(55,138,221,0.10)"}}>
            {header.map((c, ci) => (
              <th key={ci} style={{
                padding:"6px 10px",
                textAlign:"left",
                fontWeight:600,
                color:"#cfe5ff",
                borderBottom:"1px solid rgba(55,138,221,0.20)",
              }}>{renderInlineSafe(c)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, ri) => (
            <tr key={ri} style={{borderTop:"1px solid rgba(255,255,255,0.04)"}}>
              {r.map((c, ci) => (
                <td key={ci} style={{padding:"6px 10px", verticalAlign:"top"}}>{renderInlineSafe(c)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Legacy per-line renderer (lists, citations, plain text).
function renderMdLineLegacy(line, li) {
  if (!line.trim()) return <div key={li} style={{height:10}} />;

  // Bullet list: "- text" or "* text" (single asterisk + space)
  const bulletMatch = line.match(/^-\s+(.+)/) || line.match(/^\*\s+(.+)/);
  if (bulletMatch) {
    return <div key={li} style={{display:"flex",gap:6,margin:"2px 0"}}><span style={{color:"#63b3ed"}}>{"•"}</span><span>{renderInlineSafe(bulletMatch[1])}</span></div>;
  }

  const arrowMatch = line.match(/^→\s+(.+)/);
  if (arrowMatch) {
    return <div key={li} style={{display:"flex",gap:6,margin:"2px 0"}}><span style={{color:"#63b3ed"}}>{"→"}</span><span>{renderInlineSafe(arrowMatch[1])}</span></div>;
  }

  const numMatch = line.match(/^(\d+)[.)]\s+(.+)/);
  if (numMatch) {
    return <div key={li} style={{display:"flex",gap:6,margin:"2px 0"}}><span style={{color:"#63b3ed",minWidth:16}}>{numMatch[1]}.</span><span>{renderInlineSafe(numMatch[2])}</span></div>;
  }

  if (/^Source:\s/i.test(line)) {
    return <div key={li} style={{fontSize:11,color:"#6a8ab5",fontStyle:"italic"}}>{line}</div>;
  }

  return <div key={li}>{renderInlineSafe(line)}</div>;
}

// Inline markdown: **bold**, *italic*, `code` — returns React elements, never raw HTML
function renderInlineSafe(text) {
  if (!text) return null;
  // Split on markdown patterns, return React elements
  const parts = [];
  // Regex to capture: **bold**, *italic*, `code`, or plain text
  const re = /(\*\*(.+?)\*\*|\*(?!\*)(.+?)(?<!\*)\*|`([^`]+)`)/g;
  let lastIndex = 0;
  let match;
  let keyIdx = 0;

  while ((match = re.exec(text)) !== null) {
    // Push plain text before this match
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      // **bold**
      parts.push(<strong key={`b${keyIdx++}`}>{match[2]}</strong>);
    } else if (match[3]) {
      // *italic*
      parts.push(<em key={`i${keyIdx++}`}>{match[3]}</em>);
    } else if (match[4]) {
      // `code`
      parts.push(<code key={`c${keyIdx++}`} style={{background:"rgba(255,255,255,0.06)",padding:"1px 5px",borderRadius:4,fontSize:"0.9em"}}>{match[4]}</code>);
    }
    lastIndex = match.index + match[0].length;
  }
  // Push remaining text
  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : text;
}
