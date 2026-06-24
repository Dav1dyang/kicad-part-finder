import { handleJlcpcbSearch } from '../../src/index';
export const config = { runtime: 'edge' };
export default function handler(req: Request): Promise<Response> { return handleJlcpcbSearch(new URL(req.url)); }
