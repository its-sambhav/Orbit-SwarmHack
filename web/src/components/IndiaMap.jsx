import { useEffect, useMemo, useRef } from 'react'
import { MapContainer, GeoJSON, ZoomControl, useMap } from 'react-leaflet'
import L from 'leaflet'

// Leaflet doesn't observe CSS-driven container resizes (flex/grid panel
// changes, window resize) on its own - without this the map silently
// renders into a stale size until the next manual pan/zoom. This is the
// single biggest cause of a "broken" looking embedded Leaflet map.
function ResizeHandler() {
  const map = useMap()
  useEffect(() => {
    const container = map.getContainer()
    const ro = new ResizeObserver(() => map.invalidateSize())
    ro.observe(container)
    return () => ro.disconnect()
  }, [map])
  return null
}

// fit the map to a feature (or the whole collection) whenever the target changes
function FitBounds({ geojson, keyProp, focusKey }) {
  const map = useMap()
  useEffect(() => {
    if (!geojson) return
    const feature = focusKey
      ? geojson.features.find((f) => f.properties[keyProp] === focusKey)
      : null
    const target = feature ? { type: 'FeatureCollection', features: [feature] } : geojson
    const layer = L.geoJSON(target)
    const bounds = layer.getBounds()
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24] })
  }, [geojson, keyProp, focusKey, map])
  return null
}

// 5-stop sequential "heat" ramp (ColorBrewer YlOrRd family) - a wider,
// more saturated low->high progression than a 3-tone interpolation can give,
// so adjacent percentile bands stay visually distinct instead of blurring
// into muddy in-between tones. Monotonically darkening light gold -> deep
// red, clearly separated from the light-gray no-data fill at the low end.
const RAMP_STOPS = ['#FED976', '#FEB24C', '#FD8D3C', '#F03B20', '#BD0026']
const NO_DATA_FILL = '#E3E6E2'
// neutral light->dark gray, same 5-stop shape as RAMP_STOPS - used instead of
// the amber/red ramp for every feature except the one this map is focused on
// (ConstituencyView's "this seat in context" map), so the focused seat is the
// only thing on screen still in the risk-severity color, and its neighbours
// read purely as a dimmed-out backdrop that still shows relative anomaly
// volume through shade alone, never competing with the focused seat's color.
const GRAY_RAMP_STOPS = ['#EDEFEC', '#D4D8D1', '#A8AFA3', '#767F73', '#3A3F37']

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}
function lerp(a, b, t) {
  const pa = hexToRgb(a), pb = hexToRgb(b)
  return `rgb(${Math.round(pa.r + (pb.r - pa.r) * t)},${Math.round(pa.g + (pb.g - pa.g) * t)},${Math.round(pa.b + (pb.b - pa.b) * t)})`
}
function colorFromStops(stops, t) {
  const segments = stops.length - 1
  const scaled = Math.min(Math.max(t, 0), 1) * segments
  const i = Math.min(Math.floor(scaled), segments - 1)
  return lerp(stops[i], stops[i + 1], scaled - i)
}
function colorForPercentile(t) {
  return colorFromStops(RAMP_STOPS, t)
}
function colorForPercentileGray(t) {
  return colorFromStops(GRAY_RAMP_STOPS, t)
}

/** Rank-based (quantile) scale, not linear-to-max: a linear scale gets
 * dominated by whichever single feature has the highest risk_score and
 * compresses the rest into one indistinguishable shade - a choropleth's
 * entire job is to show relative variation, so it's ranked by percentile
 * among the features actually on screen instead. Recomputing this per level
 * (national vs. one state's constituencies) is deliberate: "highest risk in
 * Bihar" should mean highest among Bihar's own seats, not compressed against
 * the national scale.
 *
 * A *percentile* rank is meaningless with only one feature on screen (or
 * several tied on risk_score) - "highest among 1" isn't a real signal, but
 * ranking it 1 unconditionally previously painted every single-constituency
 * district's map deep red regardless of its actual risk (e.g. a genuinely
 * 0-breach district like Amroha). Below that threshold, fall back to an
 * absolute scale off the real rate instead: breach_rate when the caller has
 * it (state/national/constituency-focus views), else a normalised anomaly
 * count (District view's own heatmap, which has no breach_rate - see
 * DistrictView.jsx's anomalyHeatByKey) - either way, a real 0 stays low, not
 * "rank 1 of 1." */
