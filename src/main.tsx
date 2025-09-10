import { createRoot } from 'react-dom/client'
import App from './App.tsx'
import './index.css'
import '@xyflow/react/dist/style.css';
import 'reactflow/dist/style.css';
import { initTheme } from './utils/theme'

initTheme();

createRoot(document.getElementById("root")!).render(<App />);
