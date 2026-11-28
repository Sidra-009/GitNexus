import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createReindexInFlightTracker,
  EVAL_SERVER_TOOLS,
  handleReindexRequest,
  rejectUnauthorizedRequest,
  reindexErrorStatus,
  reindexRepository,
} from '../../src/cli/eval-server.js';
import type { LocalBackend } from '../../src/mcp/local/local-backend.js';
import type http from 'node:http';

function backendMock() {
  return {
    listRepos: vi.fn().mockResolvedValue([{ name: 'GitNexus' }]),
    callTool: vi.fn(),
  } as unknown as LocalBackend & {
    listRepos: ReturnType<typeof vi.fn>;
    callTool: ReturnType<typeof vi.fn>;
  };
}

function requestMock(headers: Record<string, string> = {}) {
  const stream = new PassThrough() as PassThrough & {
    headers: Record<string, string>;
  };
  stream.headers = headers;
  return { stream, req: stream as unknown as http.IncomingMessage };
}

function responseMock() {
  return {
    setHeader: vi.fn(),
    writeHead: vi.fn(),
    end: vi.fn(),
  };
}

function requestDeps(overrides: Partial<Parameters<typeof handleReindexRequest>[2]> = {}) {
  return {
    backend: backendMock(),
    authToken: 'secret',
    refreshEnabled: true,
    tracker: createReindexInFlightTracker(),
    ...overrides,
  };
}

function responseStatus(response: ReturnType<typeof responseMock>): number | undefined {
  return response.writeHead.mock.calls[0]?.[0];
}

