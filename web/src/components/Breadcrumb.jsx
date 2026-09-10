import { Link } from 'react-router-dom'

/** items: [{label, to?, onClick?}] - the last item is the current page (plain
 * text, not a link). Earlier items need either `to` (a real route, when this
 * view was reached from elsewhere) or `onClick` (a local state change, when
 * the ancestor level lives on this same page - e.g. India<->state on the map). */
export function Breadcrumb({ items }) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
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
