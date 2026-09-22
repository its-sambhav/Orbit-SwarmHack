import { Link } from 'react-router-dom'

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
  const parent = items.length > 1 ? items[items.length - 2] : null
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      {parent && (
        parent.to ? (
          <Link className="breadcrumb-back" to={parent.to} aria-label={`Back to ${parent.label}`}>
            <BackArrowIcon />
          </Link>
        ) : (
          <button type="button" className="breadcrumb-back" onClick={parent.onClick} aria-label={`Back to ${parent.label}`}>
            <BackArrowIcon />
          </button>
        )
      )}
      {items.map((item, i) => {
        const isLast = i === items.length - 1
        return (
          <span className="breadcrumb-segment" key={i}>
            {isLast ? (
              <span className="breadcrumb-current">{item.label}</span>
            ) : item.to ? (
              <Link to={item.to}>{item.label}</Link>
            ) : (
              <button type="button" className="breadcrumb-link" onClick={item.onClick}>{item.label}</button>
            )}
            {!isLast && <span className="breadcrumb-sep">/</span>}
          </span>
        )
      })}
    </nav>
  )
}
