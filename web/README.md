# MPLADS Ecosystem - frontend

React 19 + Vite + Leaflet. The full setup, roles and API are in the [root README](../README.md).

```bash
npm install
npm run dev      # http://localhost:5173, proxies /api and /static to the API on :8000
npm test         # every string present in all 9 languages, placeholders intact
npm run lint     # oxlint
npm run build    # production build into dist/
```

- `src/views/` - one file per page (dashboards, maps, anomalies, case file, reports)
- `src/components/` - shared cards, charts and navigation
- `src/strings.js` - UI text in the 9 languages; `src/i18n.jsx` provides `t()`
- `src/api.js` - API client and sign-in token handling
