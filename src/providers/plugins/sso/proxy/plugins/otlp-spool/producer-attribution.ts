/** Producer-owned analytics evidence crosses the shared spool boundary before any events are appended. */
import { ConfigurationError } from '@/utils/errors.js';
import { withSessionLock } from './session-lock.js';
import { createStatus, readStatusState, writeStatus, type ProducerAttribution } from './session-status.js';

/** Preserve delivery progress and refuse to replace an unreadable status or another project's binding. */
export async function publishProducerAttribution(sessionId: string, attribution: ProducerAttribution): Promise<void> {
  await withSessionLock(sessionId, async () => {
    const found = await readStatusState(sessionId);
    if (found.kind === 'unreadable') throw new ConfigurationError('Analytics session status is unreadable; retrying without appending');
    const status = found.kind === 'ok' ? found.status : createStatus();
    const boundProject = status.project ?? status.producerAttribution?.project;
    if (boundProject && boundProject.toLowerCase() !== attribution.project.toLowerCase()) {
      throw new ConfigurationError('Producer attribution differs from the spool project');
    }
    if (status.producerAttribution) return;
    status.producerAttribution = { ...attribution };
    await writeStatus(sessionId, status);
  });
}
