export interface RawRow {
  rowNumber: number   // 1-based line number where the record STARTS in the source file
  raw: string         // the untouched record text (may include embedded newlines), shown verbatim in the import report
  cells: string[]     // split but NOT trimmed — normalisation is a later stage
}

/** One physical-or-logical CSV record produced by the scanner below. */
interface Record_ {
  startLine: number
  raw: string
  cells: string[]
}

/**
 * Scans the whole input in a single character-by-character pass, honouring
 * RFC4180-ish quoting:
 *  - A `"` only opens a quoted section when it appears at the START of a
 *    field (i.e. nothing has been accumulated into the current cell yet).
 *    A `"` anywhere else in an unquoted field is a literal character — this
 *    is what stops a stray quote / inch-mark from swallowing the rest of
 *    the line (see Finding 1).
 *  - Inside a quoted section, `""` is an escaped literal quote, a lone `"`
 *    closes the section, and a literal newline (`\n` or `\r\n`) is data,
 *    not a record separator — this lets a quoted cell legitimately span
 *    multiple physical lines (see Finding 2). `rowNumber` for such a
 *    record is the line on which it STARTED; `raw` is the full record
 *    text including the embedded newline(s), with the terminating
 *    newline of the record itself excluded (matching plain single-line
 *    records, whose `raw` never included the trailing `\r?\n` either).
 *  - Outside a quoted section, `\n` or `\r\n` ends the current record.
 *  - An unterminated quote at EOF does not throw: the quoted section is
 *    simply treated as running to the end of the input, so whatever was
 *    accumulated becomes the last cell of the last record.
 */
function scanRecords(text: string): Record_[] {
  const records: Record_[] = []
  const n = text.length

  let cells: string[] = []
  let cur = ''
  let inQuotes = false
  let line = 1
  let recordStartLine = 1
  let recordStartIndex = 0
  let i = 0

  const endRecord = (endIndex: number): void => {
    cells.push(cur)
    records.push({ startLine: recordStartLine, raw: text.slice(recordStartIndex, endIndex), cells })
    cells = []
    cur = ''
  }

  while (i < n) {
    const ch = text[i]!

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 2; continue }
        inQuotes = false
        i++
        continue
      }
      if (ch === '\n') line++
      cur += ch
      i++
      continue
    }

    if (ch === '"' && cur === '') { inQuotes = true; i++; continue }

    if (ch === ',') { cells.push(cur); cur = ''; i++; continue }

    if (ch === '\r' && text[i + 1] === '\n') {
      endRecord(i)
      i += 2
      line++
      recordStartLine = line
      recordStartIndex = i
      continue
    }
    if (ch === '\n') {
      endRecord(i)
      i++
      line++
      recordStartLine = line
      recordStartIndex = i
      continue
    }

    cur += ch
    i++
  }

  // Trailing record with no terminating newline (only if there's leftover
  // content since the last one — an input that ends exactly on a newline
  // must NOT produce a phantom empty final record).
  if (n > recordStartIndex) endRecord(n)

  return records
}

export function splitCsv(text: string): { header: string[]; rows: RawRow[] } {
  if (text.trim() === '') return { header: [], rows: [] }

  const records = scanRecords(text)
  const header = (records[0]?.cells ?? []).map((h) => h.trim())
  const rows: RawRow[] = []

  for (let idx = 1; idx < records.length; idx++) {
    const record = records[idx]!
    if (record.raw.trim() === '') continue
    rows.push({ rowNumber: record.startLine, raw: record.raw, cells: record.cells })
  }
  return { header, rows }
}
