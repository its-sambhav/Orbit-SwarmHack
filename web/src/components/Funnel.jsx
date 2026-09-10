export function Funnel({ funnel }) {
  if (!funnel) return null
  const { recommended, sanctioned, completed, never_sanctioned, sanctioned_never_completed } = funnel
  const max = recommended || 1
  const stages = [
    { label: 'Recommended', value: recommended },
    { label: 'Sanctioned', value: sanctioned },
    { label: 'Completed', value: completed },
  ]

  return (
    <div className="funnel">
      {stages.map((s, i) => (
        <div className="funnel-row" key={s.label}>
          <div className="funnel-label">{s.label}</div>
          <div className="funnel-track">
            <div className="funnel-bar" style={{ width: `${Math.max((s.value / max) * 100, 2)}%` }} />
          </div>
          <div className="funnel-value num">{s.value.toLocaleString('en-IN')}</div>
        </div>
      ))}
      <div className="funnel-dropoffs">
        <span>{never_sanctioned.toLocaleString('en-IN')} never sanctioned</span>
        <span>{sanctioned_never_completed.toLocaleString('en-IN')} sanctioned, never completed</span>
      </div>
    </div>
  )
}
