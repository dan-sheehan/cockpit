// Minimal YAML-ish frontmatter parser: handles `key: value` and simple lists. Good enough for SKILL.md / agent files.
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text };
  const raw = text.slice(3, end).trim();
  const body = text.slice(end + 4).replace(/^\r?\n/, '');
  const data = {};
  let currentKey = null;
  for (const line of raw.split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (m) {
      currentKey = m[1];
      let v = m[2].trim();
      if (v === '') { data[currentKey] = ''; continue; }
      if (/^(true|false)$/i.test(v)) v = v.toLowerCase() === 'true';
      else if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      else v = v.replace(/^["']|["']$/g, '');
      data[currentKey] = v;
    } else if (currentKey && /^\s+-\s+/.test(line)) {
      if (!Array.isArray(data[currentKey])) data[currentKey] = data[currentKey] ? [data[currentKey]] : [];
      data[currentKey].push(line.replace(/^\s+-\s+/, '').trim().replace(/^["']|["']$/g, ''));
    } else if (currentKey && /^\s+\S/.test(line) && typeof data[currentKey] === 'string') {
      data[currentKey] = (data[currentKey] + ' ' + line.trim()).trim();
    }
  }
  return { data, body };
}
