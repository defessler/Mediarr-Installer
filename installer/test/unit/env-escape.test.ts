import { describe, it, expect } from 'vitest'
import { emitField } from '../helpers/render.js'

// emitField() runs a value through the PRODUCTION renderEnv writer (line() +
// ESCAPE) and returns the raw .env RHS — so these lock the on-the-wire format
// the NAS-side bash/python parsers must read back. The matching round-trip
// against the REAL parsers lives in cross-lang/escape-roundtrip.test.ts; this
// suite pins the exact emitted shape so a regression is caught even without a
// shell.

describe('ESCAPE — values needing no quoting pass through verbatim', () => {
  it('empty stays empty', () => {
    expect(emitField('')).toBe('')
  })
  it('plain alphanumerics + safe punctuation are emitted unquoted', () => {
    for (const v of ['hunter2', 'abc123', 'a@b.com', 'a-b_c.d', 'x=y', '10.2.0.2/32', 'claim-abc']) {
      expect(emitField(v)).toBe(v)
    }
  })
})

describe('ESCAPE — characters that force quoting', () => {
  it('whitespace forces quoting (space + tab preserved literally inside)', () => {
    expect(emitField('a b')).toBe('"a b"')
    expect(emitField('a\tb')).toBe('"a\tb"')
  })
  it('# is quoted — else the NAS readers truncate it as an inline comment', () => {
    expect(emitField('p@ss#word')).toBe('"p@ss#word"')
  })
  it("a single quote is quoted but kept literal: a'b → \"a'b\"", () => {
    expect(emitField("a'b")).toBe(String.raw`"a'b"`)
  })
})

describe('ESCAPE — characters escaped inside the quotes', () => {
  it('double quote → \\"', () => {
    expect(emitField('a"b')).toBe(String.raw`"a\"b"`)
  })
  it('dollar → \\$ (blocks compose ${} expansion)', () => {
    expect(emitField('a$b')).toBe(String.raw`"a\$b"`)
  })
  it('backtick → escaped (blocks command substitution)', () => {
    // String.raw can't carry a backtick; spell the expected out explicitly.
    expect(emitField('a`b')).toBe('"a\\`b"')
  })
  it('backslash → \\\\', () => {
    expect(emitField('a\\b')).toBe(String.raw`"a\\b"`)
  })
  it('newline folds to a literal \\n so the entry never breaks across lines', () => {
    expect(emitField('a\nb')).toBe(String.raw`"a\nb"`)
  })
  it('carriage return folds to a literal \\r', () => {
    expect(emitField('a\rb')).toBe(String.raw`"a\rb"`)
  })
  it('a mixed " $ ` \\ payload is fully escaped in one pass', () => {
    // input chars: a " $ ` \ b  →  "a\"\$\`\\b"
    expect(emitField('a"$`\\b')).toBe('"a\\"\\$\\`\\\\b"')
  })
})
