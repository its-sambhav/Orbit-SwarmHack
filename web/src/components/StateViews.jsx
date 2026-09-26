import { useLanguage } from '../i18n'

// Every caller passes its label/title/subtitle as plain English (unchanged) -
// translating here means one edit covers every loading, error and empty state
// in the app rather than 30 call sites each importing i18n.
export function Loading({ label = 'Loading' }) {
  const { t } = useLanguage()
  return <div className="state-view state-loading">{t(label)}…</div>
}

export function ErrorView({ message, onRetry }) {
  const { t } = useLanguage()
  return (
    <div className="state-view state-error">
      {/* `message` is the API's own text, passed through unchanged, or one of
          api.js's own messages (server restarting, offline), which t() translates */}
      <p>{t("Couldn't load this.")} {t(message)}</p>
      {onRetry && <button className="btn-link" onClick={onRetry}>{t('Try again')}</button>}
    </div>
  )
}

/** A whole-page message with a way out - the 404 page and the crash page.
 * `title`/`text` are plain English, translated here like the views above. */
export function StatusPage({ code, title, text, children }) {
  const { t } = useLanguage()
  return (
    <main className="status-page">
      <div className="status-page-card">
        <img className="status-page-emblem" src="/emblem.svg" alt="" />
        <p className="status-page-brand">MPLADS Ecosystem</p>
        {code && <p className="status-page-code">{t('Error {code}', { code })}</p>}
        <h1>{t(title)}</h1>
        <p className="status-page-text">{t(text)}</p>
        <div className="status-page-actions">{children}</div>
      </div>
    </main>
  )
}

export function EmptyState({ title, subtitle }) {
  const { t } = useLanguage()
  return (
    <div className="state-view state-empty">
      <p className="state-empty-title">{t(title)}</p>
      {subtitle && <p className="state-empty-subtitle">{t(subtitle)}</p>}
    </div>
  )
}
