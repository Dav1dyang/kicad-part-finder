// Vercel edge entry. All routing lives in the Worker handler.
import { handleRequest } from '../../src/index';

export const config = { runtime: 'edge' };
export default handleRequest;
