export function Loading({ label = 'Loading' }) {
  return <div className="state-view state-loading">{label}…</div>
}

export function ErrorView({ message, onRetry }) {
  return (
    <div className="state-view state-error">
      <p>Couldn't load this. {message}</p>
      {onRetry && <button className="btn-link" onClick={onRetry}>Try again</button>}
    </div>
  )
}

export function EmptyState({ title, subtitle }) {
  return (
    <div className="state-view state-empty">
      <p className="state-empty-title">{title}</p>
      {subtitle && <p className="state-empty-subtitle">{subtitle}</p>}
    </div>
  )
}
