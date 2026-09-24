import { render, screen } from '@testing-library/react';
import { http as mswHttp, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';

import { http } from '../src/data/http';

import { API } from './msw/handlers';
import { expectNoAxeViolations, server } from './setup';

describe('web test harness', () => {
  it('passes accessible markup and catches violations', async () => {
    const { container, unmount } = render(<button type="button">Send</button>);
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
    await expectNoAxeViolations(container);
    unmount();

    const broken = render(<button type="button" />);
    await expect(expectNoAxeViolations(broken.container)).rejects.toThrow(/button-name/);
  });

  it('serves API calls from MSW through the http mutator', async () => {
    server.use(mswHttp.get(`${API}/ping`, () => HttpResponse.json({ pong: true })));
    await expect(http('/ping')).resolves.toEqual({ pong: true });
    await expect(http('/unmocked')).rejects.toMatchObject({ status: 404, error: { code: 'NOT_FOUND' } });
  });
});
