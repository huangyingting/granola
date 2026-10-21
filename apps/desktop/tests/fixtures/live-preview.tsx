import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { RecordingBar, RecordingPanel } from '../../src/renderer/Recording.js';
import '../../src/renderer/style.css';

const documentId = new URLSearchParams(window.location.search).get('document');
if (!documentId) throw new Error('Missing isolated fixture document.');
function Fixture() {
  const [selected, setSelected] = useState(documentId!);
  useEffect(() => {
    const change = () => setSelected(window.location.hash.slice(1));
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  return (
    <main>
      <RecordingBar scope={7} />
      <RecordingPanel
        scope={7}
        document={selected}
        beforeStart={async () => true}
        jobs={[]}
      />
    </main>
  );
}
createRoot(document.getElementById('root')!).render(<Fixture />);
