import { useLanguage } from '../i18n'

export function ScopeToggle({ scopes, value, onChange, includeAll = true, size }) {
  const { t } = useLanguage()
  const options = includeAll
    ? [{ value: 'all', label: t('scope.allScopes') }, ...scopes]
    : scopes
  return (
    <div className={`scope-toggle${size === 'sm' ? ' scope-toggle-sm' : ''}`} role="tablist" aria-label={t('Tenure scope')}>
      {options.map((s) => (
        <button
          key={s.value}
          role="tab"
          aria-selected={value === s.value}
          className={`scope-toggle-btn${value === s.value ? ' active' : ''}`}
          onClick={() => onChange(s.value)}
        >
          {t(s.label)}
        </button>
      ))}
    </div>
  )
}
