/**
 * Markdown-like formatting parser for the composer.
 *
 * Converts inline markers in the user's text into the styles[] array that
 * zca-js's sendMessage understands, and returns the *cleaned* text (markers
 * stripped) that should actually be sent.
 *
 * Supported syntax (mirrors what most chat apps use):
 *   **text**  → Bold       ("b")
 *   *text*    → Italic     ("i")
 *   __text__  → Underline  ("u")
 *   ~~text~~  → Strike     ("s")
 *
 * The TextStyle codes match zca-js's TextStyle enum.
 */

export type ZaloStyle = {
  start: number
  len: number
  st: 'b' | 'i' | 'u' | 's'
}

type Pattern = { regex: RegExp; st: ZaloStyle['st']; markerLen: number }

// Order matters: longer markers first so ** beats * and __ beats _.
const PATTERNS: Pattern[] = [
  { regex: /\*\*([^*\n]+?)\*\*/g, st: 'b', markerLen: 2 },
  { regex: /__([^_\n]+?)__/g, st: 'u', markerLen: 2 },
  { regex: /~~([^~\n]+?)~~/g, st: 's', markerLen: 2 },
  { regex: /(?<![*])\*([^*\n]+?)\*(?![*])/g, st: 'i', markerLen: 1 },
]

export function parseStyles(input: string): { text: string; styles: ZaloStyle[] } {
  let text = input
  const styles: ZaloStyle[] = []

  for (const { regex, st, markerLen } of PATTERNS) {
    // We rebuild the string left-to-right because each replacement shifts indexes.
    let cursor = 0
    let result = ''
    let match: RegExpExecArray | null
    const pattern = new RegExp(regex.source, regex.flags)
    while ((match = pattern.exec(text)) !== null) {
      const inner = match[1]
      const matchStart = match.index
      result += text.slice(cursor, matchStart)
      const stylePos = result.length
      result += inner
      // Adjust prior style positions that fell after this match's start
      for (const s of styles) {
        if (s.start > matchStart) s.start -= markerLen * 2
      }
      styles.push({ start: stylePos, len: inner.length, st })
      cursor = matchStart + match[0].length
      pattern.lastIndex = cursor
    }
    result += text.slice(cursor)
    text = result
  }

  styles.sort((a, b) => a.start - b.start)
  return { text, styles }
}

/**
 * Wrap the current selection (or insert empty markers at the cursor) with
 * a Markdown-like marker. Used by the format toolbar in the composer.
 *
 * Returns the new text and the cursor positions to apply via setSelectionRange.
 */
export function applyFormatting(
  current: string,
  selectionStart: number,
  selectionEnd: number,
  marker: '**' | '*' | '__' | '~~',
): { text: string; selectionStart: number; selectionEnd: number } {
  const before = current.slice(0, selectionStart)
  const middle = current.slice(selectionStart, selectionEnd)
  const after = current.slice(selectionEnd)
  const text = `${before}${marker}${middle}${marker}${after}`
  if (middle) {
    // Selection wrapped; place cursor after the closing marker.
    const newEnd = before.length + marker.length + middle.length + marker.length
    return { text, selectionStart: newEnd, selectionEnd: newEnd }
  }
  // Empty selection: place cursor between the two markers so the user can type.
  const between = before.length + marker.length
  return { text, selectionStart: between, selectionEnd: between }
}
