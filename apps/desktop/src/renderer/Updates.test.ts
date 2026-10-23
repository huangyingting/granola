import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  desktopUpdateStateSchema,
  type DesktopUpdateState,
} from '@windows-ai-notes/contracts/updates';
import { RecoveryRecords, UpdateCard } from './Updates.js';

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
  can_inspect: false,
  inspection: null,
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
  it('offers only read-only inspection after blocked startup without enabling installation', () => {
    const html = render({
      phase: 'failed',
      can_inspect: true,
      error: {
        code: 'update_recovery_required',
        message: 'Storage stays blocked.',
      },
    });
    expect(html).toContain('Inspect recovery records');
    expect(html).toContain('Storage stays blocked.');
    expect(html).not.toContain('Restart to update');
    expect(html).not.toContain('Clear recovery');
  });
  it('distinguishes an empty inspection from permission to start storage', () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryRecords, {
        report: {
          checked_at: '2026-01-01T00:00:00.000Z',
          status: 'complete',
          active: 0,
          retired: 0,
          unverifiable: 0,
          limited: false,
          omitted: 0,
          sessions: [],
        },
      }),
    );
    expect(html).toContain('No update session records were found');
    expect(html).toContain('This does not authorize startup');
    expect(html).toContain('verify current payload files');
    expect(html).not.toContain('<button');
  });
  it('surfaces unresolved, unverifiable and truncated records without repair or deletion controls', () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryRecords, {
        report: {
          checked_at: '2026-01-01T00:00:00.000Z',
          status: 'partial',
          active: 129,
          retired: 0,
          unverifiable: 1,
          limited: true,
          omitted: 97,
          sessions: [
            {
              location: 'active',
              session_id: '00000000-0000-4000-8000-000000000001',
              status: 'recovery_required',
              current_version: '0.1.0',
              offered_version: '0.1.1',
              updated_at: '2026-01-01T00:00:00.000Z',
              code: 'update_recovery_required',
            },
            {
              location: 'active',
              session_id: null,
              status: 'unverifiable',
              current_version: null,
              offered_version: null,
              updated_at: null,
              code: 'update_recovery_invalid',
            },
            ...Array.from({ length: 30 }, (_, index) => ({
              location: 'active' as const,
              session_id: `00000000-0000-4000-8000-${(index + 2).toString().padStart(12, '0')}`,
              status: 'uncommitted' as const,
              current_version: null,
              offered_version: null,
              updated_at: '2026-01-01T00:00:00.000Z',
              code: 'update_runtime_staged',
            })),
          ],
        },
      }),
    );
    expect(html).toContain('Startup stays blocked');
    expect(html).toContain('Record not verified');
    expect(html).toContain('Uncertain records were preserved');
    expect(html).toContain('safety limit');
    expect(html).toContain('97 additional record(s)');
    expect(html).toContain('<details>');
    expect(html).not.toContain('<button');
  });
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