describe('eval-server POST /reindex', () => {
  it('returns only the documented success fields mapped from refresh_index', async () => {
    const backend = backendMock();
    backend.callTool.mockResolvedValue({
      status: 'refreshed',
      repo: 'GitNexus',
      durationMs: 123,
      indexedAt: '2026-11-27T00:00:00.000Z',
      lastCommit: 'abc123',
      staleness: { status: 'current' },
      stats: { files: 4 },
      extra: 'not forwarded',
    });

    const result = await reindexRepository(backend, '{"repo":"GitNexus"}', true);

    expect(result).toEqual({
      statusCode: 200,
      payload: {
        status: 'refreshed',
        repo: 'GitNexus',
        duration_ms: 123,
        indexedAt: '2026-11-27T00:00:00.000Z',
        lastCommit: 'abc123',
        staleness: { status: 'current' },
        stats: { files: 4 },
      },
    });
    expect(backend.callTool).toHaveBeenCalledWith('refresh_index', { repo: 'GitNexus' });
  });

  it('is opt-in and names the required environment variable when disabled', async () => {
    const backend = backendMock();
    const result = await reindexRepository(backend, '{"repo":"GitNexus"}', false);
    expect(result.statusCode).toBe(403);
    expect(result.payload.error).toContain('GITNEXUS_MCP_ENABLE_REFRESH=1');
    expect(backend.listRepos).not.toHaveBeenCalled();
  });

  it.each(['', '{', 'null', '[]'])('rejects invalid JSON input %j', async (body) => {
    const result = await reindexRepository(backendMock(), body, true);
    expect(result.statusCode).toBe(400);
  });

  it.each(['{}', '{"repo":null}', '{"repo":1}', '{"repo":"  "}'])(
    'rejects missing or non-string repo in %s',
    async (body) => {
      const result = await reindexRepository(backendMock(), body, true);
      expect(result.statusCode).toBe(400);
    },
  );

  it('returns 404 for a repository name not served by this backend', async () => {
    const backend = backendMock();
    const result = await reindexRepository(backend, '{"repo":"other"}', true);
    expect(result.statusCode).toBe(404);
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it.each([
    ['force', false],
    ['dry_run', true],
  ])('rejects %s before refreshing the index', async (key, value) => {
    const backend = backendMock();
    const result = await reindexRepository(
      backend,
      JSON.stringify({ repo: 'GitNexus', [key]: value }),
      true,
    );
    expect(result.statusCode).toBe(400);
    expect(result.payload.error).toContain(key);
    expect(backend.callTool).not.toHaveBeenCalled();
  });

  it('maps already-running to 409 and backend failures to 500', async () => {
    const backend = backendMock();
    backend.callTool.mockResolvedValueOnce({ error: 'A refresh of GitNexus is already running.' });
    expect((await reindexRepository(backend, '{"repo":"GitNexus"}', true)).statusCode).toBe(409);

    backend.callTool.mockResolvedValueOnce({ error: 'worker failed' });
    expect((await reindexRepository(backend, '{"repo":"GitNexus"}', true)).statusCode).toBe(500);
  });

  it('maps unknown repo errors and keeps refresh_index out of the HTTP tool allowlist', () => {
    expect(reindexErrorStatus('Unknown repository')).toBe(404);
    expect(EVAL_SERVER_TOOLS.has('refresh_index')).toBe(false);
  });

  it('maps a refresh size-limit refusal to 422', () => {
    expect(
      reindexErrorStatus(
        "GitNexus has more than 5000 files in its working tree, over this server's refresh limit of 5000 (GITNEXUS_MCP_REFRESH_MAX_FILES). Run gitnexus analyze in the repository instead.",
      ),
    ).toBe(422);
  });

  it('requires the configured bearer token before dispatch', () => {
    const response = {
      setHeader: vi.fn(),
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    expect(rejectUnauthorizedRequest(undefined, 'secret', response)).toBe(true);
    expect(response.writeHead).toHaveBeenCalledWith(401);
    expect(response.end).toHaveBeenCalledWith(JSON.stringify({ error: 'Unauthorized' }));
    expect(rejectUnauthorizedRequest('Bearer secret', 'secret', response)).toBe(false);
  });

  it.each(['https://evil.example', 'null', 'http://127.0.0.1:3000'])(
    'rejects Origin %s before reading the body',
    async (origin) => {
      const { stream, req } = requestMock({ origin });
      const response = responseMock();
      const onAuthorized = vi.fn();
      const deps = requestDeps({ onAuthorized });

      await handleReindexRequest(req, response, deps);

      expect(responseStatus(response)).toBe(403);
      expect(response.end.mock.calls[0]?.[0]).toContain('Browser requests are not allowed');
      expect(deps.backend.listRepos).not.toHaveBeenCalled();
      expect(deps.backend.callTool).not.toHaveBeenCalled();
      expect(onAuthorized).not.toHaveBeenCalled();
      expect(stream.listenerCount('data')).toBe(0);
      expect(stream.readableFlowing).toBeNull();
    },
  );

  it('rejects loopback no-auth mode before reading the body', async () => {
    const { stream, req } = requestMock();
    const response = responseMock();
    const onAuthorized = vi.fn();
    const deps = requestDeps({ authToken: undefined, onAuthorized });

    await handleReindexRequest(req, response, deps);

    expect(responseStatus(response)).toBe(403);
    expect(response.end.mock.calls[0]?.[0]).toContain('GITNEXUS_AUTH_TOKEN');
    expect(deps.backend.listRepos).not.toHaveBeenCalled();
    expect(deps.backend.callTool).not.toHaveBeenCalled();
    expect(onAuthorized).not.toHaveBeenCalled();
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.readableFlowing).toBeNull();
  });

  it.each([undefined, 'Bearer wrong'])(
    'returns 401 for missing or incorrect auth header %s',
    async (authorization) => {
      const { req } = requestMock(authorization ? { authorization } : {});
      const response = responseMock();
      const onAuthorized = vi.fn();
      const deps = requestDeps({ onAuthorized });

      await handleReindexRequest(req, response, deps);

      expect(responseStatus(response)).toBe(401);
      expect(response.setHeader).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer');
      expect(deps.backend.callTool).not.toHaveBeenCalled();
      expect(onAuthorized).not.toHaveBeenCalled();
    },
  );

  it('accepts the intended authenticated client without Origin', async () => {
    const { stream, req } = requestMock({ authorization: 'Bearer secret' });
    const response = responseMock();
    const onAuthorized = vi.fn(() => expect(stream.listenerCount('data')).toBe(0));
    const deps = requestDeps({ onAuthorized });
    deps.backend.callTool.mockResolvedValue({
      status: 'refreshed',
      repo: 'GitNexus',
      durationMs: 123,
      indexedAt: 'now',
      lastCommit: 'abc123',
      staleness: { status: 'current' },
      stats: { files: 4 },
    });

    const pending = handleReindexRequest(req, response, deps);
    stream.end('{"repo":"GitNexus"}');
    await pending;

    expect(responseStatus(response)).toBe(200);
    expect(deps.backend.callTool).toHaveBeenCalledWith('refresh_index', { repo: 'GitNexus' });
    expect(onAuthorized).toHaveBeenCalledTimes(1);
  });

  it('resolves the refresh opt-in function per request', async () => {
    const { stream, req } = requestMock({ authorization: 'Bearer secret' });
    const response = responseMock();
    const deps = requestDeps({ refreshEnabled: vi.fn(() => true) });
    deps.backend.callTool.mockResolvedValue({
      status: 'refreshed',
      repo: 'GitNexus',
      durationMs: 123,
      indexedAt: 'now',
      lastCommit: 'abc123',
      staleness: { status: 'current' },
      stats: { files: 4 },
    });

    const pending = handleReindexRequest(req, response, deps);
    stream.end('{"repo":"GitNexus"}');
    await pending;

    expect(responseStatus(response)).toBe(200);
    expect(deps.backend.callTool).toHaveBeenCalledWith('refresh_index', { repo: 'GitNexus' });
  });

  it('returns a JSON error when resolving the opt-in function throws before reading the body', async () => {
    const { stream, req } = requestMock({ authorization: 'Bearer secret' });
    const response = responseMock();
    const deps = requestDeps({
      refreshEnabled: () => {
        throw new Error('bad GITNEXUS_MCP_ENABLE_REFRESH value');
      },
    });

    await handleReindexRequest(req, response, deps);

    expect(responseStatus(response)).toBe(500);
    expect(response.end.mock.calls[0]?.[0]).toContain('bad GITNEXUS_MCP_ENABLE_REFRESH value');
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.readableFlowing).toBeNull();
    expect(deps.backend.listRepos).not.toHaveBeenCalled();
    expect(deps.backend.callTool).not.toHaveBeenCalled();
    expect(deps.tracker.active).toBe(0);
  });

  it('checks the opt-in gate before attaching a body reader', async () => {
    const { stream, req } = requestMock({ authorization: 'Bearer secret' });
    const response = responseMock();
    const onAuthorized = vi.fn(() => expect(stream.listenerCount('data')).toBe(0));
    const deps = requestDeps({ refreshEnabled: false, onAuthorized });

    await handleReindexRequest(req, response, deps);

    expect(responseStatus(response)).toBe(403);
    expect(response.end.mock.calls[0]?.[0]).toContain('GITNEXUS_MCP_ENABLE_REFRESH=1');
    expect(deps.backend.listRepos).not.toHaveBeenCalled();
    expect(stream.listenerCount('data')).toBe(0);
    expect(stream.readableFlowing).toBeNull();
    expect(deps.tracker.active).toBe(0);
    expect(onAuthorized).toHaveBeenCalledTimes(1);
  });

  it('times out an incomplete body, destroys the stream, and leaves the tracker idle', async () => {
    const { stream, req } = requestMock({ authorization: 'Bearer secret' });
    const response = responseMock();
    const onAuthorized = vi.fn(() => expect(stream.listenerCount('data')).toBe(0));
    const deps = requestDeps({ bodyTimeoutMs: 15, onAuthorized });

    const pending = handleReindexRequest(req, response, deps);
    expect(deps.tracker.active).toBe(0);
    await pending;

    expect(responseStatus(response)).toBe(408);
    expect(stream.destroyed).toBe(true);
    expect(deps.tracker.active).toBe(0);
    expect(onAuthorized).toHaveBeenCalledTimes(1);
  });

  it('rejects an oversized body, destroys the stream, and leaves the tracker idle', async () => {
    const { stream, req } = requestMock({ authorization: 'Bearer secret' });
    const response = responseMock();
    const deps = requestDeps({ maxBodyBytes: 4 });

    const pending = handleReindexRequest(req, response, deps);
    stream.write('12345');
    await pending;

    expect(responseStatus(response)).toBe(413);
    expect(stream.destroyed).toBe(true);
    expect(deps.tracker.active).toBe(0);
  });

  it('tracks only the refresh call and decrements after success, result errors, and throws', async () => {
    const backend = backendMock();
    const tracker = createReindexInFlightTracker();
    let resolveRefresh!: (value: unknown) => void;
    backend.callTool.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );

    const success = reindexRepository(backend, '{"repo":"GitNexus"}', true, tracker);
    await vi.waitFor(() => expect(tracker.active).toBe(1));
    resolveRefresh({ status: 'refreshed', repo: 'GitNexus' });
    await success;
    expect(tracker.active).toBe(0);

    backend.callTool.mockResolvedValueOnce({ error: 'worker failed' });
    await reindexRepository(backend, '{"repo":"GitNexus"}', true, tracker);
    expect(tracker.active).toBe(0);

    backend.callTool.mockRejectedValueOnce(new Error('worker threw'));
    await expect(reindexRepository(backend, '{"repo":"GitNexus"}', true, tracker)).rejects.toThrow(
      'worker threw',
    );
    expect(tracker.active).toBe(0);

    const end = tracker.begin();
    end();
    end();
    expect(tracker.active).toBe(0);
  });
});
