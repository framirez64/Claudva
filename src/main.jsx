import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Aula from './aula/Aula.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Aula />
  </StrictMode>,
);
