import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { openIntro } from './intro'
import './styles/tokens.css'
import './styles.css'
import './styles/shell.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
// The app has rendered: the intro's logo plays and opens onto it (index.html, src/intro.ts).
requestAnimationFrame(() => requestAnimationFrame(openIntro))
