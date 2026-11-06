import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

// StrictMode is intentionally off: it would mount the Phaser game twice in development.
createRoot(document.getElementById('root')!).render(<App />);
