import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  desktopUpdateStateSchema,
  type DesktopUpdateState,
} from '@windows-ai-notes/contracts/updates';
import { UpdateCard } from './Updates.js';

const state = desktopUpdateStateSchema.parse({
  version: 1,
  revision: 1,
  installed_version: '0.1.0',
  phase: 'disabled',
  available_version: null,
  download_bytes: null,
  can_check: false,
  can_download: false,
  can_cancel: false,
  installation_enabled: false,
  cache: null,
  error: null,
});
function render(change: Partial<DesktopUpdateState> = {}, pending = false) {
  return renderToStaticMarkup(
    createElement(UpdateCard, {
      state: { ...state, ...change },
      pending,
      onAction: () => {},
    }),
  );
}
describe('desktop update cards', () => {
  it('explains an unconfigured package without offering update or installation controls', () => {
    const html = render();
    expect(html).toContain('Installed version 0.1.0');
    expect(html).toContain('Updates are not enabled');
    expect(html).toContain('Installation is not available');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('<a ');
  });
  it('offers downloading only when Main has an available candidate', () => {
    const html = render({
      phase: 'available',
      available_version: '0.1.1',
      download_bytes: 2 * 1024 ** 2,
      can_check: true,
      can_download: true,
    });
    expect(html).toContain('Version 0.1.1 is available.');
    expect(html).toContain('2.0 MiB download');
    expect(html).toContain('Check for updates');
    expect(html).toContain('Download update');
    expect(html).not.toContain('Cancel update operation');
    expect(
      render({ ...state, phase: 'available', can_download: true }, true),
    ).toContain('disabled=""');
  });
  it('distinguishes verified staging from installation and exposes cache rejection warnings', () => {
    const html = render({
      phase: 'ready',
      available_version: '0.1.1',
      can_check: true,
      cache: { removed: 1, rejected: 2, incomplete: 3 },
    });
    expect(html).toContain('verified and saved on this device');
    expect(html).toContain('2 cached update(s) could not be accepted');
    expect(html).toContain('3 incomplete download(s) were preserved');
    expect(html).not.toContain('Download update');
    expect(html).not.toContain('Restart to update');
  });
  it('shows explicit errors rather than pretending a failed check found no update', () => {
    const html = render({
      phase: 'failed',
      can_check: true,
      error: {
        code: 'update_response_invalid',
        message: 'The update server response was rejected.',
      },
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('response was rejected');
    expect(html).not.toContain('No newer update');
  });
  it('keeps cleanup visible and does not allow repeat cancellation', () => {
    const html = render({ phase: 'cancelling', can_cancel: false });
    expect(html).toContain('cleaning up this operation');
    expect(html).toContain('Cancel update operation');
    expect(html).toContain('disabled=""');
    const active = render({ phase: 'checking', can_cancel: true });
    expect(active).toContain('Checking for updates');
    expect(active).toContain('Cancel update operation');
  });
});
