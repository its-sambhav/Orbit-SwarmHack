import { Link } from 'react-router-dom'
import { getSession, homePath } from '../api'
import { StatusPage } from '../components/StateViews'
import { useLanguage } from '../i18n'

/** Any URL no route matches: says so, and offers the way back - a signed-in
 * desk's own dashboard, or the sign-in page. */
export function NotFoundView() {
  const { t } = useLanguage()
  const auth = getSession()
  return (
    <StatusPage code={404} title="Page not found" text="The page you're looking for doesn't exist or has moved.">
      <Link className="status-page-action" to={auth ? homePath(auth) : '/'}>
        {t(auth ? 'Go to your dashboard' : 'Go to sign-in')}
      </Link>
    </StatusPage>
  )
}
