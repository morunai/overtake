import type { Server } from 'node:http';

export function startTestServer(port?: number): Promise<Server>;
