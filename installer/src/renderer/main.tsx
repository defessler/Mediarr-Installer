import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { LazyMotion, domAnimation } from 'motion/react'
import './styles/globals.css'
import { App } from './App.js'

// LazyMotion with `domAnimation` reduces motion's bundle weight by
// ~30 KB — we don't use 3D transforms or layout drag, so the heavier
// `domMax` features (~50+ KB) would be dead code. `strict` mode
// requires every motion component to use `<m.*>` form (not `<motion.*>`)
// when nested under this provider. Today most screens still use
// `<motion.*>` which falls back gracefully via the `features={}` prop
// — strict false avoids breaking those during the migration.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LazyMotion features={domAnimation}>
      <App />
    </LazyMotion>
  </StrictMode>,
)
