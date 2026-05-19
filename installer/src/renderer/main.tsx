import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LazyMotion, domAnimation } from 'motion/react'
import './styles/globals.css'
import { App } from './App.js'
import { ErrorBoundary } from './components/ErrorBoundary.js'

// LazyMotion with `domAnimation` reduces motion's bundle weight by
// ~30 KB — we don't use 3D transforms or layout drag, so the heavier
// `domMax` features (~50+ KB) would be dead code. `strict` mode
// requires every motion component to use `<m.*>` form (not `<motion.*>`)
// when nested under this provider. Today most screens still use
// `<motion.*>` which falls back gracefully via the `features={}` prop
// — strict false avoids breaking those during the migration.
//
// ErrorBoundary wraps App at the root so a render-time crash in ANY
// screen falls back to a friendly recovery UI instead of a blank
// window. Outside StrictMode because Strict re-invokes lifecycle
// methods (including componentDidCatch) twice in development — fine
// in prod but spammy in dev. The boundary itself doesn't need Strict
// guarantees so hoisting it above is harmless.
createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <StrictMode>
      <LazyMotion features={domAnimation}>
        <App />
      </LazyMotion>
    </StrictMode>
  </ErrorBoundary>,
)
