import { Component } from 'react'
import { getSession, homePath } from '../api'
import { useLanguage } from '../i18n'
import { StatusPage } from './StateViews'

// plain links, not the router: after a crash a full page load is the reset
function CrashPage() {
  const { t } = useLanguage()
  const auth = getSession()
  return (
    <StatusPage title="Something went wrong" text="The page hit an unexpected error. Reload to try again.">
      <button type="button" className="status-page-action" onClick={() => window.location.reload()}>{t('Reload')}</button>
      <a className="status-page-action secondary" href={auth ? homePath(auth) : '/'}>
        {t(auth ? 'Go to your dashboard' : 'Go to sign-in')}
      </a>
    </StatusPage>
  )
}

/** Catches a render error anywhere below it and shows a recovery page
 * instead of a blank screen; the error itself still goes to the console. */
export class ErrorBoundary extends Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error, info) {
    console.error(error, info.componentStack)
  }

  render() {
    return this.state.failed ? <CrashPage /> : this.props.children
  }
}
