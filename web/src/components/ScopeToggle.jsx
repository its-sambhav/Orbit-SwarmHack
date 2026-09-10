export function ScopeToggle({ scopes, value, onChange, includeAll = true }) {
  const options = includeAll
    ? [{ value: 'all', label: 'All scopes' }, ...scopes]
    : scopes
  return (
    <div className="scope-toggle" role="tablist" aria-label="Tenure scope">
      {options.map((s) => (
        <button
          key={s.value}
          role="tab"
          aria-selected={value === s.value}
          className={`scope-toggle-btn${value === s.value ? ' active' : ''}`}
          onClick={() => onChange(s.value)}
        >
          {s.label}
        </button>
      ))}
    </div>
  )
}
