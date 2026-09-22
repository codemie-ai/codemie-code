import type { CodeMieClient, Workflow } from 'codemie-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  findWorkflowByExactName,
  resolveWorkflowIdFromIdOrName,
  resumeWorkflowExecution,
} from './workflows.js';

function createClient(workflows: Workflow[], getWorkflow?: (id: string) => Promise<Workflow>): CodeMieClient {
  return {
    workflows: {
      list: vi.fn().mockResolvedValue(workflows),
      get: vi.fn().mockImplementation(getWorkflow ?? (async () => workflows[0])),
    },
  } as unknown as CodeMieClient;
}

function workflow(id: string, name: string): Workflow {
  return { id, name } as Workflow;
}

describe('workflow resolution services', () => {
  it('resolves an ID through the workflow get service', async () => {
    const expected = workflow('workflow-id', 'Workflow');
    const client = createClient([], async () => expected);

    await expect(resolveWorkflowIdFromIdOrName(client, 'workflow-id')).resolves.toBe('workflow-id');
    expect(client.workflows.get).toHaveBeenCalledWith('workflow-id');
    expect(client.workflows.list).not.toHaveBeenCalled();
  });

  it('resolves a name only through an exact case-insensitive match', async () => {
    const client = createClient(
      [workflow('workflow-id', 'My Workflow'), workflow('other-id', 'My Workflow Extra')],
      async () => {
        throw new Error('not found');
      },
    );

    await expect(findWorkflowByExactName(client, 'my workflow')).resolves.toEqual(
      workflow('workflow-id', 'My Workflow'),
    );
  });

  it('rejects a name when no exact match exists', async () => {
    const client = createClient([workflow('other-id', 'Other Workflow')]);

    await expect(findWorkflowByExactName(client, 'Missing Workflow')).rejects.toThrow(
      'Workflow with name "Missing Workflow" was not found',
    );
  });

  it('resumes an execution through the public SDK method when no edit is provided', async () => {
    const resume = vi.fn().mockResolvedValue(undefined);
    const client = {
      workflows: {
        executions: vi.fn().mockReturnValue({ resume }),
      },
    } as unknown as CodeMieClient;

    await resumeWorkflowExecution(client, 'workflow-id', 'execution-id');

    expect(resume).toHaveBeenCalledWith('execution-id');
  });

  it('resumes an execution with edited input through the workflow service', async () => {
    const put = vi.fn().mockResolvedValue(undefined);
    const client = {
      workflows: {
        api: { put },
        executions: vi.fn(),
      },
    } as unknown as CodeMieClient;

    await resumeWorkflowExecution(client, 'workflow-id', 'execution-id', 'edited message');

    expect(put).toHaveBeenCalledWith(
      '/v1/workflows/workflow-id/executions/execution-id/resume',
      { user_input: 'edited message' },
    );
  });
});
