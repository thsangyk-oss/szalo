import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { BubbleDock, BubblePanel } from './Bubble.tsx'

const hash = window.location.hash

let content
if (hash.startsWith('#/bubble-dock')) {
  content = <BubbleDock />
} else if (hash.startsWith('#/bubble-panel')) {
  content = <BubblePanel />
} else {
  content = <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {content}
  </StrictMode>,
)
