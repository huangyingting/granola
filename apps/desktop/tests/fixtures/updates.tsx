import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DesktopBridge } from '@windows-ai-notes/contracts/desktop';
import { Updates } from '../../src/renderer/Updates.js';
import '../../src/renderer/style.css';

declare global {
  interface Window {
    notes: DesktopBridge;
  }
}
function Fixture() {
  const [visible, setVisible] = useState(true);
  return (
    <>
      <button onClick={() => setVisible(!visible)}>Toggle update panel</button>
      {visible && <Updates bridge={window.notes} />}
    </>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
