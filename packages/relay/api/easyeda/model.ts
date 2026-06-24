import { handleEasyedaModel } from '../../src/index';
export const config = { runtime: 'edge' };
export default function handler(req: Request): Promise<Response> { return handleEasyedaModel(new URL(req.url)); }
