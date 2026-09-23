import { strict as assert } from 'node:assert'
import { LANGUAGES as LANGS_DEF, STRINGS } from './strings.js'

const LANGS = LANGS_DEF.map((l) => l.code)

// 1. every entry carries every language
for (const [key, row] of Object.entries(STRINGS)) {
  for (const lang of LANGS) {
    assert.equal(typeof row[lang], 'string', `${key}: missing ${lang}`)
    assert.notEqual(row[lang].trim(), '', `${key}: empty ${lang}`)
  }
}

// 2. every {placeholder} in English survives into all 8 translations - a
//    dropped one silently renders a blank where a number should be
const holes = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',')
for (const [key, row] of Object.entries(STRINGS)) {
  for (const lang of LANGS) {
    assert.equal(holes(row[lang]), holes(row.en), `${key}: ${lang} placeholders differ from en`)
  }
}

// 3. keys look like what they are: dotted chrome keys, or the English source
//    string. A key that is neither is a typo that would render as itself.
for (const key of Object.keys(STRINGS)) {
  assert.ok(key.length > 0, 'empty key in STRINGS')
  if (/^[a-zA-Z]+\.[a-zA-Z0-9]+$/.test(key)) continue          // dotted chrome key
  assert.equal(key, STRINGS[key].en, `key must equal its own English text: ${key}`)
}

// 4. t()'s own behaviour: lookup, fallback to en, fallback to the key itself
//    (an untranslated string must render as readable English, never "foo.bar"),
//    and {placeholder} substitution.
const t = (lang) => (key, params) => {
  const text = STRINGS[key]?.[lang] ?? STRINGS[key]?.en ?? key ?? ''
  return params ? text.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m)) : text
}
assert.equal(t('hi')('High'), 'उच्च')
assert.equal(t('en')('High'), 'High')
assert.equal(t('te')('An untranslated sentence.'), 'An untranslated sentence.')
assert.equal(t('en')('{n} anomalies', { n: '20,356' }), '20,356 anomalies')
assert.equal(t('ta')('Work #{n}', { n: 42 }), 'பணி #42')
assert.equal(t('hi')('{n} anomalies'), '{n} विसंगतियां')  // no params -> translated, hole left visible, never blank
assert.equal(t('hi')(''), '')
assert.equal(t('hi')(undefined), '')

console.log(`ok - ${Object.keys(STRINGS).length} strings x ${LANGS.length} languages`)
