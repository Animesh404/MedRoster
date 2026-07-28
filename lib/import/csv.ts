export interface RawRow {
  rowNumber: number   // 1-based line number in the source file
  raw: string         // the untouched line, shown verbatim in the import report
  cells: string[]     // split but NOT trimmed — normalisation is a later stage
}

/** Splits one CSV line, honouring double-quoted cells and "" escapes. */
function splitLine(line: string): string[] {
  const cells: string[] = []
  let cur = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (ch === '"') inQuotes = false
      else cur += ch
    } else if (ch === '"') inQuotes = true
    else if (ch === ',') { cells.push(cur); cur = '' }
    else cur += ch
  }
  cells.push(cur)
  return cells
}

export function splitCsv(text: string): { header: string[]; rows: RawRow[] } {
  const lines = text.split(/\r?\n/)
  const header = splitLine(lines[0] ?? '').map((h) => h.trim())
  const rows: RawRow[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!
    if (line.trim() === '') continue
    rows.push({ rowNumber: i + 1, raw: line, cells: splitLine(line) })
  }
  return { header, rows }
}
