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
      {/* `message` is the server's own error text - passed through as-is, not translated */}
      <p>{t("Couldn't load this.")} {message}</p>
      {onRetry && <button className="btn-link" onClick={onRetry}>{t('Try again')}</button>}
    </div>
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
