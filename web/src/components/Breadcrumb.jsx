import { Link } from 'react-router-dom'
import { useLanguage } from '../i18n'
import { STRINGS } from '../strings'

const BackArrowIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M15 18l-6-6 6-6" />
  </svg>
)

/** items: [{label, to?, onClick?}] - the last item is the current page (plain
 * text, not a link). Earlier items need either `to` (a real route, when this
 * view was reached from elsewhere) or `onClick` (a local state change, when
 * the ancestor level lives on this same page - e.g. India<->state on the map).
 *
 * A back arrow leads the row whenever there's a level to go back to (more
 * than one item) - the same target as clicking the second-to-last segment,
 * just given its own dedicated one-tap affordance at the very start of the
 * drill-down row, below the nav bar. */
export function Breadcrumb({ items }) {
  const { t, td } = useLanguage()
  // most labels are entity data (a state/district/MP/work name) and need
  // td(); a few callers instead pass one of this app's own dotted UI-chrome
  // keys (e.g. 'drawer.map') meant for t() - STRINGS only ever holds the
  // latter, so an exact hit there is what tells the two apart. Without this,
  // a chrome key fell through td()'s English short-circuit and rendered as
  // its own raw key ("drawer.map") instead of the translated word.
  const translateLabel = (label) => (STRINGS[label] ? t(label) : td(label))
  const parent = items.length > 1 ? items[items.length - 2] : null
  return (
    <nav className="breadcrumb" aria-label={t('Breadcrumb')}>
      {parent && (
        parent.to ? (
          <Link className="breadcrumb-back" to={parent.to} aria-label={t('Back to {label}', { label: translateLabel(parent.label) })}>
            <BackArrowIcon />
          </Link>
        ) : (
          <button type="button" className="breadcrumb-back" onClick={parent.onClick} aria-label={t('Back to {label}', { label: translateLabel(parent.label) })}>
            <BackArrowIcon />
          </button>
        )
      )}
      {items.map((item, i) => {
        const isLast = i === items.length - 1
        return (
          <span className="breadcrumb-segment" key={i}>
            {isLast ? (
              <span className="breadcrumb-current">{translateLabel(item.label)}</span>
            ) : item.to ? (
              <Link to={item.to}>{translateLabel(item.label)}</Link>
            ) : (
              <button type="button" className="breadcrumb-link" onClick={item.onClick}>{translateLabel(item.label)}</button>
            )}
            {!isLast && <span className="breadcrumb-sep">/</span>}
          </span>
        )
      })}
    </nav>
  )
}