function usePercentileRanks(dataByKey) {
  return useMemo(() => {
    const entries = Object.entries(dataByKey).sort((a, b) => a[1].risk_score - b[1].risk_score)
    const n = entries.length
    const ranks = {}
    if (n === 0) return ranks

    const uniqueScores = new Set(entries.map(([, v]) => v.risk_score))
    if (n <= 1 || uniqueScores.size <= 1) {
      const sample = entries[0][1]
      const rate = sample.breach_rate ?? Math.min((sample.anomaly_count ?? sample.risk_score ?? 0) / 10, 1)
      const scaledRank = Math.min(Math.max(rate / 0.45, 0.1), 0.95)
      for (const [key] of entries) ranks[key] = scaledRank
      return ranks
    }

    entries.forEach(([key], i) => { ranks[key] = i / (n - 1) })
    return ranks
  }, [dataByKey])
}

/**
 * A single reusable choropleth for every map level (India-by-state,
 * one-state-by-constituency, one-constituency-focused) - the risk data
 * shape (works_total/works_flagged/breach_rate/risk_score) is identical at
 * every level, so only the join key differs.
 *
 * geojson: the FeatureCollection for the current level
 * keyProp: geojson properties field used as the join key ("state" or "pc_id")
 * nameProp: geojson properties field to show as the feature's display name ("state" or "pc_name")
 * dataByKey: { [key]: {works_total, works_flagged, breach_rate, risk_score, ...} }
 * focusKey: when set, zoom to just this one feature and highlight it (constituency focus view); otherwise fit the whole collection
 * onSelect(risk, key, feature): click handler - receives the full risk-data object so the caller decides what to navigate to
 * selectedKey: highlight one feature without focusing/zooming to it
 * tooltipRenderer(risk, name): optional override for the hover tooltip's HTML string, for callers whose dataByKey isn't the works_flagged/works_total/breach_rate shape (falls back to that default when omitted)
 * overlayGeojson: an optional second FeatureCollection drawn on top, non-interactive, styled as one dominant unfilled boundary (the same focus-boundary look used everywhere else in the app) - e.g. a district's own boundary over its constituency-level choropleth
 * backdropGeojson: an optional FeatureCollection drawn *underneath* the main layer, filled solid - for when the main layer's own features (e.g. a district's individual constituencies) are simplified/sourced slightly differently than this true outline and don't tile it edge-to-edge; the backdrop shows through any sliver gap instead of the page background, so the composite still reads as one correctly-shaped region
 * grayscaleUnfocused: when true (and focusKey is set), every feature other than focusKey is shaded on the neutral gray ramp instead of the amber/red risk ramp - the focused seat stays the one colored shape on screen, its neighbours read as a dimmed backdrop that still encodes relative anomaly volume through shade (ConstituencyView's own map only).
 */
