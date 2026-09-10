import worker from '../../src/index';
export const config = { runtime: 'edge' };
// Delegate to the Worker entry so OPTIONS preflight and method handling stay in one place.
export default function handler(req: Request): Promise<Response> { return worker.fetch(req, undefined); }
