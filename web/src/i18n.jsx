import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { api } from './api'
import { LANGUAGES, STRINGS } from './strings'

export { LANGUAGES }

const STORAGE_KEY = 'mplads_lang'
const DATA_CACHE_KEY = 'mplads_data_translations'
// a browser-side mirror of the server's own translation cache (api/translate.py
// holds the real one). It only saves a round trip, so it is capped and any
// storage failure is ignored rather than surfaced.
const DATA_CACHE_LIMIT = 4000
// must not exceed api/translate.py's MAX_TEXTS_PER_REQUEST. A directory page
// can need well over this many strings at once, and anything past the
// server's own cap would be dropped while still counting as asked-for here -
// so the queue is chunked to fit rather than sent in one oversized request.
const REQUEST_CHUNK = 400
const LanguageContext = createContext(null)

// {name} placeholders - filled after the language lookup, so a translation can
// put them in whatever order that language needs.
function interpolate(text, params) {
  if (!params) return text
  return text.replace(/\{(\w+)\}/g, (m, k) => (params[k] !== undefined ? String(params[k]) : m))
}

function loadCache() {
  try { return JSON.parse(localStorage.getItem(DATA_CACHE_KEY)) || {} } catch { return {} }
}

/**
 * Translations for the DATA the dashboard renders - work descriptions and the
 * place/person/agency names the source CSVs only carry in English. STRINGS
 * cannot cover those: they are hundreds of thousands of rows of free text, not
 * UI copy, so they go to api/translate.py instead.
 *
 * This lives outside React on purpose. td() is called during render and has to
 * record which strings that render needs - exactly the kind of write a
 * component may not make to its own state or refs mid-render. A plain external
 * store read through useSyncExternalStore is the supported way to do it:
 * renders stay pure, and the fetching is driven from here.
 */
const dataStore = {
  cache: loadCache(),        // { [lang]: { [english]: translated } }
  pending: new Set(),        // needed by a render, not yet requested
  requested: new Set(),      // already sent (or failed) - never queued twice
  listeners: new Set(),
  timer: null,
  lang: 'en',

  subscribe(fn) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  },
  // `cache` is replaced, never mutated, so its identity is the snapshot
  getSnapshot() { return this.cache },

  setLang(lang) {
    if (this.lang === lang) return
    this.lang = lang
    this.pending.clear()     // whatever was queued was for the previous language
  },

  queue(lang, text) {
    if (lang === 'en' || this.requested.has(`${lang}\u0000${text}`) || this.pending.has(text)) return
    this.pending.add(text)
    if (this.timer) return
    // td() runs once per string per render; the request goes out on a short
    // timer once the pass has settled, so a whole page is one call rather than
    // one call per string.
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, 120)
  },

  flush() {
    const lang = this.lang
    const texts = [...this.pending]
    this.pending.clear()
    if (!texts.length || lang === 'en') return

    for (let i = 0; i < texts.length; i += REQUEST_CHUNK) {
      const chunk = texts.slice(i, i + REQUEST_CHUNK)
      // marked only for the chunk actually going out, so nothing is recorded
      // as asked-for that was never sent
      for (const text of chunk) this.requested.add(`${lang}\u0000${text}`)

      api.translate(lang, chunk).then(({ translations }) => {
        if (!translations || !Object.keys(translations).length) return
        if (this.lang !== lang) return   // language changed mid-flight
        this.cache = { ...this.cache, [lang]: { ...this.cache[lang], ...translations } }
        this.persist()
        for (const fn of this.listeners) fn()
      }).catch(() => { /* stays English - a failed translation is not a broken page */ })
    }
  },

  persist() {
    try {
      // localStorage has a hard quota and this cache is an optimisation, not
      // the source of truth - keep only the most recent entries per language.
      const trimmed = {}
      for (const [code, entries] of Object.entries(this.cache)) {
        const keys = Object.keys(entries)
        trimmed[code] = keys.length <= DATA_CACHE_LIMIT
          ? entries
          : Object.fromEntries(keys.slice(-DATA_CACHE_LIMIT).map((k) => [k, entries[k]]))
      }
      localStorage.setItem(DATA_CACHE_KEY, JSON.stringify(trimmed))
    } catch { /* quota / private mode - the server cache still makes this fast */ }
  },
}

export function LanguageProvider({ children }) {
  const [lang, setLang] = useState(() => {
    try { return localStorage.getItem(STORAGE_KEY) || 'en' } catch { return 'en' }
  })
  const dataCache = useSyncExternalStore(
    (fn) => dataStore.subscribe(fn),
    () => dataStore.getSnapshot(),
    () => dataStore.getSnapshot(),
  )

  useEffect(() => {
    dataStore.setLang(lang)
    try { localStorage.setItem(STORAGE_KEY, lang) } catch { /* private mode etc. - just stays session-only */ }
  }, [lang])

  const value = useMemo(() => {
    const t = (key, params) => interpolate(STRINGS[key]?.[lang] ?? STRINGS[key]?.en ?? key ?? '', params)

    /** Translate a DATA string (from the API/CSVs, not from strings.js). Returns
     * the English original until the translation arrives, then re-renders with
     * it - the page is never blocked, and a translation that never arrives just
     * leaves readable English behind. */
    const td = (text) => {
      if (text == null || text === '') return text
      const str = String(text)
      if (lang === 'en') return str
      // a hand-written UI translation always wins: it is reviewed, free and
      // instant, and this stops us paying to translate a string we already know
      const ui = STRINGS[str]?.[lang]
      if (ui) return ui
      const hit = dataCache[lang]?.[str]
      if (hit) return hit
      dataStore.queue(lang, str)
      return str
    }

    return { lang, setLang, languages: LANGUAGES, t, td }
  }, [lang, dataCache])

  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>
}

export function useLanguage() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used within a LanguageProvider')
  return ctx
}