export function IndiaMap({ geojson, keyProp, nameProp, dataByKey, focusKey, onSelect, selectedKey, tooltipRenderer, overlayGeojson, backdropGeojson, grayscaleUnfocused }) {
  const layerRef = useRef(null)
  const ranks = usePercentileRanks(dataByKey)

  const style = (feature) => {
    const key = feature.properties[keyProp]
    const risk = dataByKey[key]
    const isFocus = focusKey ? key === focusKey : key === selectedKey
    const useGray = grayscaleUnfocused && focusKey && !isFocus
    return {
      fillColor: risk ? (useGray ? colorForPercentileGray(ranks[key] ?? 0) : colorForPercentile(ranks[key] ?? 0)) : NO_DATA_FILL,
      fillOpacity: risk ? 0.88 : 0.45,
      color: isFocus ? '#2C4A66' : '#FFFFFF',
      weight: isFocus ? 2.5 : 0.6,
    }
  }

  const onEachFeature = (feature, layer) => {
    const key = feature.properties[keyProp]
    const risk = dataByKey[key]
    const name = feature.properties[nameProp]
    // focus mode (single boundary) has no onSelect and no risk data passed
    // in by design - a "no data" tooltip there would be misleading, since
    // the rail beside it does show real figures for this seat.
    if (!risk && !onSelect) return
    if (risk) {
      layer.bindTooltip(
        tooltipRenderer
          ? tooltipRenderer(risk, name)
          : `<strong>${name}</strong><br/>${risk.works_flagged.toLocaleString('en-IN')} / ${risk.works_total.toLocaleString('en-IN')} works flagged &middot; ${(risk.breach_rate * 100).toFixed(0)}%`,
        { sticky: true, className: 'map-tooltip' }
      )

      // Leaflet's SVG renderer gives every feature here a real, focusable
      // <path> (for keyboard a11y) whether or not the caller passed onSelect
      // - a district's own anomaly-heatmap view (no click-through) is just
      // as focusable as a state/constituency one that navigates on click.
      // Clicking one leaves it focused, and with nothing else to draw a
      // selection state the browser falls back to its own default focus
      // ring, rendering as a stray black box around the clicked shape's
      // bounding box. Blur unconditionally; `isFocus`/style() above already
      // draws this app's own selected-outline, so nothing is lost.
      layer.on('click', (e) => {
        e?.originalEvent?.target?.blur?.()
        layer?._path?.blur?.()
        if (onSelect) onSelect(risk, key, feature)
      })
      // stops the browser from ever drawing that focus ring in the first
      // place, rather than only cleaning it up after the fact on click.
      layer.on('mousedown', (e) => e?.originalEvent?.preventDefault?.())

      // hover "pop", same reasoning - every state/district/constituency
      // shape lifts slightly under the cursor regardless of clickability:
      // brought in front of its neighbours, a heavier dark border, and a
      // drop-shadow for a raised look. Reverted via the same style(feature)
      // the layer was drawn with, so it never fights with isFocus's own
      // selected-outline - hovering a selected feature just adds the lift on
      // top of it, and un-hovering always lands back on whatever style()
      // says this feature should be.
      layer.on('mouseover', () => {
        layer.bringToFront()
        layer.setStyle({ weight: 3, color: '#1e293b' })
        layer._path?.classList.add('map-feature-hover')
      })
      layer.on('mouseout', () => {
        layer.setStyle(style(feature))
        layer._path?.classList.remove('map-feature-hover')
      })
    } else {
      layer.bindTooltip(`<strong>${name}</strong><br/>No data for this scope`, { sticky: true, className: 'map-tooltip' })
    }
  }

  const dataKey = useMemo(
    () => `${keyProp}-${geojson?.features?.length ?? 0}-${focusKey ?? 'all'}-${Object.keys(dataByKey).length}-${selectedKey ?? ''}-${grayscaleUnfocused ? 'g' : ''}`,
    [keyProp, geojson, focusKey, dataByKey, selectedKey, grayscaleUnfocused]
  )

  return (
    <MapContainer
      center={[22.5, 80]}
      zoom={4.4}
      minZoom={3.5}
      maxZoom={10}
      style={{ height: '100%', width: '100%', background: 'var(--bg)' }}
      scrollWheelZoom
      attributionControl={false}
      zoomControl={false}
    >
      <ResizeHandler />
      <ZoomControl position="bottomright" />
      {geojson && (
        <>
          {backdropGeojson && (
            <GeoJSON
              data={backdropGeojson}
              interactive={false}
              style={{ fillColor: NO_DATA_FILL, fillOpacity: 0.9, color: NO_DATA_FILL, weight: 0 }}
            />
          )}
          <GeoJSON ref={layerRef} key={dataKey} data={geojson} style={style} onEachFeature={onEachFeature} />
          {overlayGeojson && (
            <GeoJSON
              data={overlayGeojson}
              interactive={false}
              style={{ fillOpacity: 0, color: '#2C4A66', weight: 2.5 }}
            />
          )}
          <FitBounds geojson={geojson} keyProp={keyProp} focusKey={focusKey} />
        </>
      )}
    </MapContainer>
  )
}

export function MapLegend({ grayscaleUnfocused }) {
  return (
    <div className="map-legend">
      <div className="map-legend-ramp" />
      <div className="map-legend-labels">
        <span>Low risk</span>
        <span>High risk</span>
      </div>
      <div className="map-legend-swatch"><span className="swatch-nodata" /> No data</div>
      {grayscaleUnfocused && (
        <div className="map-legend-swatch">
          <span className="swatch-nodata" style={{ background: '#767F73' }} /> Other seats (darker = more anomalies)
        </div>
      )}
    </div>
  )
}
