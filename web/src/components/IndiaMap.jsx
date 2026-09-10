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

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}
function lerp(a, b, t) {
  const pa = hexToRgb(a), pb = hexToRgb(b)
  return `rgb(${Math.round(pa.r + (pb.r - pa.r) * t)},${Math.round(pa.g + (pb.g - pa.g) * t)},${Math.round(pa.b + (pb.b - pa.b) * t)})`
}
function colorForPercentile(t) {
  const segments = RAMP_STOPS.length - 1
  const scaled = Math.min(Math.max(t, 0), 1) * segments
  const i = Math.min(Math.floor(scaled), segments - 1)
  return lerp(RAMP_STOPS[i], RAMP_STOPS[i + 1], scaled - i)
}

/** Rank-based (quantile) scale, not linear-to-max: a linear scale gets
 * dominated by whichever single feature has the highest risk_score and
 * compresses the rest into one indistinguishable shade - a choropleth's
 * entire job is to show relative variation, so it's ranked by percentile
 * among the features actually on screen instead. Recomputing this per level
 * (national vs. one state's constituencies) is deliberate: "highest risk in
 * Bihar" should mean highest among Bihar's own seats, not compressed against
 * the national scale. */
function usePercentileRanks(dataByKey) {
  return useMemo(() => {
    const entries = Object.entries(dataByKey).sort((a, b) => a[1].risk_score - b[1].risk_score)
    const n = entries.length
    const ranks = {}
    entries.forEach(([key], i) => { ranks[key] = n > 1 ? i / (n - 1) : 1 })
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
 */
export function IndiaMap({ geojson, keyProp, nameProp, dataByKey, focusKey, onSelect, selectedKey }) {
  const layerRef = useRef(null)
  const ranks = usePercentileRanks(dataByKey)

  const style = (feature) => {
    const key = feature.properties[keyProp]
    const risk = dataByKey[key]
    const isFocus = focusKey ? key === focusKey : key === selectedKey
    return {
      fillColor: risk ? colorForPercentile(ranks[key] ?? 0) : NO_DATA_FILL,
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
    if (!onSelect) return
    layer.bindTooltip(
      risk
        ? `<strong>${name}</strong><br/>${risk.works_flagged.toLocaleString('en-IN')} / ${risk.works_total.toLocaleString('en-IN')} works flagged &middot; ${(risk.breach_rate * 100).toFixed(0)}%`
        : `<strong>${name}</strong><br/>No data for this scope`,
      { sticky: true, className: 'map-tooltip' }
    )
    if (risk) layer.on('click', () => onSelect(risk, key, feature))
  }

  const dataKey = useMemo(
    () => `${keyProp}-${geojson?.features.length ?? 0}-${focusKey ?? 'all'}-${Object.keys(dataByKey).length}-${selectedKey ?? ''}`,
    [keyProp, geojson, focusKey, dataByKey, selectedKey]
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
          <GeoJSON ref={layerRef} key={dataKey} data={geojson} style={style} onEachFeature={onEachFeature} />
          <FitBounds geojson={geojson} keyProp={keyProp} focusKey={focusKey} />
        </>
      )}
    </MapContainer>
  )
}

export function MapLegend() {
  return (
    <div className="map-legend">
      <div className="map-legend-ramp" />
      <div className="map-legend-labels">
        <span>Low risk</span>
        <span>High risk</span>
      </div>
      <div className="map-legend-swatch"><span className="swatch-nodata" /> No data</div>
    </div>
  )
}
